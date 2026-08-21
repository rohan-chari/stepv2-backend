#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2).replaceAll("-", "_");
    result[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
const output = path.resolve(args.output);
const samples = [];
let stopping = false;

function dockerStats() {
  try {
    const raw = execFileSync("limactl", ["shell", config.lima_instance, "--", "bash", "-lc", "docker stats --no-stream --format '{{json .}}'"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function sample() {
  let health = null;
  try {
    const response = await fetch(config.health_url || `${config.base_url}/health`);
    health = response.ok ? await response.json() : { status: response.status };
  } catch (error) {
    health = { error: error.message };
  }
  samples.push({ at: new Date().toISOString(), health, containers: dockerStats() });
}

async function finish() {
  await sample();
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const numeric = (values) => values.filter((value) => Number.isFinite(value));
  const cpu = (name) => numeric(samples.flatMap((s) => s.containers.filter((c) => c.Name === name).map((c) => Number.parseFloat(String(c.CPUPerc || "").replace("%", "")))));
  const memory = (name) => numeric(samples.flatMap((s) => s.containers.filter((c) => c.Name === name).map((c) => Number.parseFloat(String(c.MemUsage || "").split("/")[0]))));
  const pool = samples.map((s) => s.health?.capacity?.dbPool).filter(Boolean);
  const summary = {
    samples: samples.length,
    backend: { cpuPercent: cpu("step-capacity-backend"), memoryRaw: memory("step-capacity-backend") },
    database: { cpuPercent: cpu("step-capacity-postgres"), memoryRaw: memory("step-capacity-postgres") },
    redis: { cpuPercent: cpu("step-capacity-redis"), memoryRaw: memory("step-capacity-redis") },
    dbPool: {
      max: Math.max(0, ...pool.map((p) => Number(p.max) || 0)),
      peakTotal: Math.max(0, ...pool.map((p) => Number(p.total) || 0)),
      peakWaiting: Math.max(0, ...pool.map((p) => Number(p.waiting) || 0)),
      utilizationPercentPeak: Math.max(0, ...pool.map((p) => p.max ? (Number(p.total) / Number(p.max)) * 100 : 0)),
      waitMsAverage: pool.length ? pool.at(-1).waitMsAverage : 0,
      waitMsMax: Math.max(0, ...pool.map((p) => Number(p.waitMsMax) || 0)),
      waitCount: pool.length ? pool.at(-1).waitCount : 0,
    },
  };
  fs.writeFileSync(output, `${JSON.stringify({ schema: "capacity-metrics-v1", summary, samples }, null, 2)}\n`, { mode: 0o600 });
}

const timer = setInterval(() => { sample().catch(() => {}); }, 1000);
sample().catch(() => {});
process.once("SIGTERM", async () => { if (stopping) return; stopping = true; clearInterval(timer); await finish(); process.exit(0); });
process.once("SIGINT", async () => { if (stopping) return; stopping = true; clearInterval(timer); await finish(); process.exit(0); });
