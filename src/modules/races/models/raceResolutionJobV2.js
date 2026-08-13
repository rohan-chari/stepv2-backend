const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

// Race-keyed resolution queue (Redis derived-data spec §5a). One row per race.
//
// The whole point of this table is OWNERSHIP: whoever holds the current
// `leaseToken` on a race's row is the sole bulk writer of that race's
// `race_participants` rows for the duration of its fenced write transaction.
// Everything else here (generation/superseded, retry backoff, lease expiry) is
// carried over unchanged from the per-user v1 queue.
//
// Deliberately raw SQL for enqueue/claim: the upsert needs a JSONB
// append-distinct and the claim needs FOR UPDATE SKIP LOCKED + a JSONB UNION in
// ONE statement. Prisma's query builder can express neither.

const LEASE_MS = 30 * 1000;
const RETRY_BACKOFF_MS = [1000, 5000, 30000];
const MAX_ATTEMPTS = 3;
const DEFAULT_DEBOUNCE_MS = 5000;
const DEFAULT_RECOVERY_STALE_MS = 60 * 60 * 1000;

// §5a item 3: the work cap is an explicit rule, not an emergent property.
// recordSuccess pushes `not_before_at` this far into the future; claim
// eligibility requires `not_before_at <= now`, so a continuously-bumped race
// resolves at most once per window instead of spinning.
function debounceMs() {
  const parsed = Number(process.env.RACE_RESOLVE_DEBOUNCE_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEBOUNCE_MS;
}

function newLeaseToken() {
  return crypto.randomUUID();
}

// Postgres returns snake_case from $queryRaw unless aliased; every raw read
// below aliases into the camelCase shape the rest of the codebase expects.
const jobColumns = (q = "") => `
  ${q}id,
  ${q}race_id                            AS "raceId",
  generation,
  ${q}processing_generation              AS "processingGeneration",
  ${q}resolution_time_zone               AS "resolutionTimeZone",
  ${q}processing_time_zone               AS "processingTimeZone",
  state,
  attempts,
  ${q}requested_at                       AS "requestedAt",
  ${q}started_at                         AS "startedAt",
  ${q}completed_at                       AS "completedAt",
  ${q}last_completed_at                  AS "lastCompletedAt",
  ${q}retry_at                           AS "retryAt",
  ${q}not_before_at                      AS "notBeforeAt",
  ${q}lease_expires_at                   AS "leaseExpiresAt",
  ${q}lease_token                        AS "leaseToken",
  ${q}last_error_code                    AS "lastErrorCode",
  ${q}triggered_by_user_ids              AS "triggeredByUserIds",
  ${q}processing_triggered_by_user_ids   AS "processingTriggeredByUserIds"
`;

// The stored enum labels are LOWERCASE ('queued' | 'running' | ...); Prisma maps
// them to uppercase names. Raw SQL reads the stored labels, so normalize on the
// way out and every caller sees the Prisma-shaped value.
function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    state: typeof row.state === "string" ? row.state.toUpperCase() : row.state,
    triggeredByUserIds: Array.isArray(row.triggeredByUserIds)
      ? row.triggeredByUserIds
      : [],
    processingTriggeredByUserIds: Array.isArray(row.processingTriggeredByUserIds)
      ? row.processingTriggeredByUserIds
      : [],
  };
}

