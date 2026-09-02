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
const ROLE_BY_NAME = Object.freeze({
  "steps-tracker": "http",
  "steps-tracker-resolution": "resolution",
  "steps-tracker-cron": "cron",
});
const VARIABLE_BY_ROLE = Object.freeze({
  http: "DATABASE_POOL_MAX_HTTP",
  resolution: "DATABASE_POOL_MAX_RESOLUTION",
  cron: "DATABASE_POOL_MAX_CRON",
});
const LEGACY_POOL_MAX = 20;
const BASELINE_SCHEMA = "database-pool-live-baseline-v1";
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

function parsePoolInteger(value, variable) {
  if (typeof value !== "string" || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) {
    throw new Error(`${variable} must be a canonical base-10 integer from 1 through 50`);
  }
  return Number(value);
}

function productionApps(apps) {
  return apps.filter(({ name }) => Object.hasOwn(EXPECTED, name));
}

function validateStaticPoolBudget(apps) {
  if (!Array.isArray(apps)) throw new Error("PM2 ecosystem apps must be an array");
  const unexpectedProduction = apps.filter((entry) => (
    entry.cwd === PROD_DIR && !Object.hasOwn(EXPECTED, entry.name)
  ));
  if (unexpectedProduction.length > 0) {
    throw new Error(`Unexpected production process definition ${unexpectedProduction[0].name}`);
  }
  const production = productionApps(apps);
  const roleTotals = { http: 0, resolution: 0, cron: 0 };
  const targets = {};
  const targetSources = {};
  const seenBudgets = new Set();
  const configuredRoles = [];
  let productionProcesses = 0;
  for (const [name, expectedInstances] of Object.entries(EXPECTED)) {
    const matches = production.filter((entry) => entry.name === name);
    if (matches.length !== 1) throw new Error(`${name} must appear exactly once in the ecosystem config`);
    const entry = matches[0];
    if (entry.cwd !== PROD_DIR) {
      throw new Error(`${name} must use reviewed cwd ${PROD_DIR}`);
    }
    if (entry.script !== PROD_SCRIPT) {
      throw new Error(`${name} must use reviewed script ${PROD_SCRIPT}`);
    }
    if (entry.instances !== expectedInstances) {
      throw new Error(`${name} must define exactly ${expectedInstances} instance(s)`);
    }
    const role = ROLE_BY_NAME[name];
    const variable = VARIABLE_BY_ROLE[role];
    if (entry.env?.STEPS_PROCESS_ROLE !== role) {
      throw new Error(`${name} must set STEPS_PROCESS_ROLE=${role}`);
    }
    const hasRoleValue = Object.hasOwn(entry.env || {}, variable);
    const hasTotal = Object.hasOwn(entry.env || {}, "DATABASE_POOL_TOTAL_BUDGET");
    configuredRoles.push({ name, role, variable, hasRoleValue, hasTotal });
    const value = hasRoleValue
      ? parsePoolInteger(entry.env[variable], variable)
      : LEGACY_POOL_MAX;
    targets[role] = value;
    targetSources[role] = hasRoleValue ? variable : "compatibility-default";
    if (hasTotal) {
      seenBudgets.add(parsePoolInteger(
        entry.env.DATABASE_POOL_TOTAL_BUDGET,
        "DATABASE_POOL_TOTAL_BUDGET",
      ));
    }
    roleTotals[role] += entry.instances * value;
    productionProcesses += entry.instances;
  }
  if (production.length !== Object.keys(EXPECTED).length) {
    throw new Error("Production ecosystem contains an unexpected process definition");
  }
  const fullyLegacy = configuredRoles.every(({ hasRoleValue, hasTotal }) => !hasRoleValue && !hasTotal);
  const fullyRoleBudgeted = configuredRoles.every(({ hasRoleValue, hasTotal }) => hasRoleValue && hasTotal);
  if (!fullyLegacy && !fullyRoleBudgeted) {
    const first = configuredRoles.find(({ hasRoleValue, hasTotal }) => hasRoleValue !== hasTotal)
      || configuredRoles.find(({ hasRoleValue, hasTotal }) => hasRoleValue || hasTotal);
    throw new Error(`Production pool configuration is partial at ${first?.name || "an unknown role"}: ${first?.variable || "role variable"}`);
  }
  if (fullyRoleBudgeted && seenBudgets.size !== 1) {
    throw new Error("DATABASE_POOL_TOTAL_BUDGET must match for every production role");
  }
  const aggregate = Object.values(roleTotals).reduce((sum, value) => sum + value, 0);
  const totalBudget = fullyLegacy ? aggregate : [...seenBudgets][0];
  if (aggregate !== totalBudget) {
    throw new Error(`Production database pool aggregate ${aggregate} does not equal DATABASE_POOL_TOTAL_BUDGET=${totalBudget}`);
  }

  const staging = apps.find(({ name }) => name === "steps-tracker-staging");
  if (!staging || staging.instances !== 1 || staging.autostart !== false ||
      staging.env?.STEPS_PROCESS_ROLE !== "staging_all") {
    throw new Error("Stopped staging must remain one explicit staging_all process");
  }
  parsePoolInteger(staging.env?.DATABASE_POOL_MAX_ALL, "DATABASE_POOL_MAX_ALL");

  return {
    roleTotals,
    targets,
    targetSources,
    stage: fullyLegacy ? "legacy-20" : "role-budget",
    aggregate,
    totalBudget,
    productionProcesses,
  };
}

