const crypto = require("node:crypto");
const { prisma } = require("../../../db");
const { RaceResolutionJobV2: Job } = require("./raceResolutionJobV2");
const redisCache = require("../../../shared/cache/redisCache");
// Independent keyset cursors bound rows examined even when every old failure
// already has a repair intent. The trigger owns new failures; this census only
// needs to finish traversing retained pre-migration history.
let taskCursor = "";
let receiptCursor = { raceId: "", generation: 0 };
async function censusSnapshotRepairs() {
  const tasks = await prisma.$queryRawUnsafe(
    `SELECT id,race_id,source_generation
    FROM race_resolution_post_tasks
    WHERE snapshot_state IN ('failed_no_retry','ambiguous_at_most_once') AND id>$1
    ORDER BY id LIMIT 100`,
    taskCursor,
  );
  const receipts = await prisma.$queryRawUnsafe(
    `SELECT 'receipt:'||race_id||':'||source_generation::text AS id,race_id,source_generation
    FROM race_resolution_post_task_receipts
    WHERE snapshot_state IN ('failed_no_retry','ambiguous_at_most_once')
      AND (race_id,source_generation)>($1,$2)
    ORDER BY race_id,source_generation LIMIT 100`,
    receiptCursor.raceId,
    receiptCursor.generation,
  );
  const candidates = [...tasks, ...receipts];
  let inserted = 0;
  if (candidates.length)
    inserted = await prisma.$executeRawUnsafe(
      `INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation)
    SELECT c.id,c.race_id,c.source_generation FROM jsonb_to_recordset($1::jsonb)
      AS c(id text,race_id text,source_generation integer) JOIN races r ON r.id=c.race_id
    WHERE NOT EXISTS(SELECT 1 FROM race_resolution_post_tasks t WHERE t.race_id=c.race_id AND t.source_generation>=c.source_generation AND t.snapshot_state='succeeded')
      AND NOT EXISTS(SELECT 1 FROM race_resolution_post_task_receipts t WHERE t.race_id=c.race_id AND t.source_generation>=c.source_generation AND t.snapshot_state='succeeded')
    ON CONFLICT DO NOTHING`,
      JSON.stringify(candidates),
    );
  // Advance only after durable insertion. A crash may revisit a bounded page;
  // primary-key dedupe makes that safe and no unseen row is acknowledged.
  taskCursor = tasks.length === 100 ? tasks.at(-1).id : "";
  receiptCursor =
    receipts.length === 100
      ? {
          raceId: receipts.at(-1).race_id,
          generation: receipts.at(-1).source_generation,
        }
      : { raceId: "", generation: 0 };
  return inserted;
}
async function drainSnapshotRepairs() {
  const lease = crypto.randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `WITH due AS (SELECT task_id FROM race_snapshot_repair_intents WHERE terminal_at IS NULL AND available_at<=(statement_timestamp() AT TIME ZONE 'UTC') AND (lease_expires_at IS NULL OR lease_expires_at<=(statement_timestamp() AT TIME ZONE 'UTC')) ORDER BY available_at,task_id LIMIT 100 FOR UPDATE SKIP LOCKED)
 UPDATE race_snapshot_repair_intents i SET lease_token=$1::uuid,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_count=attempt_count+1 FROM due WHERE i.task_id=due.task_id RETURNING i.*`,
    lease,
  );
  let repaired = 0;
  for (const row of rows) {
    try {
      // Live progress snapshots intentionally do not exist after a race ends.
      // A queued publication can finish after settlement/cancellation; treating
      // its missing snapshot as repairable creates an endless generation loop.
      // Drain historical/old-worker failures too, without changing active-race
      // publication recovery or replaying any scoring/notification work.
      const terminal = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM races WHERE id=$1 AND status IN ('completed','cancelled')`,
        row.race_id,
      );
      if (terminal.length) {
        await prisma.$executeRawUnsafe(
          `UPDATE race_snapshot_repair_intents SET terminal_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE task_id=$1 AND lease_token=$2::uuid`,
          row.task_id,
          lease,
        );
        repaired++;
        continue;
      }
      const success = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM race_resolution_post_tasks WHERE race_id=$1 AND source_generation >= $2 AND snapshot_state='succeeded' UNION ALL SELECT 1 FROM race_resolution_post_task_receipts WHERE race_id=$1 AND source_generation >= $2 AND snapshot_state='succeeded' LIMIT 1`,
        row.race_id,
        row.source_generation,
      );
      if (!success.length) {
        const covered =
          await require("./raceProgressRefreshIntent").admitExpiryRefresh({
            raceId: row.race_id,
          });
        // Busy read admission may retain only viewer intake (generation 0).
        // Race-wide publication requires an actual durable job identity.
        if (!covered?.id) {
          await prisma.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
              const locked = await Job.acquireForWrite(tx, {
                raceId: row.race_id,
              });
              await tx.$executeRawUnsafe(
                `UPDATE race_resolution_jobs_v2
                SET generation=GREATEST(generation,$2) WHERE race_id=$1`,
                row.race_id,
                row.source_generation + 1,
              );
              await Job.enqueue(
                {
                  raceId: row.race_id,
                  resolutionTimeZone:
                    locked.resolutionTimeZone ||
                    locked.processingTimeZone ||
                    null,
                  dirtyEnvelope: {
                    reason: "DISPLAY_REFRESH",
                    priority: "COALESCE",
                  },
                  queuePriority: "MAINTENANCE",
                },
                tx,
              );
              await tx.$executeRawUnsafe(
                `UPDATE race_resolution_jobs_v2
                SET not_before_at=LEAST(not_before_at,statement_timestamp() AT TIME ZONE 'UTC')
                WHERE race_id=$1`,
                row.race_id,
              );
            },
            { timeout: 5000 },
          );
        }
        await redisCache.publishDurableQueueWakeup("resolution", {
          workKind: "ordinary",
        });
      }
      await prisma.$executeRawUnsafe(
        `UPDATE race_snapshot_repair_intents SET terminal_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE task_id=$1 AND lease_token=$2::uuid`,
        row.task_id,
        lease,
      );
      repaired++;
    } catch (error) {
      await prisma.$executeRawUnsafe(
        `UPDATE race_snapshot_repair_intents SET available_at=clock_timestamp()+($3 * interval '1 second'),lease_token=NULL,lease_expires_at=NULL WHERE task_id=$1 AND lease_token=$2::uuid`,
        row.task_id,
        lease,
        Math.min(300, 2 ** Math.min(row.attempt_count, 8)),
      );
    }
  }
  return repaired;
}
module.exports = { censusSnapshotRepairs, drainSnapshotRepairs };
