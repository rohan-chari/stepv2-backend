const { prisma: defaultPrisma } = require('../../../db');
const { processDueEndMicroBatch, invalidateHomeActiveGlobalEvent } = require('../services/globalStepEventEntitlement');
const { rowLocalError } = require('./globalEventBoundaryDrain');

// A paced pass shares the cron process. These are permanent capacity budgets,
// not release flags. Due rows remain the durable queue when a pass stops.
function buildGlobalEventEndDrain(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const batchSize = Math.min(100, Math.max(1, dependencies.endBatchSize || 100));
  const budgetMs = Math.max(1, dependencies.endDrainBudgetMs || 2000);
  const maxAttempts = Math.max(1, dependencies.endDrainMaxAttempts || 8);
  const paceMs = Math.max(1, dependencies.endDrainPaceMs || 100);
  const logger = dependencies.logger || console;
  const processBatch = dependencies.processDueEndMicroBatch || processDueEndMicroBatch;
  let failureStreak = 0;
  const pending = []; // Retain bounded bisection progress between paced passes.
  function isRowFailure(error) {
    return rowLocalError(error) || rowLocalError(error?.cause) ||
      rowLocalError(error?.meta?.driverAdapterError?.cause) ||
      rowLocalError({code:error?.meta?.code});
  }
  async function run({ isStopped = () => false } = {}) {
    const started = Date.now();
    const result = { ends: 0, transactionAttempts: 0, failures: 0, more: false, retryAfterMs: 250 };
    const users = new Set();
    const mayRun = () => !isStopped() && Date.now()-started < budgetMs && result.transactionAttempts < maxAttempts;
    try {
      while (mayRun()) {
        const ids = pending.length ? pending.shift() : (await prisma.globalStepEventEntitlement.findMany({
          where: { endProcessedAt: null, endsAt: { lte: now() }, OR: [{ endNextAttemptAt: null }, { endNextAttemptAt: { lte: now() } }] },
          orderBy: [{ endsAt: 'asc' }, { id: 'asc' }], take: batchSize, select: { id: true },
        })).map(row => row.id);
        if (!ids.length) break;
        if (!mayRun()) { result.more = true; break; }
        result.transactionAttempts++;
        try {
          const rows = await processBatch({ prisma, ids, now: now(), bounded: true });
          result.ends += rows.length;
          for (const row of rows) users.add(row.userId);
          failureStreak = 0;
        } catch(error) {
          result.failures++;
          if (!isRowFailure(error)) {
            failureStreak++;
            result.more = true;
            result.retryAfterMs = Math.min(30000, 250 * 2 ** Math.min(7, failureStreak));
            logger.error?.('[GLOBAL_EVENT_END] transient batch rollback', { code: error?.code || error?.cause?.code || 'END_BATCH_FAILED' });
            break; // Never amplify contention into per-user transactions.
          }
          if (ids.length > 1) {
            const middle = Math.ceil(ids.length / 2);
            pending.unshift(ids.slice(0,middle), ids.slice(middle));
          } else {
            // Do not stamp completed or drop data: the durable retry survives
            // restart and permits healthy siblings to progress on the next pass.
            if (!mayRun()) { pending.unshift(ids); result.more = true; break; }
            result.transactionAttempts++;
            await prisma.$transaction(async tx => {
              await tx.$queryRawUnsafe("SELECT set_config('lock_timeout','100ms',true),set_config('statement_timeout','750ms',true)");
              await tx.$executeRawUnsafe(`UPDATE global_step_event_entitlements
              SET end_attempt_count=end_attempt_count+1,
                  end_next_attempt_at=$2::timestamp + interval '30 seconds', end_last_error_code=$3
              WHERE id=$1 AND end_processed_at IS NULL`, ids[0], now(), String(error?.code || error?.cause?.code || 'END_ROW_INVALID').slice(0,128));
            }, {timeout:1500,maxWait:100});
          }
        }
        // Always yield a positive amount; a cohort must not monopolize the pool.
        if (mayRun()) await new Promise(resolve => setTimeout(resolve, paceMs));
      }
      if (!result.more && !isStopped()) {
        result.more = Boolean(await prisma.globalStepEventEntitlement.findFirst({
          where: { endProcessedAt: null, endsAt: { lte: now() }, OR: [{ endNextAttemptAt: null }, { endNextAttemptAt: { lte: now() } }] }, select: { id: true },
        }));
      }
      return result;
    } catch(error) {
      failureStreak++;
      result.more=true;
      result.failures++;
      result.retryAfterMs=Math.min(30000,250*2**Math.min(7,failureStreak));
      logger.error?.('[GLOBAL_EVENT_END] pass deferred', {code:error?.code || 'END_PASS_FAILED'});
      return result;
    } finally { await invalidateHomeActiveGlobalEvent([...users]); }
  }
  return { run };
}
module.exports = { buildGlobalEventEndDrain };
