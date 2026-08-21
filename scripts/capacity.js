#!/usr/bin/env node

require("dotenv").config();

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const {
  destroy,
  preflight,
  restore,
  start,
  status,
  stop,
} = require("../src/modules/loadTesting/lifecycle");
const { manifestLines } = require("../src/modules/loadTesting/safety");

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
  return JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
}

function applyProvider(config) {
  if (config.provider !== "lima") return;
  const script = path.resolve(__dirname, "lima-capacity.js");
  const configPath = path.resolve(process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : "");
  if (!configPath) throw new Error("Lima provider requires --config");
  process.env.CAPACITY_RESTORE_HOOK = `node ${JSON.stringify(script)} restore --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_SCRUB_HOOK = `node ${JSON.stringify(script)} scrub --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_START_HOOK = `node ${JSON.stringify(script)} start --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_STOP_HOOK = `node ${JSON.stringify(script)} stop --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_DESTROY_HOOK = `node ${JSON.stringify(script)} destroy --config ${JSON.stringify(configPath)}`;
  process.env.CAPACITY_HEALTH_URL = config.health_url || `${config.base_url}/health`;
  process.env.CAPACITY_LIVE_MANIFEST_PATH = path.resolve(config.live_manifest || "");
  process.env.DATABASE_URL = config.database_url || "";
}

function validateSpecs(config, manifest) {
  if (!config.vps_specs && !config.database_specs) return;
  const vps = config.vps_specs || {};
  const database = config.database_specs || {};
  const expected = {
    vcpu: Number(vps.vcpu),
    ramMb: Number(vps.ram_gb) * 1024,
    diskGb: Number(vps.disk_gb),
    dbVcpu: Number(database.vcpu),
    dbRamMb: Number(database.ram_gb) * 1024,
    dbDiskGb: Number(database.disk_gib),
    dbConnections: Number(database.connection_limit),
  };
  const actual = {
    vcpu: Number(manifest.vps?.cpuCount),
    ramMb: Number(manifest.vps?.ramMb),
    diskGb: Number(manifest.vps?.disk?.sizeGb),
    dbVcpu: Number(manifest.database?.vcpu),
    dbRamMb: Number(manifest.database?.ramMb),
    dbDiskGb: Number(manifest.database?.disk?.sizeGb),
    dbConnections: Number(manifest.database?.maxConnections),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number.isFinite(value) && value > 0 && actual[key] !== value) throw new Error(`capacity config ${key} does not match the snapshot manifest (${value} expected, ${actual[key]} found)`);
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function confirmation() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("capacity start requires an interactive terminal; there is no --yes bypass");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question("Type the exact confirmation shown above: ", resolve));
  } finally {
    rl.close();
  }
}

async function main() {
  const [command] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const config = loadConfig(args);
  applyProvider(config);
  const value = (name, fallback) => args[name] ?? config[name] ?? fallback;
  const directory = value("directory", process.env.CAPACITY_STATE_DIR);
  let result;
  if (command === "preflight") {
    result = await preflight({ snapshotPath: required({ snapshot: value("snapshot") }, "snapshot"), profile: required({ profile: value("profile") }, "profile"), runId: value("run_id"), directory });
  } else if (command === "restore") {
    result = await restore({ runId: required({ run_id: value("run_id") }, "run_id"), snapshotPath: value("snapshot"), directory });
  } else if (command === "status") {
    result = status({ runId: required({ run_id: value("run_id") }, "run_id"), directory });
  } else if (command === "start") {
    const runId = required({ run_id: value("run_id") }, "run_id");
    let current;
    try {
      current = status({ runId, directory });
    } catch (error) {
      if (!value("snapshot")) throw error;
      await preflight({ snapshotPath: value("snapshot"), profile: required({ profile: value("profile") }, "profile"), runId, directory });
      await restore({ runId, snapshotPath: value("snapshot"), directory });
      current = status({ runId, directory });
    }
    validateSpecs(config, current.approvedManifest);
    for (const line of manifestLines(current.approvedManifest)) process.stdout.write(`${line}\n`);
    const input = await confirmation();
    result = await start({ runId, directory, input, interactive: true, output: process.stdout });
  } else if (command === "stop") {
    result = await stop({ runId: required({ run_id: value("run_id") }, "run_id"), directory });
  } else if (command === "destroy") {
    const runId = required({ run_id: value("run_id") }, "run_id");
    const current = status({ runId, directory });
    if (current.state === "started") await stop({ runId, directory });
    result = await destroy({ runId, directory });
  } else {
    throw new Error("usage: npm run capacity -- <start|status|stop|destroy> [options]");
  }
  print(result);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
