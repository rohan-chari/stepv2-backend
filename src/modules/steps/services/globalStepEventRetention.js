const { prisma: defaultPrisma } = require("../../../db");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 1000;

function lifecycleCandidateSql() {
  return `
    SELECT e.id, e.event_id, e.user_id
      FROM global_step_event_entitlements e
     WHERE e.ends_at < $1
       AND e.start_processed_at IS NOT NULL
       AND e.end_processed_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM global_event_race_impacts i
          WHERE i.event_id = e.event_id AND i.user_id = e.user_id
            AND i.status <> 'FINAL'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM global_event_race_impacts i
           JOIN races r ON r.id = i.race_id
          WHERE i.event_id = e.event_id AND i.user_id = e.user_id
            AND r.status = 'active'::"RaceStatus"
       )
       AND (
         EXISTS (
           SELECT 1 FROM global_event_user_summaries s
            WHERE s.event_id = e.event_id AND s.user_id = e.user_id
              AND (s.acknowledged_at IS NOT NULL OR s.settled_at < $1)
         )
         OR (
           NOT EXISTS (
             SELECT 1 FROM global_event_user_summaries s
              WHERE s.event_id = e.event_id AND s.user_id = e.user_id
           )
           AND (
             NOT EXISTS (
               SELECT 1 FROM global_event_race_impacts i
                WHERE i.event_id = e.event_id AND i.user_id = e.user_id
             )
             OR EXISTS (
               SELECT 1 FROM job_runs j
                WHERE j.job_name = 'global_event_summary:' || e.event_id || ':' || e.user_id || ':v1'
             )
           )
         )
       )
     ORDER BY e.ends_at ASC, e.id ASC
     LIMIT $2
     FOR UPDATE OF e SKIP LOCKED
  `;
}

async function cleanupExpiredEntitlements({
  client = defaultPrisma,
  now = new Date(),
  batchSize = RETENTION_BATCH_SIZE,
} = {}) {
  const cutoff = new Date(new Date(now).getTime() - RETENTION_MS);
  const limit = Math.min(RETENTION_BATCH_SIZE, Math.max(1, Number(batchSize) || RETENTION_BATCH_SIZE));
  return client.$transaction(async (tx) => {
    const candidates = await tx.$queryRawUnsafe(lifecycleCandidateSql(), cutoff, limit);
    const ids = candidates.map((row) => row.id);
    const pairs = candidates.map((row) => ({ eventId: row.event_id, userId: row.user_id }));
    const jobNames = pairs.map(({ eventId, userId }) =>
      `global_event_summary:${eventId}:${userId}:v1`
    );
    let deletedSummaries = 0;
    let deletedImpacts = 0;
    let deletedEntitlements = 0;
    if (pairs.length > 0) {
      deletedSummaries = (await tx.globalEventUserSummary.deleteMany({
        where: { OR: pairs },
      })).count;
      deletedImpacts = (await tx.globalEventRaceImpact.deleteMany({
        where: { OR: pairs },
      })).count;
      if (jobNames.length > 0 && tx.jobRun) {
        await tx.jobRun.deleteMany({ where: { jobName: { in: jobNames } } });
      }
      deletedEntitlements = (await tx.globalStepEventEntitlement.deleteMany({
        where: { id: { in: ids } },
      })).count;
    }
    const [row = {}] = await tx.$queryRawUnsafe(`
      SELECT COUNT(*) AS blocked
        FROM global_step_event_entitlements e
       WHERE e.ends_at < $1
         AND e.start_processed_at IS NOT NULL
         AND e.end_processed_at IS NOT NULL
    `, cutoff);
    const remainingOld = Number(row.blocked || 0);
    return {
      deletedEntitlements,
      deletedImpacts,
      deletedSummaries,
      blockedEntitlements: Math.max(0, remainingOld),
      healthy: remainingOld === 0,
    };
  });
}

module.exports = {
  RETENTION_MS,
  RETENTION_BATCH_SIZE,
  lifecycleCandidateSql,
  cleanupExpiredEntitlements,
};
