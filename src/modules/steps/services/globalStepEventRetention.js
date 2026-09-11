const { prisma: defaultPrisma } = require('../../../db');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1000;
function lifecycleCandidateSql() {
  return `SELECT e.id,e.event_id,e.user_id FROM global_step_event_entitlements e
    WHERE e.ends_at<$1 AND e.start_processed_at IS NOT NULL AND e.end_processed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM global_event_race_impacts i JOIN races r ON r.id=i.race_id
        WHERE i.event_id=e.event_id AND i.user_id=e.user_id AND r.status='active')
    ORDER BY e.ends_at,e.id LIMIT $2 FOR UPDATE OF e SKIP LOCKED`;
}
async function cleanupExpiredEntitlements({ client = defaultPrisma, now = new Date(), batchSize = RETENTION_BATCH_SIZE } = {}) {
  const cutoff = new Date(new Date(now).getTime() - RETENTION_MS);
  const limit = Math.min(RETENTION_BATCH_SIZE, Math.max(1, Number(batchSize) || RETENTION_BATCH_SIZE));
  return client.$transaction(async tx => {
    const candidates = await tx.$queryRawUnsafe(lifecycleCandidateSql(), cutoff, limit);
    const ids = candidates.map(row => row.id);
    const pairs = candidates.map(row => ({ eventId: row.event_id, userId: row.user_id }));
    let deletedSummaries = 0, deletedImpacts = 0, deletedEntitlements = 0;
    if (ids.length) {
      await require('./eventDisplayCacheInvalidation').entitlementsChanged(candidates.map(row => row.user_id));
      // Durable schema-completion evidence, not a rollout toggle. Preserve the
      // copy only until B's audit finishes; later batches use ordinary retention.
      const finalDrop = await tx.jobRun.findUnique({
        where: { jobName: 'simple_event_recap:drop:v1' }, select: { jobName: true },
      });
      deletedSummaries = (await tx.eventRecap.deleteMany({ where: {
        OR: pairs, ...(finalDrop ? {} : { calculationVersion: { not: 'LEGACY_SAVED' } }),
      } })).count;
      deletedImpacts = (await tx.globalEventRaceImpact.deleteMany({ where: { OR: pairs } })).count;
      deletedEntitlements = (await tx.globalStepEventEntitlement.deleteMany({ where: { id: { in: ids } } })).count;
    }
    const [row = {}] = await tx.$queryRawUnsafe(`SELECT COUNT(*) AS blocked FROM global_step_event_entitlements
      WHERE ends_at<$1 AND start_processed_at IS NOT NULL AND end_processed_at IS NOT NULL`, cutoff);
    const remainingOld = Number(row.blocked || 0);
    return { deletedEntitlements, deletedImpacts, deletedSummaries, blockedEntitlements: remainingOld, healthy: remainingOld === 0 };
  });
}
module.exports = { RETENTION_MS, RETENTION_BATCH_SIZE, lifecycleCandidateSql, cleanupExpiredEntitlements };