function liveIdentity(entry) {
  const role = ROLE_BY_NAME[entry.name];
  const instance = entry.environment?.NODE_APP_INSTANCE;
  if (typeof instance !== "string" || !/^\d+$/.test(instance)) {
    throw new Error(`${entry.name} PID ${entry.pid} has no canonical NODE_APP_INSTANCE`);
  }
  return `${role}:${instance}`;
}

function resolvedLivePool(entry) {
  const role = ROLE_BY_NAME[entry.name];
  const variable = VARIABLE_BY_ROLE[role];
  const environment = entry.environment || {};
  if (environment.STEPS_PROCESS_ROLE !== role) {
    throw new Error(`${entry.name} PID ${entry.pid} must set STEPS_PROCESS_ROLE=${role}`);
  }
  if (!Object.hasOwn(environment, variable)) {
    return { max: LEGACY_POOL_MAX, source: "compatibility-default" };
  }
  return { max: parsePoolInteger(environment[variable], variable), source: variable };
}

function exactLiveProduction(pm2) {
  const unexpected = pm2.filter((entry) => (
    entry.status === "online" && entry.cwd === PROD_DIR && !Object.hasOwn(EXPECTED, entry.name)
  ));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected live production process ${unexpected[0].name}`);
  }
  const production = pm2.filter((entry) => (
    entry.status === "online" && entry.cwd === PROD_DIR && Object.hasOwn(EXPECTED, entry.name)
  ));
  for (const [name, expectedCount] of Object.entries(EXPECTED)) {
    const entries = production.filter((entry) => entry.name === name);
    if (entries.length !== expectedCount) {
      throw new Error(`${name} must have ${expectedCount} live process(es), found ${entries.length}`);
    }
  }
  const identities = production.map(liveIdentity);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Live production process identities must be unique");
  }
  const expectedIdentities = ["http:0", "http:1", "resolution:0", "cron:0"].sort();
  if (identities.slice().sort().join(",") !== expectedIdentities.join(",")) {
    throw new Error(`Live production identities must be ${expectedIdentities.join(",")}`);
  }
  return production;
}

function captureLivePoolBaseline(pm2) {
  const processes = {};
  for (const entry of exactLiveProduction(pm2)) {
    const identity = liveIdentity(entry);
    const resolved = resolvedLivePool(entry);
    processes[identity] = { ...resolved };
  }
  return { schema: BASELINE_SCHEMA, processes };
}

function validateBaseline(baseline) {
  if (!baseline || baseline.schema !== BASELINE_SCHEMA || !baseline.processes) {
    throw new Error(`Pool baseline must use ${BASELINE_SCHEMA}`);
  }
  const expected = ["http:0", "http:1", "resolution:0", "cron:0"];
  if (Object.keys(baseline.processes).sort().join(",") !== expected.sort().join(",")) {
    throw new Error("Pool baseline must contain the exact production process identities");
  }
  for (const identity of expected) {
    const entry = baseline.processes[identity];
    if (!Number.isInteger(entry?.max) || entry.max < 1 || entry.max > 50 ||
        !["compatibility-default", VARIABLE_BY_ROLE[identity.split(":")[0]]].includes(entry?.source)) {
      throw new Error(`Pool baseline ${identity} is invalid`);
    }
  }
  return baseline;
}

function validateTransitionOrder(transitionedRoles) {
  const joined = transitionedRoles.join(",");
  if (!["resolution", "resolution,cron", "resolution,cron,http"].includes(joined)) {
    throw new Error("Transitioned roles must follow resolution, then cron, then http");
  }
}

function validateLivePoolBudget(pm2, { mode, transitionedRoles = [], apps, baseline } = {}) {
  if (!["transition", "final"].includes(mode)) {
    throw new Error("Live pool budget mode must be transition or final");
  }
  const source = validateStaticPoolBudget(apps || require("../ecosystem.config").apps);
  if (mode === "transition") {
    validateTransitionOrder(transitionedRoles);
    validateBaseline(baseline);
  }
  const transitioned = new Set(mode === "final" ? Object.keys(source.targets) : transitionedRoles);
  const production = exactLiveProduction(pm2);
  let aggregate = 0;
  for (const name of Object.keys(EXPECTED)) {
    const entries = production.filter((entry) => entry.name === name);
    const role = ROLE_BY_NAME[name];
    const variable = VARIABLE_BY_ROLE[role];
    for (const entry of entries) {
      const environment = entry.environment || {};
      const identity = liveIdentity(entry);
      const resolved = resolvedLivePool(entry);

      if (transitioned.has(role)) {
        if (resolved.max !== source.targets[role] || resolved.source !== source.targetSources[role]) {
          throw new Error(`${role} PID ${entry.pid} must resolve ${source.targets[role]} from ${variable}`);
        }
        if (source.stage === "role-budget") {
          const liveTotal = parsePoolInteger(
            environment.DATABASE_POOL_TOTAL_BUDGET,
            "DATABASE_POOL_TOTAL_BUDGET",
          );
          if (liveTotal !== source.totalBudget) {
            throw new Error(`DATABASE_POOL_TOTAL_BUDGET differs from ecosystem source for ${name} PID ${entry.pid}`);
          }
        } else if (Object.hasOwn(environment, "DATABASE_POOL_TOTAL_BUDGET")) {
          throw new Error(`DATABASE_POOL_TOTAL_BUDGET must be absent from legacy target ${identity}`);
        }
      } else {
        const expected = baseline.processes[identity];
        if (resolved.max !== expected.max || resolved.source !== expected.source) {
          throw new Error(`${identity} differs from captured baseline`);
        }
      }
      aggregate += resolved.max;
    }
  }
  if (production.length !== source.productionProcesses) {
    throw new Error("Live production pool validation found an unexpected process");
  }
  if (mode === "final" && aggregate !== source.totalBudget) {
    throw new Error(`Live database pool aggregate ${aggregate} does not equal ${source.totalBudget}`);
  }
  return { mode, aggregate, totalBudget: source.totalBudget };
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
  return JSON.parse(output).map((entry) => {
    const environment = {};
    for (const variable of [
      "NODE_APP_INSTANCE",
      "STEPS_PROCESS_ROLE",
      "DATABASE_POOL_MAX_HTTP",
      "DATABASE_POOL_MAX_RESOLUTION",
      "DATABASE_POOL_MAX_CRON",
      "DATABASE_POOL_TOTAL_BUDGET",
    ]) {
      if (entry.pm2_env && Object.hasOwn(entry.pm2_env, variable)) {
        environment[variable] = String(entry.pm2_env[variable]);
      }
    }
    return {
      pid: entry.pid,
      pmId: entry.pm_id,
      name: entry.name,
      status: entry.pm2_env?.status,
      cwd: entry.pm2_env?.pm_cwd,
      memoryBytes: entry.monit?.memory || 0,
      maxMemoryRestartBytes: entry.pm2_env?.max_memory_restart,
      role: environment.STEPS_PROCESS_ROLE,
      environment,
    };
  });
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

  const poolModeArg = process.argv.find((arg) => arg.startsWith("--pool-budget-mode="));
  const poolMode = poolModeArg?.split("=")[1];
  const baselineFileArg = process.argv.find((arg) => arg.startsWith("--baseline-file="));
  const baselineFile = baselineFileArg?.slice("--baseline-file=".length);
  if (poolMode === "static") {
    const result = validateStaticPoolBudget(require("../ecosystem.config").apps);
    console.log(`PM2 static database pool budget: ${JSON.stringify(result)}`);
    return;
  }

  const firstSnapshot = snapshot();
  const firstResult = classifyTopology(firstSnapshot);
  printResult(firstResult);

  if (!firstResult.healthy && !remediate) {
    process.exitCode = 1;
    return;
  }

  if (poolMode === "baseline") {
    if (!baselineFile) throw new Error("--baseline-file is required for baseline mode");
    if (!firstResult.healthy) throw new Error("Cannot capture a pool baseline from unhealthy topology");
    const baseline = captureLivePoolBaseline(firstSnapshot.pm2);
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`PM2 live database pool baseline captured at ${baselineFile}`);
    return;
  }

  if (poolMode === "transition" || poolMode === "final") {
    const rolesArg = process.argv.find((arg) => arg.startsWith("--transitioned-roles="));
    const transitionedRoles = rolesArg
      ? rolesArg.split("=")[1].split(",").filter(Boolean)
      : [];
    if (!baselineFile) throw new Error("--baseline-file is required for live pool validation");
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    const result = validateLivePoolBudget(firstSnapshot.pm2, {
      mode: poolMode,
      transitionedRoles,
      baseline,
    });
    console.log(`PM2 live database pool budget: ${JSON.stringify(result)}`);
    if (!remediate) return;
  } else if (poolMode) {
    throw new Error("--pool-budget-mode must be static, baseline, transition, or final");
  }

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
  captureLivePoolBaseline,
  classifyTopology,
  intersectPersistentOrphans,
  isProductionNodeProcess,
  isSameProcess,
  selectOverMemoryHttpWorkers,
  validateLivePoolBudget,
  validateStaticPoolBudget,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
