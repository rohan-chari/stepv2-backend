#!/usr/bin/env node

// Local-capacity equivalent of the production PM2 cluster: two HTTP workers
// share one listening socket, each owns an independent selected-profile pool;
// resolution and cron run as separate processes, like production PM2.
const cluster = require("node:cluster");
const { fork } = require("node:child_process");
const path = require("node:path");

const workerCount = 2;
const backendEntry = path.resolve(__dirname, "capacity-process.js");
const BACKGROUND_NODE_EXEC_ARGV = Object.freeze([
  "--max-old-space-size=320",
  "--max-semi-space-size=8",
]);

function capacityPoolProfile(source = {}) {
  const profile = source.CAPACITY_DATABASE_POOL_PROFILE ?? source.database_pool_profile;
  if (!profile) throw new Error("database_pool_profile is required");
  if (!["legacy20", "role-budget"].includes(profile)) {
    throw new Error("database_pool_profile must be legacy20 or role-budget");
  }
  return profile;
}

function capacityPoolLimits(profile) {
  if (profile === "legacy20") return { http: "20", resolution: "20", cron: "20" };
  if (profile === "role-budget") return { http: "10", resolution: "8", cron: "4" };
  throw new Error("database_pool_profile must be legacy20 or role-budget");
}

function roleChildEnvironment(baseEnv, role, port, limits) {
  return {
    ...baseEnv,
    NODE_APP_INSTANCE: "0",
    STEPS_PROCESS_ROLE: role,
    PORT: port,
    HOST: "127.0.0.1",
    DB_POOL_MAX: limits[role],
  };
}

function main() {
const limits = capacityPoolLimits(capacityPoolProfile(process.env));
if (cluster.isPrimary) {
  const httpWorkers = new Map();
  let plannedHttpRestart = null;
  const forkHttpWorker = (instance) => {
    const worker = cluster.fork({
      NODE_APP_INSTANCE: String(instance),
      STEPS_PROCESS_ROLE: "http",
      PORT: "3000",
      DB_POOL_MAX: limits.http,
    });
    httpWorkers.set(String(instance), worker);
    return worker;
  };
  for (let instance = 0; instance < workerCount; instance += 1) forkHttpWorker(instance);

  const roleChildren = [
    ["resolution", "3010"],
    ["cron", "3011"],
  ].map(([role, port]) => fork(backendEntry, [], {
    env: roleChildEnvironment(process.env, role, port, limits),
    execArgv: BACKGROUND_NODE_EXEC_ARGV,
  }));

  let shuttingDown = false;
  const failIfRoleStops = (child, index) => child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(`capacity ${["resolution", "cron"][index]} process exited (${code ?? signal})\n`);
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
  roleChildren.forEach(failIfRoleStops);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers)) worker?.kill("SIGTERM");
    for (const child of roleChildren) child.kill("SIGTERM");
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Capacity-only worker-restart fault injection. `docker kill --signal=USR2`
  // replaces HTTP worker 0 under the same logical identity while worker 1
  // continues serving. Production topology/config is untouched.
  process.on("SIGUSR2", () => {
    if (shuttingDown || plannedHttpRestart) return;
    const worker = httpWorkers.get("0");
    if (!worker) return;
    plannedHttpRestart = { id: worker.id, instance: "0" };
    worker.kill("SIGTERM");
  });
  cluster.on("exit", (worker) => {
    if (shuttingDown) return;
    if (plannedHttpRestart?.id === worker.id) {
      const { instance } = plannedHttpRestart;
      plannedHttpRestart = null;
      forkHttpWorker(instance);
      return;
    }
    process.stderr.write(`capacity HTTP worker ${worker.id} exited unexpectedly\n`);
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
} else {
  require("./capacity-process").main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
}

if (require.main === module) main();

module.exports = {
  BACKGROUND_NODE_EXEC_ARGV,
  capacityPoolLimits,
  capacityPoolProfile,
  main,
  roleChildEnvironment,
  workerCount,
};