function buildRaceResolutionJobV2Model(prisma = defaultPrisma) {
  return {
    LEASE_MS,
    MAX_ATTEMPTS,
    debounceMs,

    // Upsert by raceId: bump `generation` (mark dirty) and APPEND-DISTINCT the
    // triggering user onto `triggered_by_user_ids`.
    //
    // Three deliberate differences from the v1 enqueue:
    //  1. A RUNNING row is left RUNNING. Resetting it to QUEUED would let a
    //     second worker claim a race whose first worker is mid-computation — the
    //     fence would turn the loser away correctly, but the work is wasted. The
    //     generation bump alone is enough: recordSuccess sees the newer
    //     generation and requeues for a follow-up run.
    //  2. `requested_at` is only reset when the row is NOT already pending, so
    //     the queue-lag metric measures the age of the OLDEST unserviced request.
    //  3. `not_before_at` is NEVER cleared here. It is the debounce floor; an
    //     enqueue marks a race dirty, it does not buy a run.
    //
    // Runs inside the caller's transaction when `tx` is provided (sync-v2
    // Transaction B) so the queue row only becomes visible with the rest of it.
    async enqueue(
      { raceId, userId = null, resolutionTimeZone = null, now = new Date() },
      tx = prisma
    ) {
      if (!raceId) return null;
      const triggered = JSON.stringify(userId ? [userId] : []);
      const rows = await tx.$queryRawUnsafe(
        `
        INSERT INTO race_resolution_jobs_v2 (
          id, race_id, generation, resolution_time_zone, state, attempts,
          requested_at, triggered_by_user_ids, processing_triggered_by_user_ids,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid()::text, $1, 1, $2, 'queued', 0,
          $3, $4::jsonb, '[]'::jsonb, $3, $3
        )
        ON CONFLICT (race_id) DO UPDATE SET
          generation = race_resolution_jobs_v2.generation + 1,
          resolution_time_zone = COALESCE($2, race_resolution_jobs_v2.resolution_time_zone),
          state = CASE
            WHEN race_resolution_jobs_v2.state = 'running' THEN 'running'::"RaceResolutionJobState"
            ELSE 'queued'::"RaceResolutionJobState"
          END,
          attempts = CASE
            WHEN race_resolution_jobs_v2.state = 'running' THEN race_resolution_jobs_v2.attempts
            ELSE 0
          END,
          requested_at = CASE
            WHEN race_resolution_jobs_v2.state IN ('queued', 'running')
              THEN race_resolution_jobs_v2.requested_at
            ELSE $3
          END,
          retry_at = NULL,
          last_error_code = NULL,
          triggered_by_user_ids = (
            SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
            FROM jsonb_array_elements(
              race_resolution_jobs_v2.triggered_by_user_ids || $4::jsonb
            ) AS v
          ),
          updated_at = $3
        RETURNING ${jobColumns()}
        `,
        raceId,
        resolutionTimeZone,
        now,
        triggered
      );
      return normalizeRow(rows[0]);
    },

    // Convenience for the multi-race enqueue sites (sync-v2 Transaction B).
    // Enqueues in stable ascending raceId order so two
    // concurrent uploaders never take the row locks in opposite orders.
    async enqueueMany(
      { raceIds, userId = null, resolutionTimeZone = null, now = new Date() },
      tx = prisma
    ) {
      const ordered = [...new Set(raceIds || [])]
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b)));
      const out = [];
      for (const raceId of ordered) {
        out.push(
          await this.enqueue({ raceId, userId, resolutionTimeZone, now }, tx)
        );
      }
      return out;
    },

    // Claim ONE eligible race with FOR UPDATE SKIP LOCKED, mint a FRESH lease
    // token (the fencing token the write transaction re-verifies), and move the
    // accumulated `triggered_by_user_ids` into `processing_triggered_by_user_ids`
    // by UNION with whatever is already there.
    //
    // The union — not an overwrite — is the crash-retry guarantee of §5a item 2:
    // a run that died mid-flight left its triggering users in the processing
    // column, and this re-claim folds them back in alongside anyone who enqueued
    // since. No triggering user's box state / nudge is ever dropped.
    async claimNext({
      now = new Date(),
      leaseMs = LEASE_MS,
      leaseToken = newLeaseToken(),
    } = {}) {
      const rows = await prisma.$queryRawUnsafe(
        `
        WITH candidate AS (
          SELECT id
          FROM race_resolution_jobs_v2
          WHERE (
                  state = 'queued'
                  AND (retry_at IS NULL OR retry_at <= $1)
                  AND (not_before_at IS NULL OR not_before_at <= $1)
                )
             OR (
                  state = 'running'
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= $1
                )
          ORDER BY requested_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE race_resolution_jobs_v2 j
        SET state = 'running',
            processing_generation = j.generation,
            processing_time_zone = j.resolution_time_zone,
            started_at = $1,
            lease_expires_at = $2,
            lease_token = $3,
            attempts = j.attempts + 1,
            processing_triggered_by_user_ids = (
              SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
              FROM jsonb_array_elements(
                j.processing_triggered_by_user_ids || j.triggered_by_user_ids
              ) AS v
            ),
            triggered_by_user_ids = '[]'::jsonb,
            updated_at = $1
        FROM candidate c
        WHERE j.id = c.id
        RETURNING ${jobColumns("j.")}
        `,
        now,
        new Date(now.getTime() + leaseMs),
        leaseToken
      );
      return normalizeRow(rows[0]);
    },

    // Record success. MUST run inside the worker's fenced write transaction
    // (step iii of §5a item 5) so the participant writes and the job-row update
    // commit atomically.
    //
    // Conditional on BOTH the lease token (we are still the owner) and the
    // generation (nobody enqueued while we ran). A newer generation returns the
    // row to QUEUED for the follow-up run — but `not_before_at` is still pushed
    // out, so the follow-up honours the debounce. `processing_triggered_by_user_ids`
    // is cleared only on this path: the users in it have now been processed.
    async recordSuccess(
      {
        id,
        leaseToken,
        processingGeneration,
        now = new Date(),
        debounceMs: debounce = debounceMs(),
      },
      tx = prisma
    ) {
      const rows = await tx.$queryRawUnsafe(
        `
        UPDATE race_resolution_jobs_v2
        SET state = CASE
              WHEN generation = $3 THEN 'succeeded'::"RaceResolutionJobState"
              ELSE 'queued'::"RaceResolutionJobState"
            END,
            attempts = CASE WHEN generation = $3 THEN attempts ELSE 0 END,
            completed_at = $4,
            last_completed_at = $4,
            retry_at = NULL,
            not_before_at = $5,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error_code = NULL,
            processing_triggered_by_user_ids = '[]'::jsonb,
            updated_at = $4
        WHERE id = $1 AND lease_token = $2
        RETURNING generation
        `,
        id,
        leaseToken,
        processingGeneration,
        now,
        new Date(now.getTime() + debounce)
      );
      if (rows.length === 0) return { applied: false, superseded: false };
      return {
        applied: true,
        superseded: Number(rows[0].generation) !== Number(processingGeneration),
      };
    },

    // Transient failure: back off and retry while attempts remain, else FAILED.
    // `processing_triggered_by_user_ids` is deliberately KEPT so the next claim's
    // UNION re-processes this run's triggering users.
    async recordFailure({ id, leaseToken, attempts, errorCode = null, now = new Date() }) {
      const terminal = attempts >= MAX_ATTEMPTS;
      const backoff =
        RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, RETRY_BACKOFF_MS.length - 1)];
      const rows = await prisma.$queryRawUnsafe(
        `
        UPDATE race_resolution_jobs_v2
        SET state = $3::"RaceResolutionJobState",
            retry_at = $4,
            completed_at = $5,
            lease_expires_at = NULL,
            lease_token = NULL,
            last_error_code = $6,
            updated_at = $7
        WHERE id = $1 AND ($2::text IS NULL OR lease_token = $2)
        RETURNING id
        `,
        id,
        leaseToken ?? null,
        terminal ? "failed" : "queued",
        terminal ? null : new Date(now.getTime() + backoff),
        terminal ? now : null,
        errorCode,
        now
      );
      return { state: terminal ? "FAILED" : "QUEUED", applied: rows.length > 0 };
    },

    // Fence acquisition (§5a item 5(i) / item 6). Takes the row lock on the job
    // for `raceId` inside the CALLER's transaction, before it writes a single
    // participant row.
    //
    // `expectedLeaseToken` is the worker's contract: zero rows means the lease
    // was stolen (expired + re-claimed) and the caller must abort having written
    // nothing. `raceExpiry` passes no token — it is not a lease holder, it just
    // needs the row lock, and it upserts the row first because a race that never
    // had a job would otherwise have nothing to lock.
    async acquireForWrite(tx, { raceId = null, id = null, expectedLeaseToken = null, now = new Date() }) {
      if (!id && !raceId) return null;
      if (!id && raceId) {
        // Ensure a row exists to lock. Bare INSERT ... ON CONFLICT DO NOTHING so
        // this never bumps a generation (an expiry acquisition is not a request
        // for another resolve).
        await tx.$queryRawUnsafe(
          `
          INSERT INTO race_resolution_jobs_v2 (id, race_id, requested_at, created_at, updated_at)
          VALUES (gen_random_uuid()::text, $1, $2, $2, $2)
          ON CONFLICT (race_id) DO NOTHING
          `,
          raceId,
          now
        );
      }
      const rows = await tx.$queryRawUnsafe(
        `
        SELECT ${jobColumns()}
        FROM race_resolution_jobs_v2
        WHERE ($1::text IS NULL OR id = $1)
          AND ($2::text IS NULL OR race_id = $2)
          AND ($3::text IS NULL OR lease_token = $3)
        FOR UPDATE
        `,
        id,
        raceId,
        expectedLeaseToken
      );
      return normalizeRow(rows[0]);
    },

    async findById(id) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT ${jobColumns()} FROM race_resolution_jobs_v2 WHERE id = $1`,
        id
      );
      return normalizeRow(rows[0]);
    },

    async findByRaceId(raceId) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT ${jobColumns()} FROM race_resolution_jobs_v2 WHERE race_id = $1`,
        raceId
      );
      return normalizeRow(rows[0]);
    },

    // Bounded convergence backstop for the five-minute placement cron. Normal
    // mutations enqueue directly; this only identifies active races whose job
    // row is missing, terminally failed, or has not had an insurance replay in
    // the configured stale window. Selection is lean and happens in memory
    // after one indexed read of the active race ids supplied by the caller.
    async findRecoveryRaceIds({
      raceIds,
      now = new Date(),
      limit = 2,
      staleMs = DEFAULT_RECOVERY_STALE_MS,
    }) {
      const ids = [...new Set(raceIds || [])].filter(Boolean);
      const cap = Math.max(0, Math.min(2, Number(limit) || 0));
      if (ids.length === 0 || cap === 0) return [];

      const jobs = await prisma.raceResolutionJobV2.findMany({
        where: { raceId: { in: ids } },
        select: {
          raceId: true,
          state: true,
          requestedAt: true,
          lastCompletedAt: true,
        },
      });
      const byRaceId = new Map(jobs.map((job) => [job.raceId, job]));
      const staleBefore = now.getTime() - Math.max(0, Number(staleMs) || 0);

      return ids
        .map((raceId) => {
          const job = byRaceId.get(raceId);
          if (!job) return { raceId, priority: 0, age: 0 };
          if (job.state === "FAILED") {
            return {
              raceId,
              priority: 1,
              age: (job.lastCompletedAt || job.requestedAt).getTime(),
            };
          }
          if (job.state !== "SUCCEEDED") return null;
          const completedAt = job.lastCompletedAt || job.requestedAt;
          if (completedAt.getTime() > staleBefore) return null;
          return { raceId, priority: 2, age: completedAt.getTime() };
        })
        .filter(Boolean)
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.age - right.age ||
            String(left.raceId).localeCompare(String(right.raceId))
        )
        .slice(0, cap)
        .map((candidate) => candidate.raceId);
    },

    // Backpressure metric (§5a "Worker capacity"): max age of an unserviced
    // request. Alarm threshold is 30s; the worker logs it once a minute.
    async queueLagMs(now = new Date()) {
      const rows = await prisma.$queryRawUnsafe(
        `
        SELECT COALESCE(
          MAX(EXTRACT(EPOCH FROM ($1::timestamp - requested_at)) * 1000), 0
        )::float8 AS lag
        FROM race_resolution_jobs_v2
        WHERE state IN ('queued', 'running')
        `,
        now
      );
      const lag = Number(rows[0]?.lag ?? 0);
      return Number.isFinite(lag) ? Math.max(0, Math.round(lag)) : 0;
    },

    // Rollback drill assertion (test 5h / runbook step ii): zero RUNNING rows
    // whose lease has not yet expired means no v2 worker can be mid-write.
    async countUnexpiredRunning(now = new Date()) {
      const rows = await prisma.$queryRawUnsafe(
        `
        SELECT COUNT(*)::int AS count
        FROM race_resolution_jobs_v2
        WHERE state = 'running'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at > $1
        `,
        now
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}

const RaceResolutionJobV2 = buildRaceResolutionJobV2Model();

module.exports = {
  buildRaceResolutionJobV2Model,
  RaceResolutionJobV2,
  newLeaseToken,
  debounceMs,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECOVERY_STALE_MS,
};
