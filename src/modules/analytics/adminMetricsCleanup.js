const { randomUUID } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../../db");

const TICK_MS = 5 * 60 * 1000;
const DEFINITIONS = {
  activity: {
    jobKey: "admin_metrics_activity_cleanup",
    table: "user_activity_days",
    cutoffColumn: "activity_date",
    retentionDays: 180,
  },
  push: {
    jobKey: "push_delivery_cleanup",
    table: "push_deliveries",
    cutoffColumn: "created_at",
    retentionDays: 30,
  },
  referral: {
    jobKey: "referral_link_open_cleanup",
    table: "link_opens",
    cutoffColumn: "created_at",
    retentionDays: 90,
  },
};

function etDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildFencedCleanup(definition, dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const owner = dependencies.owner || randomUUID();
  const batchSize = dependencies.batchSize || 500;
  const leaseMs = dependencies.leaseMs || 60_000;
  const env = dependencies.env || process.env;
  const logger = dependencies.logger || console;
  const afterLeaseRenew = dependencies.afterLeaseRenew;
  const afterDeleteBeforeCursor = dependencies.afterDeleteBeforeCursor;
  const afterBatch = dependencies.afterBatch;
  const table = Prisma.raw(`"${definition.table}"`);
  const cutoffColumn = Prisma.raw(`"${definition.cutoffColumn}"`);

  return async function cleanup() {
    if (env.ADMIN_METRICS_V2_CLEANUP_DISABLED === "true") {
      return { skipped: "disabled", deleted: 0 };
    }
    const current = now();
    const dayKey = etDay(current);
    const claimed = await prisma.$queryRaw`
      INSERT INTO analytics_cleanup_runs
        (id,job_key,day_key,state,fence,lease_owner,lease_expires_at,created_at,updated_at)
      VALUES (${randomUUID()},${definition.jobKey},CAST(${dayKey} AS date),'running',1,${owner},
        clock_timestamp() + (${leaseMs} * interval '1 millisecond'),clock_timestamp(),clock_timestamp())
      ON CONFLICT (job_key,day_key) DO UPDATE SET
        state='running', fence=analytics_cleanup_runs.fence+1,
        lease_owner=EXCLUDED.lease_owner, lease_expires_at=EXCLUDED.lease_expires_at,
        updated_at=EXCLUDED.updated_at
      WHERE analytics_cleanup_runs.state='running'
        AND analytics_cleanup_runs.lease_expires_at < clock_timestamp()
      RETURNING fence,cursor`;
    if (claimed.length === 0) return { skipped: "claimed", deleted: 0 };
    const fence = claimed[0].fence;
    let persistedDeleted = Number(claimed[0].cursor || 0);
    const cutoff = new Date(
      current.getTime() - definition.retentionDays * 86400000
    );
    let deleted = 0;
    while (true) {
      const renewed = await prisma.$queryRaw`
        UPDATE analytics_cleanup_runs
        SET lease_expires_at=clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
            updated_at=clock_timestamp()
        WHERE job_key=${definition.jobKey} AND day_key=CAST(${dayKey} AS date)
          AND state='running' AND lease_owner=${owner} AND fence=${fence}
          AND lease_expires_at >= clock_timestamp()
        RETURNING lease_expires_at`;
      if (renewed.length !== 1) return { skipped: "lease_lost", deleted };
      if (afterLeaseRenew) await afterLeaseRenew({ fence, owner, deleted });
      let count;
      try {
        count = await prisma.$transaction(async (tx) => {
          const removed = await tx.$queryRaw`
            WITH batch AS (
              SELECT ctid FROM ${table}
              WHERE ${cutoffColumn} < ${cutoff}
              ORDER BY ${cutoffColumn} LIMIT ${batchSize}
            ), deleted AS (
              DELETE FROM ${table} target USING batch
              WHERE target.ctid=batch.ctid AND EXISTS (
                SELECT 1 FROM analytics_cleanup_runs run
                WHERE run.job_key=${definition.jobKey} AND run.day_key=CAST(${dayKey} AS date)
                  AND run.state='running' AND run.lease_owner=${owner} AND run.fence=${fence}
                  AND run.lease_expires_at >= clock_timestamp()
              ) RETURNING 1
            ) SELECT COUNT(*)::bigint count FROM deleted`;
          const removedCount = Number(removed[0]?.count || 0);
          if (removedCount === 0) return 0;
          if (afterDeleteBeforeCursor) {
            await afterDeleteBeforeCursor({ fence, owner, deleted, removed: removedCount });
          }
          const nextCursor = persistedDeleted + removedCount;
          const advanced = await tx.$queryRaw`
            UPDATE analytics_cleanup_runs
            SET cursor=${String(nextCursor)}, updated_at=clock_timestamp()
            WHERE job_key=${definition.jobKey} AND day_key=CAST(${dayKey} AS date)
              AND state='running' AND lease_owner=${owner} AND fence=${fence}
              AND lease_expires_at >= clock_timestamp()
            RETURNING id`;
          if (advanced.length !== 1) throw new LeaseLostError();
          return removedCount;
        });
      } catch (error) {
        if (error instanceof LeaseLostError) {
          return { skipped: "lease_lost", deleted };
        }
        throw error;
      }
      if (count === 0) break;
      deleted += count;
      persistedDeleted += count;
      if (afterBatch) await afterBatch({ fence, owner, deleted, removed: count });
    }
    const completed = await prisma.$queryRaw`
      UPDATE analytics_cleanup_runs
      SET state='complete',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE job_key=${definition.jobKey} AND day_key=CAST(${dayKey} AS date)
        AND state='running' AND lease_owner=${owner} AND fence=${fence}
        AND lease_expires_at >= clock_timestamp()
      RETURNING id`;
    if (completed.length !== 1) return { skipped: "lease_lost", deleted };
    logger.log(`[CRON] ${definition.jobKey}: deleted ${deleted} rows before ${cutoff.toISOString()}`);
    return { deleted };
  };
}

class LeaseLostError extends Error {}

const buildAdminMetricsActivityCleanup = (d) => buildFencedCleanup(DEFINITIONS.activity, d);
const buildPushDeliveryCleanup = (d) => buildFencedCleanup(DEFINITIONS.push, d);
const buildReferralLinkOpenCleanup = (d) => buildFencedCleanup(DEFINITIONS.referral, d);

function schedule(builder, label, dependencies = {}) {
  const run = builder(dependencies);
  const logger = dependencies.logger || console;
  async function tick() {
    try { await run(); } catch (error) { logger.error(`[CRON] ${label} tick failed:`, error); }
  }
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_MS);
  interval.unref?.();
  return interval;
}
const scheduleAdminMetricsActivityCleanup = (d) => schedule(buildAdminMetricsActivityCleanup,"adminMetricsActivityCleanup",d);
const schedulePushDeliveryCleanup = (d) => schedule(buildPushDeliveryCleanup,"pushDeliveryCleanup",d);
const scheduleReferralLinkOpenCleanup = (d) => schedule(buildReferralLinkOpenCleanup,"referralLinkOpenCleanup",d);

module.exports = {
  buildAdminMetricsActivityCleanup,
  buildPushDeliveryCleanup,
  buildReferralLinkOpenCleanup,
  scheduleAdminMetricsActivityCleanup,
  schedulePushDeliveryCleanup,
  scheduleReferralLinkOpenCleanup,
};
