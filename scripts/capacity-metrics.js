#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Pool } = require("pg");

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2).replaceAll("-", "_");
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function roleUrls(config) {
  const base = new URL(config.base_url);
  const atPort = (port) => {
    const value = new URL(base);
    value.port = String(port);
    value.pathname = "/health";
    value.search = "";
    return value.toString();
  };
  return { http: atPort(3000), resolution: atPort(3010), cron: atPort(3011) };
}

async function dockerStats(config) {
  try {
    const { stdout: raw } = await execFileAsync("limactl", ["shell", config.lima_instance, "--", "docker", "stats", "--no-stream", "--format", "{{json .}}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000,
    });
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function fetchHealth(url) {
  try {
    // A fresh connection lets the HTTP health census observe both cluster
    // workers instead of remaining pinned to one keep-alive socket.
    const response = await fetch(url, { headers: { Connection: "close" }, redirect: "manual",
      signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() : { status: response.status };
  } catch (error) {
    return { error: error.message };
  }
}

async function fetchHttpCensus(url, { fetchOne = fetchHealth, maximumAttempts = 20 } = {}) {
  const byIdentity = new Map();
  for (let attempt = 0; attempt < maximumAttempts && byIdentity.size < 2; attempt += 2) {
    const healthRows = await Promise.all([fetchOne(url), fetchOne(url)]);
    for (const health of healthRows) {
      const capacity = health?.capacity;
      if (capacity?.process?.role === "http" && [0, 1].includes(Number(capacity.process.instance))) byIdentity.set(`http:${Number(capacity.process.instance)}`, health);
    }
  }
  if (!byIdentity.has("http:0") || !byIdentity.has("http:1")) {
    throw new Error("capacity HTTP health census did not observe both worker identities");
  }
  return { http: byIdentity.get("http:0"), httpPeer: byIdentity.get("http:1") };
}

function writeImmutable(file, value) {
  if (fs.existsSync(file)) throw new Error(`capacity metrics artifact already exists: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(temporary, file);
  } finally {
    fs.unlinkSync(temporary);
  }
}

function createCollector({
  config,
  output,
  databaseUrl = process.env.DATABASE_URL,
  provenance = {
    runId: process.env.CAPACITY_RUN_ID,
    profile: process.env.CAPACITY_GLOBAL_EVENT_PROFILE,
    repeat: process.env.CAPACITY_REPEAT,
  },
} = {}) {
  const urls = roleUrls(config);
  const samples = [];
  const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 2_000, statement_timeout: 3_000, query_timeout: 3_000 }) : null;
  let timer = null;
  let stopping = false;
  let phase = "warmup";
  const inFlight = new Set();

  async function databaseSample() {
    if (!pool) return { lockWaitMs: [], resolutionQueueLagMs: Number.NaN,
      resolutionQueueDepth: Number.NaN };
    try {
      const [locks, queue] = await Promise.all([
        pool.query(`SELECT extract(epoch FROM (clock_timestamp()-query_start))*1000 AS ms
          FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'`),
        pool.query(`SELECT coalesce(max(extract(epoch FROM (clock_timestamp()-updated_at))*1000),0) AS ms,
          count(*)::int AS depth
          FROM race_resolution_jobs_v2 WHERE state IN ('queued','running')`),
      ]);
      return {
        lockWaitMs: locks.rows.map((row) => Number(row.ms)).filter(Number.isFinite),
        resolutionQueueLagMs: Number(queue.rows[0]?.ms || 0),
        resolutionQueueDepth: Number(queue.rows[0]?.depth || 0),
      };
    } catch (error) {
      return { lockWaitMs: [], resolutionQueueLagMs: Number.NaN,
        resolutionQueueDepth: Number.NaN, databaseError: error.message };
    }
  }

  async function sample() {
    const samplePhase = phase;
    const [httpResult, resolutionResult, cronResult, databaseResult, containersResult] = await Promise.allSettled([
      fetchHttpCensus(urls.http, { maximumAttempts: 2 }), fetchHealth(urls.resolution), fetchHealth(urls.cron),
      databaseSample(), dockerStats(config),
    ]);
    const httpCensus = httpResult.status === "fulfilled" ? httpResult.value : { error: httpResult.reason?.message || "http census unavailable" };
    const resolution = resolutionResult.status === "fulfilled" ? resolutionResult.value : { error: resolutionResult.reason?.message || "resolution health unavailable" };
    const cron = cronResult.status === "fulfilled" ? cronResult.value : { error: cronResult.reason?.message || "cron health unavailable" };
    const database = databaseResult.status === "fulfilled" ? databaseResult.value : { error: databaseResult.reason?.message || "database metrics unavailable" };
    const containers = containersResult.status === "fulfilled" ? containersResult.value : [];
    samples.push({
      at: new Date().toISOString(), phase: samplePhase, health: { ...httpCensus, resolution, cron },
      containers, ...database,
    });
  }

  function scheduleSample() {
    if (stopping) return;
    const pending = sample().catch(() => {}).finally(() => inFlight.delete(pending));
    inFlight.add(pending);
  }

  async function finish() {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    await Promise.allSettled([...inFlight]);
    await sample();
    if (pool) await pool.end();
    writeImmutable(output, {
      schema: "capacity-metrics-v2",
      runId: provenance.runId,
      profile: provenance.profile,
      repeat: Number(provenance.repeat),
      samples,
    });
  }

  function setPhase(nextPhase) { if (!["warmup", "measured", "drain"].includes(nextPhase)) throw new Error(`invalid metrics phase: ${nextPhase}`); phase = nextPhase; }
  function start(initialPhase = "warmup") {
    if (timer) return;
    if (fs.existsSync(output)) throw new Error(`capacity metrics artifact already exists: ${output}`);
    setPhase(initialPhase);
    timer = setInterval(scheduleSample, 1_000);
    scheduleSample();
  }
  return { finish, sample, samples, start, setPhase };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
  const collector = createCollector({ config, output: path.resolve(args.output) });
  collector.start();
  const stop = async () => { await collector.finish(); process.exit(0); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { createCollector, fetchHttpCensus, roleUrls, writeImmutable };
