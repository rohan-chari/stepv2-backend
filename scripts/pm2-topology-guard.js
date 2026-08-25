#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const PROD_DIR = "/var/www/step-tracker-backend";
const PROD_SCRIPT = `${PROD_DIR}/src/index.js`;
const EXPECTED = Object.freeze({
  "steps-tracker": 2,
  "steps-tracker-resolution": 1,
  "steps-tracker-cron": 1,
});
const HTTP_MEMORY_CEILING_BYTES = 1200 * 1024 * 1024;
const PM2_HTTP_MEMORY_SENTINEL_BYTES = 100 * 1024 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProductionNodeProcess(processInfo, daemonPid) {
  return processInfo
    && (!daemonPid || processInfo.ppid === daemonPid)
    && processInfo.cwd === PROD_DIR
    && path.basename(processInfo.executable || "") === "node"
    && Array.isArray(processInfo.argv)
    && (processInfo.pmExecPath === PROD_SCRIPT
      || processInfo.argv.includes(PROD_SCRIPT)
      || processInfo.argv.includes(`node ${PROD_SCRIPT}`));
}

function isSameProcess(expected, current) {
  return Boolean(expected && current
    && expected.pid === current.pid
    && expected.startTimeTicks === current.startTimeTicks);
}

function intersectPersistentOrphans(initial, later) {
  return later.filter((candidate) => initial.some((entry) => isSameProcess(entry, candidate)));
}

function classifyTopology({ pm2, processes, daemonPid }) {
  const registered = pm2.filter((entry) => (
    entry.status === "online"
    && entry.cwd === PROD_DIR
    && Object.hasOwn(EXPECTED, entry.name)
  ));
  const registeredPids = new Set(registered.map(({ pid }) => pid));
  const productionChildren = processes.filter((entry) => (
    isProductionNodeProcess(entry, daemonPid)
  ));
  const osPids = new Set(productionChildren.map(({ pid }) => pid));
  const counts = Object.fromEntries(Object.keys(EXPECTED).map((name) => [
    name,
    registered.filter((entry) => entry.name === name).length,
  ]));
  const countErrors = Object.entries(EXPECTED)
    .filter(([name, expected]) => counts[name] !== expected)
    .map(([name, expected]) => ({ name, expected, actual: counts[name] }));
  const orphans = productionChildren.filter(({ pid }) => !registeredPids.has(pid));
  const missing = registered.filter(({ pid }) => !osPids.has(pid));

  return {
    healthy: countErrors.length === 0 && orphans.length === 0 && missing.length === 0,
    counts,
    countErrors,
    orphans,
    missing,
  };
}

function selectOverMemoryHttpWorkers(pm2, ceilingBytes = HTTP_MEMORY_CEILING_BYTES) {
  return pm2
    .filter((entry) => (
      entry.name === "steps-tracker"
      && entry.status === "online"
      && entry.cwd === PROD_DIR
      && entry.memoryBytes > ceilingBytes
    ))
    .sort((a, b) => b.memoryBytes - a.memoryBytes);
}

function readProcProcess(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    const fieldsAfterName = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const environment = fs.readFileSync(`/proc/${pid}/environ`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const pmExecPath = environment
      .find((entry) => entry.startsWith("pm_exec_path="))
      ?.slice("pm_exec_path=".length);
    return {
      pid,
      ppid,
      cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
      executable: fs.readlinkSync(`/proc/${pid}/exe`),
      argv,
      pmExecPath,
      // /proc/<pid>/stat field 22 identifies this lifetime of a PID.
      startTimeTicks: Number(fieldsAfterName[19]),
    };
  } catch {
    return null;
  }
}

function readProcesses() {
  return fs.readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => readProcProcess(Number(entry.name)))
    .filter(Boolean);
}

function readPm2() {
  const output = execFileSync("pm2", ["jlist"], { encoding: "utf8" });
  return JSON.parse(output).map((entry) => ({
    pid: entry.pid,
    pmId: entry.pm_id,
    name: entry.name,
    status: entry.pm2_env?.status,
    cwd: entry.pm2_env?.pm_cwd,
    memoryBytes: entry.monit?.memory || 0,
    maxMemoryRestartBytes: entry.pm2_env?.max_memory_restart,
  }));
}

