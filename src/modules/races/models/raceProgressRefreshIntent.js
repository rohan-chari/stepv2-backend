const { prisma } = require("../../../db");
const { RaceResolutionJobV2: Job } = require("./raceResolutionJobV2");
const {
  RaceEffectDeadline,
  isBusyRaceJobError,
} = require("./raceEffectDeadline");
const redisCache = require("../../../shared/cache/redisCache");
const wake = () =>
  redisCache.publishDurableQueueWakeup("resolution", { workKind: "ordinary" });

// Coverage is checked under C0. Viewer intake must not mutate an in-flight
// boundary generation's captured scope; its UUID survives racing requests.
async function admitExpiryRefresh(
  { raceId, userId = null, timeZone = null, dirtyUserIds = [] },
  tx = null,
) {
  const db = tx || prisma;
  const due = await db.$queryRawUnsafe(
    `SELECT dispatched_generation FROM race_effect_deadlines WHERE race_id=$1 AND deadline_at<=(statement_timestamp() AT TIME ZONE 'UTC') ORDER BY dispatched_generation DESC NULLS LAST LIMIT 1`,
    raceId,
  );
  if (!due.length) return null;
  const admit = async (db) => {
    await db.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
    let job = await Job.acquireForWrite(db, { raceId });
    const dispatched = await RaceEffectDeadline.dispatchRace(raceId, db);
    if (dispatched) job = dispatched.job;
    const coverage = await db.$queryRawUnsafe(
      `SELECT max(dispatched_generation)::int AS generation FROM race_effect_deadlines WHERE race_id=$1 AND deadline_at<=(statement_timestamp() AT TIME ZONE 'UTC') AND dispatched_revision=revision`,
      raceId,
    );
    const minimum = coverage[0]?.generation;
    if (
      !minimum ||
      !["QUEUED", "RUNNING"].includes(job?.state) ||
      Number(job.generation) < minimum
    )
      return null;
    const users = [...new Set([userId, ...dirtyUserIds].filter(Boolean))];
    const captured = new Set([
      ...(job.triggeredByUserIds || []),
      ...(job.processingTriggeredByUserIds || []),
    ]);
    for (const id of users) {
      if (
        captured.has(id) &&
        (!timeZone ||
          timeZone ===
            (job.state === "RUNNING"
              ? job.processingTimeZone
              : job.resolutionTimeZone))
      )
        continue;
      await db.$executeRawUnsafe(
        `INSERT INTO race_progress_refresh_intents(race_id,user_id,minimum_committed_generation,resolution_time_zone,scope) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(race_id,user_id) DO UPDATE SET request_id=gen_random_uuid(),requested_at=clock_timestamp(),available_at=LEAST(race_progress_refresh_intents.available_at,clock_timestamp()),minimum_committed_generation=GREATEST(race_progress_refresh_intents.minimum_committed_generation,EXCLUDED.minimum_committed_generation),resolution_time_zone=COALESCE(EXCLUDED.resolution_time_zone,race_progress_refresh_intents.resolution_time_zone),scope=EXCLUDED.scope`,
        raceId,
        id,
        minimum,
        timeZone,
        JSON.stringify({ dirtyUserIds: [id] }),
      );
    }
    return job;
  };
  if (tx) return admit(tx);
  try {
    return await prisma.$transaction(admit, { timeout: 5000 });
  } catch (error) {
    if (!isBusyRaceJobError(error)) throw error;
    // C0 can be held by the committing worker. Persist distinct viewers without
    // acquiring that fence; the intake UUID/minimum generation protects them.
    for (const id of [...new Set([userId, ...dirtyUserIds].filter(Boolean))]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO race_progress_refresh_intents(race_id,user_id,minimum_committed_generation,resolution_time_zone,scope) VALUES($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT(race_id,user_id) DO UPDATE SET request_id=gen_random_uuid(),requested_at=clock_timestamp(),minimum_committed_generation=GREATEST(race_progress_refresh_intents.minimum_committed_generation,EXCLUDED.minimum_committed_generation),resolution_time_zone=COALESCE(EXCLUDED.resolution_time_zone,race_progress_refresh_intents.resolution_time_zone),scope=EXCLUDED.scope`,
        raceId,
        id,
        due[0].dispatched_generation || 0,
        timeZone,
        JSON.stringify({ dirtyUserIds: [id] }),
      );
    }
    return { raceId, generation: due[0].dispatched_generation || 0 };
  }
}
async function drainProgressRefreshIntents() {
  const candidates = await prisma.$queryRawUnsafe(
    `SELECT race_id FROM race_progress_refresh_intents WHERE available_at<=(statement_timestamp() AT TIME ZONE 'UTC') ORDER BY available_at,race_id LIMIT 100`,
  );
  let count = 0;
  for (const raceId of [...new Set(candidates.map((r) => r.race_id))]) {
    const admitted = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='150ms'");
        const job = await Job.acquireForWrite(tx, { raceId });
        const rows = await tx.$queryRawUnsafe(
          `SELECT i.*,j.committed_generation,r.status AS race_status FROM race_progress_refresh_intents i JOIN race_resolution_jobs_v2 j ON j.race_id=i.race_id JOIN races r ON r.id=i.race_id WHERE i.race_id=$1 ORDER BY requested_at LIMIT 100 FOR UPDATE OF i SKIP LOCKED`,
          raceId,
        );
        const ended = rows.filter((r) =>
          ["completed", "cancelled"].includes(r.race_status),
        );
        if (ended.length)
          await tx.$executeRawUnsafe(
            `DELETE FROM race_progress_refresh_intents WHERE race_id=$1 AND request_id=ANY($2::uuid[])`,
            raceId,
            ended.map((r) => r.request_id),
          );
        const pending = rows.filter((row) => !ended.includes(row));
        const [coverage] = await tx.$queryRawUnsafe(
          `SELECT
          COUNT(*) FILTER(WHERE dispatched_revision IS NULL)::int AS undispatched,
          COALESCE(MAX(dispatched_generation) FILTER(WHERE dispatched_revision=revision),0)::int AS generation
          FROM race_effect_deadlines WHERE race_id=$1 AND deadline_at<=(statement_timestamp() AT TIME ZONE 'UTC')`,
          raceId,
        );
        // Zero is a durable "awaiting dispatch" sentinel, never proof that the
        // pending boundary completed. Resolve it under C0 before admission.
        for (const row of pending)
          row.minimum_committed_generation = Math.max(
            row.minimum_committed_generation,
            coverage.generation,
          );
        if (pending.length)
          await tx.$executeRawUnsafe(
            `UPDATE race_progress_refresh_intents
          SET minimum_committed_generation=GREATEST(minimum_committed_generation,$2)
          WHERE race_id=$1 AND request_id=ANY($3::uuid[])`,
            raceId,
            coverage.generation,
            pending.map((row) => row.request_id),
          );
        const terminal = ["FAILED", "SUCCEEDED"].includes(job?.state);
        const ready = coverage.undispatched
          ? []
          : pending.filter(
              (row) =>
                Number(row.committed_generation) >=
                  row.minimum_committed_generation || terminal,
            );
        if (!ready.length) {
          if (pending.length)
            await tx.$executeRawUnsafe(
              `UPDATE race_progress_refresh_intents SET available_at=clock_timestamp()+interval '5 seconds'
             WHERE race_id=$1 AND request_id=ANY($2::uuid[])`,
              raceId,
              pending.map((row) => row.request_id),
            );
          return 0;
        }
        // A failed/lost covered generation may outlive its source deadline.
        // Retain its generation floor and admit one fresh scoped computation;
        // do not wait forever for an obsolete generation to commit.
        if (terminal)
          await tx.$executeRawUnsafe(
            `UPDATE race_resolution_jobs_v2
          SET generation=GREATEST(generation,$2) WHERE race_id=$1`,
            raceId,
            Math.max(...ready.map((row) => row.minimum_committed_generation)),
          );
        // Queue takes the most recently requested non-null scoring timezone, the
        // same last-writer semantics as direct display refresh intake.
        const timeZone =
          ready.filter((r) => r.resolution_time_zone).at(-1)
            ?.resolution_time_zone || null;
        await Job.enqueue(
          {
            raceId,
            triggeredUserIds: ready.map((r) => r.user_id),
            resolutionTimeZone: timeZone,
            dirtyEnvelope: {
              reason: "DISPLAY_REFRESH",
              priority: "COALESCE",
              dirtyUserIds: ready.map((r) => r.user_id),
            },
            queuePriority: "MAINTENANCE",
          },
          tx,
        );
        await tx.$executeRawUnsafe(
          `DELETE FROM race_progress_refresh_intents WHERE race_id=$1 AND request_id=ANY($2::uuid[])`,
          raceId,
          ready.map((r) => r.request_id),
        );
        return ready.length;
      })
      .catch((e) => {
        if (isBusyRaceJobError(e)) return 0;
        throw e;
      });
    count += admitted;
    if (admitted) await wake();
  }
  return count;
}
module.exports = { admitExpiryRefresh, drainProgressRefreshIntents };
