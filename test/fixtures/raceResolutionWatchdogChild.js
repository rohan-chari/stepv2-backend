const { prisma } = require("../../src/db");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  RacePlacementTransitionJob,
} = require("../../src/modules/races/models/racePlacementTransitionJob");
const {
  createOperationalAlertSpool,
} = require("../../src/shared/operationalAlerts/operationalAlertSpool");

async function main() {
  const raceId = process.argv[2];
  const spoolDirectory = process.argv[3];
  const spool = createOperationalAlertSpool({ directory: spoolDirectory });
  const emit = (event) => process.stderr.write(`${JSON.stringify(event)}\n`);

  // The production transaction is intentionally capped at 15 seconds. This
  // fixture lengthens only Prisma's test timeout so the shipped 60-second
  // watchdog, rather than Prisma, wins the race. The worker still owns and
  // executes its real transaction callback, fence, participant/box writes,
  // recordSuccess, and placement handoff in their production order.
  const workerPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property === "$transaction") {
        return (operation, options) => target.$transaction(
          operation,
          { ...(options || {}), timeout: 120_000 }
        );
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const worker = buildRaceResolutionWorkerV2({
    prisma: workerPrisma,
    bootAt: 0,
    processRole: "resolution",
    nodeEnv: "test",
    operationalAlertSpool: spool,
    writeAlertMarker: (marker) => spool.writeIncident(marker),
    emitLiveDiagnostic: emit,
    logger: {
      log(value) { process.stderr.write(`${String(value)}\n`); },
      error(value) { process.stderr.write(`${String(value)}\n`); },
      warn(value) { process.stderr.write(`${String(value)}\n`); },
    },
    RacePlacementTransitionJob: {
      ...RacePlacementTransitionJob,
      async enqueueCurrentGeneration(input, tx) {
        await RacePlacementTransitionJob.enqueueCurrentGeneration(input, tx);
        process.stdout.write("worker-transaction-stalled\n");
        await new Promise(() => {});
      },
    },
  });

  const keepAlive = setInterval(() => {}, 1_000);
  await worker.processRace({ raceId });
  clearInterval(keepAlive);
  throw new Error("watchdog fixture unexpectedly returned");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