function findDaemonPid(pm2, processes) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const parentCounts = new Map();
  for (const entry of pm2) {
    const ppid = byPid.get(entry.pid)?.ppid;
    if (ppid) parentCounts.set(ppid, (parentCounts.get(ppid) || 0) + 1);
  }
  return [...parentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function snapshot() {
  const pm2 = readPm2();
  const processes = readProcesses();
  const daemonPid = findDaemonPid(pm2, processes);
  if (!daemonPid) throw new Error("Could not identify the PM2 daemon from registered workers");
  return { pm2, processes, daemonPid };
}

function printResult(result) {
  console.log(`PM2 topology: ${JSON.stringify(result.counts)}`);
  for (const error of result.countErrors) {
    console.error(`Count mismatch for ${error.name}: expected ${error.expected}, found ${error.actual}`);
  }
  for (const entry of result.missing) {
    console.error(`Registered worker PID ${entry.pid} (${entry.name}) is absent from /proc`);
  }
  for (const entry of result.orphans) {
    console.error(`Unregistered production worker PID ${entry.pid} (PPID ${entry.ppid})`);
  }
}

async function terminatePersistentOrphans(initialResult, stabilizeMs) {
  if (initialResult.orphans.length === 0) return;

  console.error(`Waiting ${stabilizeMs}ms before rechecking possible reload transients...`);
  await sleep(stabilizeMs);
  const second = snapshot();
  const persistent = intersectPersistentOrphans(
    initialResult.orphans,
    classifyTopology(second).orphans,
  );
  for (const entry of persistent) {
    // Re-read immediately before signaling so a recycled PID cannot be targeted.
    const current = readProcProcess(entry.pid);
    if (!current) {
      console.error(`Orphan PID ${entry.pid} exited before remediation`);
      continue;
    }
    const currentlyUnregistered = classifyTopology(snapshot()).orphans
      .some((candidate) => isSameProcess(entry, candidate));
    if (!isSameProcess(entry, current)
        || !isProductionNodeProcess(current, second.daemonPid)
        || !currentlyUnregistered) {
      throw new Error(`Refusing to signal PID ${entry.pid}: identity changed during validation`);
    }
    console.error(`Sending SIGTERM to persistent orphan PID ${entry.pid}`);
    process.kill(entry.pid, "SIGTERM");
  }

  if (persistent.length > 0) await sleep(12000);
  for (const entry of persistent) {
    const current = readProcProcess(entry.pid);
    if (!current) continue;
    const currentlyUnregistered = classifyTopology(snapshot()).orphans
      .some((candidate) => isSameProcess(entry, candidate));
    if (isSameProcess(entry, current)
        && isProductionNodeProcess(current, second.daemonPid)
        && currentlyUnregistered) {
      console.error(`PID ${entry.pid} ignored SIGTERM; sending SIGKILL`);
      process.kill(entry.pid, "SIGKILL");
    }
  }
}

async function restartOverMemoryWorkers(pm2) {
  for (const worker of selectOverMemoryHttpWorkers(pm2)) {
    const memoryMb = Math.round(worker.memoryBytes / 1024 / 1024);
    console.error(`HTTP PID ${worker.pid} is ${memoryMb} MB; restarting PM2 id ${worker.pmId}`);
    // Restart one instance at a time. Unlike PM2's cluster memory watchdog,
    // this does not overlap two reloads that share the same `_old_<id>` slot.
    execFileSync("pm2", ["restart", String(worker.pmId)], { stdio: "inherit" });
    await sleep(3000);
    const result = classifyTopology(snapshot());
    printResult(result);
    if (!result.healthy) throw new Error("Topology became unhealthy after memory restart");
  }
}

async function main() {
  const remediate = process.argv.includes("--remediate");
  const verifyLiveConfig = process.argv.includes("--verify-live-config");
  const skipMemory = process.argv.includes("--skip-memory");
  const stabilizeArg = process.argv.find((arg) => arg.startsWith("--stabilize-ms="));
  const stabilizeMs = stabilizeArg ? Number(stabilizeArg.split("=")[1]) : 30000;
  if (!Number.isFinite(stabilizeMs) || stabilizeMs < 10000) {
    throw new Error("--stabilize-ms must be at least 10000");
  }

  const firstSnapshot = snapshot();
  const firstResult = classifyTopology(firstSnapshot);
  printResult(firstResult);

  if (!remediate) {
    process.exitCode = firstResult.healthy ? 0 : 1;
    return;
  }

  await terminatePersistentOrphans(firstResult, stabilizeMs);
  const afterCleanup = snapshot();
  const cleanupResult = classifyTopology(afterCleanup);
  printResult(cleanupResult);
  if (!cleanupResult.healthy) throw new Error("Production PM2 topology is still unhealthy");

  if (verifyLiveConfig) {
    const misconfigured = afterCleanup.pm2.filter((entry) => (
      entry.name === "steps-tracker"
      && entry.status === "online"
      && entry.cwd === PROD_DIR
      && entry.maxMemoryRestartBytes !== PM2_HTTP_MEMORY_SENTINEL_BYTES
    ));
    if (misconfigured.length > 0) {
      throw new Error("Live HTTP workers do not have the 100G PM2 memory sentinel");
    }
  }

  if (!skipMemory) await restartOverMemoryWorkers(afterCleanup.pm2);
}

module.exports = {
  classifyTopology,
  intersectPersistentOrphans,
  isProductionNodeProcess,
  isSameProcess,
  selectOverMemoryHttpWorkers,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
