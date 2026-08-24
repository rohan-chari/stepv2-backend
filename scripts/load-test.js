#!/usr/bin/env node

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { parseLoadParameters } = require("../src/modules/loadTesting/contract");
const { runLoad } = require("../src/modules/loadTesting/runner");
const { preflight: capacityPreflight } = require("../src/modules/loadTesting/lifecycle");
const { destroy: destroyCapacity, stop: stopCapacity } = require("../src/modules/loadTesting/lifecycle");
let prisma;
let metricsProcess;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    result[key] = !next || next.startsWith("--") ? true : argv[++index];
  }
  return result;
}

function required(args, name) {
  if (!args[name]) throw new Error(`--${name.replaceAll("_", "-")} is required`);
  return args[name];
}

function loadConfig(args) {
  if (!args.config) return {};
  const file = path.resolve(args.config);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function applyProvider(config, configPathValue) {
  if (config.provider !== "lima") return;
  const script = path.resolve(__dirname, "lima-capacity.js");
  const configPath = path.resolve(configPathValue || "");
  process.env.CAPACITY_RESTORE_HOOK = `node ${JSON.stringify(script)} restore --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_SCRUB_HOOK = `node ${JSON.stringify(script)} scrub --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_START_HOOK = `node ${JSON.stringify(script)} start --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_STOP_HOOK = `node ${JSON.stringify(script)} stop --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_DESTROY_HOOK = `node ${JSON.stringify(script)} destroy --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_HEALTH_URL = config.health_url || `${config.base_url}/health`;
  process.env.CAPACITY_LIVE_MANIFEST_PATH = path.resolve(config.live_manifest || "");
  process.env.CAPACITY_MODE = "true";
  process.env.CAPACITY_OUTBOUND_DISABLED = "true";
  process.env.CAPACITY_RUN_ID = config.run_id;
  process.env.CAPACITY_DB_NAME = config.db_name || "steps_tracker_capacity";
  process.env.CAPACITY_DB_HOST_ALLOWLIST = "127.0.0.1";
  process.env.CAPACITY_REDIS_ENABLED = "true";
  process.env.SESSION_TOKEN_SECRET = process.env.CAPACITY_AUTH_SECRET || "";
  const user = encodeURIComponent(config.db_user || "capacity");
  if (process.env.CAPACITY_DB_PASSWORD) {
    const password = encodeURIComponent(process.env.CAPACITY_DB_PASSWORD);
    process.env.DATABASE_URL = `postgresql://${user}:${password}@127.0.0.1:${config.db_host_port || 55433}/${config.db_name || "steps_tracker_capacity"}`;
  }
}

function limaTelemetryReader(config) {
  if (config.provider !== "lima") return null;
  const instance = String(config.lima_instance || "");
  const container = String(config.backend_container || "step-capacity-backend");
  if (!/^[a-zA-Z0-9._-]+$/.test(instance) || !/^[a-zA-Z0-9._-]+$/.test(container)) {
    throw new Error("capacity telemetry requires safe Lima instance/container names");
  }
  return async ({ startedAt }) => {
    const raw = execFileSync("limactl", [
      "shell", instance, "--", "docker", "logs", "--since", startedAt,
      container,
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  };
}

async function main() {
  const [command] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const config = loadConfig(args);
  const argsConfigPath = args.config;
  applyProvider(config, args.config);
  prisma = require("../src/db").prisma;
  const value = (name, fallback) => args[name] ?? config[name] ?? fallback;
  const outputDir = value("output_dir") ? path.resolve(value("output_dir")) : path.resolve("results");
  const metricsPath = path.join(outputDir, `${value("run_id")}.metrics.json`);
  if (config.provider === "lima" && command === "run" && args.dry_run !== true) {
    metricsProcess = spawn(process.execPath, [path.resolve(__dirname, "capacity-metrics.js"), "--config", path.resolve(args.config), "--output", metricsPath], { stdio: "ignore", env: process.env });
  }
  if (command === "preflight") {
    const params = parseLoadParameters({
      profile: value("profile"),
      users: args.users,
      arrivalRate: args.arrival_rate,
      duration: args.duration,
      timeoutMs: args.timeout_ms,
      concurrency: args.concurrency,
    });
    const capacity = await capacityPreflight({
      snapshotPath: required({ snapshot: value("snapshot") }, "snapshot"),
      profile: params.profile,
      target: args.target || "capacity-vm",
      runId: value("run_id"),
      directory: value("capacity_state_dir", config.directory || process.env.CAPACITY_STATE_DIR),
    });
    process.stdout.write(`${JSON.stringify({ command, target: capacity.target, profile: params.profile, parameters: params, capacity }, null, 2)}\n`);
    return;
  }
  if (command === "report") {
    const report = JSON.parse(fs.readFileSync(path.resolve(required(args, "input")), "utf8"));
    process.stdout.write([
      `run=${report.runId} target=${report.target} profile=${report.profile}`,
      `requests=${report.summary.requests} throughput=${Number(report.summary.throughputPerSecond).toFixed(2)}/s errorRate=${(report.summary.errorRate * 100).toFixed(2)}%`,
      `latency p50/p95/p99=${report.summary.latencyMs.p50}/${report.summary.latencyMs.p95}/${report.summary.latencyMs.p99}ms stop=${report.summary.stopReason}`,
    ].join("\n") + "\n");
    return;
  }
  if (command !== "run") throw new Error("usage: npm run load-test -- <preflight|run|report> [options]");
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result;
  try {
  result = await runLoad({
    target: value("target", "capacity-vm"),
    baseUrl: required({ base_url: value("base_url") }, "base_url"),
    databaseUrl: args.dry_run === true ? undefined : process.env.DATABASE_URL,
    profile: value("profile"),
    users: value("users"),
    arrivalRate: value("arrival_rate"),
    duration: value("duration"),
    timeoutMs: value("timeout_ms"),
    concurrency: value("concurrency"),
    runId: value("run_id"),
    capacityRepeat: value("repeat", "1"),
    capacityStateDirectory: value("capacity_state_dir", config.directory || process.env.CAPACITY_STATE_DIR),
    confirmCapacityVm: args.confirm_capacity_vm === true || args.dry_run !== true,
    dryRun: args.dry_run === true,
    prisma,
    outputDir,
    signal: controller.signal,
    readCapacityTelemetry: limaTelemetryReader(config),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (metricsProcess) {
      metricsProcess.kill("SIGTERM");
      metricsProcess = undefined;
    }
    if (controller.signal.aborted && value("run_id") && value("capacity_state_dir", process.env.CAPACITY_STATE_DIR)) {
      const lifecycleArgs = { runId: value("run_id"), directory: value("capacity_state_dir", process.env.CAPACITY_STATE_DIR) };
      try { await stopCapacity(lifecycleArgs); } catch (error) { process.stderr.write(`capacity stop after interruption failed: ${error.message}\n`); }
      try { await destroyCapacity(lifecycleArgs); } catch (error) { process.stderr.write(`capacity destroy after interruption failed: ${error.message}\n`); }
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect().catch(() => {});
});
