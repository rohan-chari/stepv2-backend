const { prisma: defaultPrisma } = require("../../../db");
const {
  discoverDueStartIds,
  processDueStartMicroBatch,
  invalidateHomeActiveGlobalEvent,
} = require("../services/globalStepEventEntitlement");

const MAX_TRANSACTION_ATTEMPTS = 255;

function rowLocalError(error) {
  const code = String(error?.code || "");
  return code === "GLOBAL_EVENT_ROW_INVALID" || code === "P2000" || code === "P2003" ||
    code === "P2004" || code === "23502" || code === "23503" || code === "23514" ||
    code.startsWith("22");
}

function startRetryAt(now, attempt, random = Math.random) {
  const cap = Math.min(30_000, 250 * (2 ** Math.max(0, attempt - 1)));
  return new Date(now.getTime() + Math.floor(Math.max(0, Math.min(1, random())) * cap));
}

function buildGlobalEventBoundaryDrain(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const random = dependencies.random || Math.random;
  const logger = dependencies.logger || console;
  const batchSize = Math.min(100, Math.max(1, Number(dependencies.batchSize) || 100));

  async function recordSingletonFailure(id, error) {
    const current = now();
    await prisma.$transaction(async (tx) => {
      const row = await tx.globalStepEventEntitlement.findUnique({ where: { id } });
      if (!row || row.startProcessedAt) return;
      const attempts = row.startAttemptCount + 1;
      const terminal = attempts >= 8 || new Date(row.endsAt) <= current;
      await tx.globalStepEventEntitlement.updateMany({
        where: { id, startProcessedAt: null },
        data: terminal ? {
          startAttemptCount: attempts,
          startLastErrorCode: String(error?.code || "GLOBAL_EVENT_ROW_INVALID").slice(0, 128),
          startFailedAt: current,
          startProcessedAt: current,
          startOutcome: "FAILED_TERMINAL",
          startNextAttemptAt: null,
        } : {
          startAttemptCount: attempts,
          startLastErrorCode: String(error?.code || "GLOBAL_EVENT_ROW_INVALID").slice(0, 128),
          startNextAttemptAt: startRetryAt(current, attempts, random),
        },
      });
    });
  }

  async function runUntilIdle() {
    const totals = { starts: 0, stale: 0, failures: 0, bisections: 0, transactionAttempts: 0 };
    const transitioned = new Set();
    async function process(ids, depth = 0) {
      if (!ids.length || totals.transactionAttempts >= MAX_TRANSACTION_ATTEMPTS) return;
      totals.transactionAttempts += 1;
      try {
        const result = await processDueStartMicroBatch({ prisma, ids, now: now() });
        totals.starts += result.starts;
        totals.stale += result.stale;
        for (const userId of result.transitionedUserIds || []) transitioned.add(userId);
      } catch (error) {
        if (error?.code === "GLOBAL_EVENT_LOCK_SET_CHANGED") throw error;
        if (!rowLocalError(error)) throw error;
        if (ids.length === 1 || depth >= 7) {
          totals.failures += 1;
          await recordSingletonFailure(ids[0], error);
          return;
        }
        totals.bisections += 1;
        const middle = Math.ceil(ids.length / 2);
        await process(ids.slice(0, middle), depth + 1);
        await process(ids.slice(middle), depth + 1);
      }
    }
    while (totals.transactionAttempts < MAX_TRANSACTION_ATTEMPTS) {
      const candidates = await discoverDueStartIds({ prisma, now: now(), batchSize });
      if (!candidates.length) break;
      await process(candidates.map((row) => row.id));
      await new Promise((resolve) => setImmediate(resolve));
      if (candidates.length < batchSize) {
        const remaining = await discoverDueStartIds({ prisma, now: now(), batchSize: 1 });
        if (!remaining.length) break;
      }
    }
    await invalidateHomeActiveGlobalEvent([...transitioned]);
    return totals;
  }

  return { runUntilIdle };
}

function scheduleGlobalEventBoundaryDrain(dependencies = {}) {
  const worker = dependencies.worker || buildGlobalEventBoundaryDrain(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  let running = null;
  let timer = null;
  const tick = () => {
    if (stopped || running) return running;
    running = worker.runUntilIdle()
      .catch((error) => logger.error?.("[GLOBAL_EVENT_BOUNDARY] drain failed", { errorCode: error?.code || "DRAIN_FAILED" }))
      .finally(() => { running = null; });
    return running;
  };
  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => { await tick(); arm(1_000); }, delay);
    timer.unref?.();
  };
  tick();
  arm(dependencies.recoveryIntervalMs || 1_000);
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

module.exports = {
  MAX_TRANSACTION_ATTEMPTS,
  rowLocalError,
  startRetryAt,
  buildGlobalEventBoundaryDrain,
  scheduleGlobalEventBoundaryDrain,
};
