const { raceTimeZone } = require("../raceTimeZone");
const { prisma: defaultPrisma } = require("../../../db");
const { RaceResolutionJobV2: defaultJob } = require("./raceResolutionJobV2");

function isBusyRaceJobError(error) {
  return (
    ["55P03", "40P01"].includes(error?.meta?.code) ||
    /55P03|40P01|canceling statement due to lock timeout|deadlock detected/.test(
      String(error?.message || ""),
    )
  );
}
function buildRaceEffectDeadlineModel({
  prisma = defaultPrisma,
  RaceResolutionJobV2 = defaultJob,
} = {}) {
  let recoveryCursor = { at: null, raceId: "" };
  return {
    async health() {
      const [row] = await prisma.$queryRawUnsafe(`SELECT
        (SELECT deadline_at FROM race_effect_deadlines WHERE dispatched_revision IS NULL ORDER BY deadline_at,race_id,effect_id LIMIT 1) AS pending,
        (SELECT dispatched_at FROM race_effect_deadlines WHERE dispatched_revision IS NOT NULL ORDER BY dispatched_at,race_id LIMIT 1) AS dispatched`);
      return row;
    },
    async backfill({ limit = 100, afterId = "" } = {}) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `SELECT id FROM race_active_effects WHERE id>$1 AND status='active_effect' AND expires_at IS NOT NULL ORDER BY id LIMIT $2 FOR UPDATE`,
          afterId,
          Math.min(100, limit),
        );
        if (rows.length)
          await tx.$executeRawUnsafe(
            `INSERT INTO race_effect_deadlines(effect_id,race_id,deadline_at) SELECT id,race_id,expires_at FROM race_active_effects WHERE id=ANY($1::text[]) AND status='active_effect' AND expires_at IS NOT NULL ON CONFLICT DO NOTHING`,
            rows.map((r) => r.id),
          );
        return { count: rows.length, afterId: rows.at(-1)?.id || afterId };
      });
    },
    async due({ limit = 100, afterRaceIds = [] } = {}) {
      return prisma.$queryRawUnsafe(
        `SELECT effect_id,race_id FROM race_effect_deadlines WHERE dispatched_revision IS NULL AND deadline_at<=(statement_timestamp() AT TIME ZONE 'UTC') AND NOT(race_id=ANY($2::text[])) ORDER BY deadline_at,race_id,effect_id LIMIT $1`,
        Math.min(100, limit),
        afterRaceIds,
      );
    },
    async dispatchRace(raceId, tx = null) {
      const dispatch = async (db) => {
        await db.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
        await RaceResolutionJobV2.acquireForWrite(db, { raceId });
        const effects = await db.$queryRawUnsafe(
          `SELECT d.effect_id,d.revision,d.deadline_at,e.type,e.target_user_id,e.target_participant_id,r.timezone,creator.timezone AS creator_timezone
      FROM race_effect_deadlines d JOIN race_active_effects e ON e.id=d.effect_id JOIN races r ON r.id=d.race_id LEFT JOIN users creator ON creator.id=r.creator_id
      WHERE d.race_id=$1 AND d.dispatched_revision IS NULL AND d.deadline_at<=(statement_timestamp() AT TIME ZONE 'UTC')
      AND e.status='active_effect' AND e.expires_at=d.deadline_at AND r.status='active'
      ORDER BY d.deadline_at,d.effect_id LIMIT 100 FOR UPDATE OF d SKIP LOCKED`,
          raceId,
        );
        if (!effects.length) return null;
        const job = await RaceResolutionJobV2.enqueue(
          {
            raceId,
            triggeredUserIds: [
              ...new Set(effects.map((e) => e.target_user_id)),
            ],
            resolutionTimeZone: raceTimeZone(
              effects[0],
              effects[0].creator_timezone || "UTC",
            ),
            bypassDebounce: true,
            queuePriority: "LIVE",
            dirtyEnvelope: {
              reason: "EFFECT_BOUNDARY",
              priority: "IMMEDIATE",
              dirtyUserIds: [...new Set(effects.map((e) => e.target_user_id))],
              dirtyParticipantIds: [
                ...new Set(effects.map((e) => e.target_participant_id)),
              ],
              powerupTypes: [
                ...new Set(effects.map((e) => String(e.type).toUpperCase())),
              ],
            },
          },
          db,
        );
        await db.$executeRawUnsafe(
          `UPDATE race_effect_deadlines SET dispatched_revision=revision,dispatched_generation=$2,dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE effect_id=ANY($1::text[])`,
          effects.map((e) => e.effect_id),
          job.generation,
        );
        return { job, effects };
      };
      return tx
        ? dispatch(tx)
        : prisma.$transaction(dispatch, { timeout: 5000 });
    },
    async recover({ limit = 100 } = {}) {
      // A durable job/post-task may legitimately remain pending for multiple
      // passes. A keyset cursor moves past inspected rows regardless of repair
      // eligibility, so one race cannot monopolize the recovery head.
      const cap = Math.min(100, limit);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT d.effect_id,d.race_id,d.dispatched_at FROM race_effect_deadlines d
         WHERE d.dispatched_revision IS NOT NULL
           AND d.dispatched_at<(statement_timestamp() AT TIME ZONE 'UTC')-interval '30 seconds'
           AND ($2::timestamp IS NULL OR (d.dispatched_at,d.race_id)>($2::timestamp,$3))
         ORDER BY d.dispatched_at,d.race_id LIMIT $1`,
        cap,
        recoveryCursor.at,
        recoveryCursor.raceId,
      );
      recoveryCursor =
        rows.length === cap
          ? { at: rows.at(-1).dispatched_at, raceId: rows.at(-1).race_id }
          : { at: null, raceId: "" };
      let repaired = 0;
      for (const raceId of [...new Set(rows.map((r) => r.race_id))]) {
        await prisma
          .$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
            const job = await RaceResolutionJobV2.acquireForWrite(tx, {
              raceId,
            });
            if (!["FAILED", "SUCCEEDED"].includes(job?.state)) return;
            // A pending/leased post task still owns consequence convergence.
            const pending = await tx.$queryRawUnsafe(
              `SELECT 1 FROM race_resolution_post_tasks WHERE race_id=$1 AND state IN ('queued','running') LIMIT 1`,
              raceId,
            );
            if (pending.length) return;
            repaired += await tx.$executeRawUnsafe(
              `UPDATE race_effect_deadlines SET dispatched_revision=NULL,dispatched_generation=NULL,dispatched_at=NULL WHERE race_id=$1 AND effect_id=ANY($2::text[]) AND dispatched_at<(statement_timestamp() AT TIME ZONE 'UTC')-interval '30 seconds'`,
              raceId,
              rows
                .filter((row) => row.race_id === raceId)
                .map((row) => row.effect_id),
            );
          })
          .catch((error) => {
            if (!isBusyRaceJobError(error)) throw error;
          });
      }
      // Ended races are owned by settlement, and never occupy the due head.
      await prisma.$executeRawUnsafe(
        `DELETE FROM race_effect_deadlines WHERE effect_id IN (SELECT d.effect_id FROM race_effect_deadlines d JOIN races r ON r.id=d.race_id WHERE r.status<>'active' ORDER BY d.deadline_at LIMIT $1)`,
        Math.min(100, limit),
      );
      return repaired;
    },
  };
}
const RaceEffectDeadline = buildRaceEffectDeadlineModel();
module.exports = {
  RaceEffectDeadline,
  buildRaceEffectDeadlineModel,
  isBusyRaceJobError,
};
