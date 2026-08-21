#!/usr/bin/env node

// Local-capacity equivalent of the production PM2 cluster: two HTTP workers
// share one listening socket, each owns an independent 20-connection pool;
// resolution and cron run as separate processes, like production PM2.
const cluster = require("node:cluster");
const { fork } = require("node:child_process");
const path = require("node:path");

const workerCount = 2;
const backendEntry = path.resolve(__dirname, "../src/index.js");

if (cluster.isPrimary) {
  for (let instance = 0; instance < workerCount; instance += 1) {
    cluster.fork({
      NODE_APP_INSTANCE: String(instance),
      STEPS_PROCESS_ROLE: "http",
      PORT: "3000",
      DB_POOL_MAX: "20",
    });
  }

  const roleChildren = [
    ["resolution", "3010"],
    ["cron", "3011"],
  ].map(([role, port]) => fork(backendEntry, [], {
    env: {
      ...process.env,
      NODE_APP_INSTANCE: "",
      STEPS_PROCESS_ROLE: role,
      PORT: port,
      HOST: "127.0.0.1",
      DB_POOL_MAX: "20",
    },
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
  cluster.on("exit", (worker) => {
    if (shuttingDown) return;
    process.stderr.write(`capacity HTTP worker ${worker.id} exited unexpectedly\n`);
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
} else {
  const { startServer, installProductionShutdownHandlers } = require("../src/index");
  const server = startServer();
  installProductionShutdownHandlers({ server });
}
