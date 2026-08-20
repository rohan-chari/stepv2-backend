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
const {
  normalizeDirtyEnvelope,
} = require("../services/raceResolutionReasonRegistry");

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
  ${q}processing_triggered_by_user_ids   AS "processingTriggeredByUserIds",
  ${q}dirty_reasons                      AS "dirtyReasons",
  ${q}dirty_participant_ids              AS "dirtyParticipantIds",
  ${q}dirty_powerup_types                 AS "dirtyPowerupTypes",
  ${q}dirty_priority                      AS "dirtyPriority",
  ${q}processing_dirty_reasons            AS "processingDirtyReasons",
  ${q}processing_dirty_participant_ids    AS "processingDirtyParticipantIds",
  ${q}processing_dirty_powerup_types      AS "processingDirtyPowerupTypes",
  ${q}processing_dirty_priority           AS "processingDirtyPriority",
  ${q}display_artifact_id                 AS "displayArtifactId",
  ${q}display_artifact_digest             AS "displayArtifactDigest",
  ${q}display_artifact_schema             AS "displayArtifactSchema",
  ${q}processing_display_artifact_id      AS "processingDisplayArtifactId",
  ${q}processing_display_artifact_digest  AS "processingDisplayArtifactDigest",
  ${q}processing_display_artifact_schema  AS "processingDisplayArtifactSchema"
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
    dirtyReasons: Array.isArray(row.dirtyReasons) ? row.dirtyReasons : [],
    dirtyParticipantIds: Array.isArray(row.dirtyParticipantIds)
      ? row.dirtyParticipantIds
      : [],
    dirtyPowerupTypes: Array.isArray(row.dirtyPowerupTypes)
      ? row.dirtyPowerupTypes
      : [],
    processingDirtyReasons: Array.isArray(row.processingDirtyReasons)
      ? row.processingDirtyReasons
      : [],
    processingDirtyParticipantIds: Array.isArray(row.processingDirtyParticipantIds)
      ? row.processingDirtyParticipantIds
      : [],
    processingDirtyPowerupTypes: Array.isArray(row.processingDirtyPowerupTypes)
      ? row.processingDirtyPowerupTypes
      : [],
  };
}

function buildRaceResolutionJobV2Model(prisma = defaultPrisma) {
  return {
    LEASE_MS,
    MAX_ATTEMPTS,
    debounceMs,

    // Upsert by raceId: mark the row dirty and APPEND-DISTINCT the triggering
    // user onto `triggered_by_user_ids`. The default path bumps `generation`.
    // The separately gated queued-merge experiment may retain an unclaimed QUEUED
    // generation, but makes that decision in this same conflict-row lock.
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
      {
        raceId,
        userId = null,
        resolutionTimeZone = null,
        now = new Date(),
        dirtyEnvelope = null,
        displayArtifact = null,
        burstCoalescing = false,
        queuedGenerationMerge = false,
        bypassDebounce = false,
      },
      tx = prisma
    ) {
      if (!raceId) return null;
      const [row] = await this.enqueueMany(
        {
          raceIds: [raceId],
          userId,
          resolutionTimeZone,
          now,
          dirtyEnvelopeByRaceId: new Map([[raceId, dirtyEnvelope]]),
          displayArtifactByRaceId: new Map([[raceId, displayArtifact]]),
          burstCoalescing,
          queuedGenerationMerge,
          bypassDebounce,
        },
        tx
      );
      return row || null;
    },

    // Convenience for the multi-race enqueue sites (sync-v2 Transaction B).
    // Enqueues in stable ascending raceId order so two
    // concurrent uploaders never take the row locks in opposite orders.
    //
    // PERFORMANCE (2026-08-17): this used to be a `for` loop issuing the upsert
    // once per race, sequentially, inside the caller's transaction. Profiling at
    // 61 rps showed that statement was **81% of all database busy time**, and
    // marshalling it N times per sync was the bulk of the 34.8% of app CPU spent
    // in Prisma. A user in the median 4 active races paid 4 sequential round
    // trips with a transaction — and its row locks — held open across all of
    // them, which is what produced the `idle in transaction` pileup.
    //
    // It is now ONE statement for all races. The per-race values travel as a
    // jsonb array expanded by `jsonb_to_recordset`; the conflict clause is
    // unchanged in meaning, reading each race's new values from `EXCLUDED`
    // instead of from positional parameters.
    //
    // `ORDER BY i."raceId"` is load-bearing, not cosmetic: it is the same
    // ascending lock order the old loop guaranteed, and it is what stops two
    // concurrent uploaders sharing two races from deadlocking against each
    // other. Proven, not assumed:
    // test/integration/race-queue-v2-enqueue-lock-order.test.js measures the
    // acquisition order directly.
    //
    // PERFORMANCE (2026-08-17, change 3.3): each scope cap below is written as
    //
    //     jsonb_array_length(a || b) > CAP AND <distinct count over a || b> > CAP
    //
    // and the first half is NOT redundant. `jsonb_array_length` is an O(1) read
    // of the jsonb header and is an exact UPPER BOUND on the distinct count, so
    // whenever it comes in at or under the cap the DISTINCT pass cannot change
    // the answer and Postgres skips it. That pass was measured at 31% of this
    // statement — the single largest component after the merges — and it is
    // pure waste for the overwhelming majority of races, which are nowhere near
    // 1,000 participants. Measured 1.14ms -> 0.85ms per execution.
    //
    // The DISTINCT half must stay. The cap counts DISTINCT ids, and while both
    // sides of the merge are individually deduplicated (stored by the merge's
    // GROUP BY, incoming by stableStrings()), they OVERLAP — re-reporting an id
    // you already reported is what a step sync does constantly. Dropping to the
    // length alone, as the requirements doc originally proposed, would count
    // those duplicates and degrade a full race to FULL on nearly every sync.
    // test/integration/race-queue-v2-enqueue-scope-guard.test.js pins this.
    async enqueueMany(
      {
        raceIds,
        userId = null,
        resolutionTimeZone = null,
        now = new Date(),
        dirtyEnvelopeByRaceId = null,
        displayArtifactByRaceId = null,
        burstCoalescing = false,
        queuedGenerationMerge = false,
        bypassDebounce = false,
      },
      tx = prisma
    ) {
      const ordered = [...new Set(raceIds || [])]
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b)));
      if (!ordered.length) return [];

      const triggered = userId ? [userId] : [];
      const rowsIn = ordered.map((raceId) => {
        const dirty = dirtyEnvelopeByRaceId?.get?.(raceId)
          ? normalizeDirtyEnvelope(dirtyEnvelopeByRaceId.get(raceId))
          : null;
        const candidate = displayArtifactByRaceId?.get?.(raceId) || null;
        const artifact =
          candidate &&
          typeof candidate.id === "string" &&
          /^[a-f0-9]{64}$/i.test(candidate.digest || "") &&
          Number.isInteger(candidate.schema)
            ? candidate
            : null;
        const priority = dirty?.priority || "IMMEDIATE";
        return {
          raceId,
          resolutionTimeZone,
          triggered,
          dirtyReasons: dirty?.reasons || [],
          dirtyParticipantIds: dirty?.dirtyParticipantIds || [],
          dirtyPowerupTypes: dirty?.powerupTypes || [],
          dirtyPriority: priority,
          artifactId: artifact?.id || null,
          artifactDigest: artifact?.digest || null,
          artifactSchema: artifact?.schema || null,
          notBeforeAt:
            burstCoalescing && priority === "COALESCE"
              ? new Date(now.getTime() + DEFAULT_DEBOUNCE_MS).toISOString()
              : null,
        };
      });

      const rows = await tx.$queryRawUnsafe(
        `
        INSERT INTO race_resolution_jobs_v2 (
          id, race_id, generation, resolution_time_zone, state, attempts,
          requested_at, not_before_at, triggered_by_user_ids, processing_triggered_by_user_ids,
          dirty_reasons, dirty_participant_ids, dirty_powerup_types, dirty_priority,
          display_artifact_id, display_artifact_digest, display_artifact_schema,
          created_at, updated_at
        )
        SELECT
          gen_random_uuid()::text, i."raceId", 1, i."resolutionTimeZone", 'queued', 0,
          $2::timestamp, i."notBeforeAt", i."triggered", '[]'::jsonb,
          i."dirtyReasons", i."dirtyParticipantIds", i."dirtyPowerupTypes", i."dirtyPriority",
          i."artifactId", i."artifactDigest", i."artifactSchema",
          $2::timestamp, $2::timestamp
        FROM jsonb_to_recordset($1::jsonb) AS i(
          "raceId" text,
          "resolutionTimeZone" text,
          "triggered" jsonb,
          "dirtyReasons" jsonb,
          "dirtyParticipantIds" jsonb,
          "dirtyPowerupTypes" jsonb,
          "dirtyPriority" text,
          "artifactId" text,
          "artifactDigest" text,
          "artifactSchema" integer,
          "notBeforeAt" timestamp
        )
        ORDER BY i."raceId"
        ON CONFLICT (race_id) DO UPDATE SET
          generation = CASE
            WHEN $3::boolean
              AND race_resolution_jobs_v2.state = 'queued'
              AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                   OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
              AND (race_resolution_jobs_v2.processing_generation IS NULL
                   OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation)
              THEN race_resolution_jobs_v2.generation
            ELSE race_resolution_jobs_v2.generation + 1
          END,
          resolution_time_zone = COALESCE(EXCLUDED.resolution_time_zone, race_resolution_jobs_v2.resolution_time_zone),
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
            ELSE $2::timestamp
          END,
          retry_at = NULL,
          last_error_code = NULL,
          lease_expires_at = CASE
            WHEN $3::boolean
              AND race_resolution_jobs_v2.state = 'queued'
              AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                   OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
              AND (race_resolution_jobs_v2.processing_generation IS NULL
                   OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation)
              THEN NULL
            ELSE race_resolution_jobs_v2.lease_expires_at
          END,
          lease_token = CASE
            WHEN $3::boolean
              AND race_resolution_jobs_v2.state = 'queued'
              AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                   OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
              AND (race_resolution_jobs_v2.processing_generation IS NULL
                   OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation)
              THEN NULL
            ELSE race_resolution_jobs_v2.lease_token
          END,
          triggered_by_user_ids = (
            SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
            FROM jsonb_array_elements(
              race_resolution_jobs_v2.triggered_by_user_ids || EXCLUDED.triggered_by_user_ids
            ) AS v
          ),
          dirty_reasons = CASE
            WHEN jsonb_typeof(race_resolution_jobs_v2.dirty_reasons) IS DISTINCT FROM 'array'
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_participant_ids) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_powerup_types) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
              OR (race_resolution_jobs_v2.dirty_reasons = '[]'::jsonb
                  AND race_resolution_jobs_v2.state <> 'succeeded')
              OR race_resolution_jobs_v2.dirty_reasons ? 'FULL'
              OR EXCLUDED.dirty_reasons ? 'FULL'
              OR (jsonb_array_length(race_resolution_jobs_v2.dirty_participant_ids || EXCLUDED.dirty_participant_ids) > 1000
                  AND (SELECT COUNT(*) FROM (
                        SELECT DISTINCT value
                        FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_participant_ids || EXCLUDED.dirty_participant_ids)
                      ) scope_check) > 1000)
              OR (jsonb_array_length(race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types) > 64
                  AND (SELECT COUNT(*) FROM (
                        SELECT DISTINCT value
                        FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types)
                      ) scope_check) > 64)
              THEN CASE
                WHEN (race_resolution_jobs_v2.dirty_reasons || EXCLUDED.dirty_reasons) ? 'EFFECT_BOUNDARY'
                  THEN '["FULL","EFFECT_BOUNDARY"]'::jsonb
                ELSE '["FULL"]'::jsonb
              END
            ELSE (
              SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_reasons || EXCLUDED.dirty_reasons)
                  WITH ORDINALITY AS merged(value, ordinality)
                GROUP BY value
              ) stable
            )
          END,
          dirty_participant_ids = CASE
            WHEN jsonb_typeof(race_resolution_jobs_v2.dirty_reasons) IS DISTINCT FROM 'array'
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_participant_ids) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_powerup_types) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
              OR (race_resolution_jobs_v2.dirty_reasons = '[]'::jsonb
                  AND race_resolution_jobs_v2.state <> 'succeeded')
              OR race_resolution_jobs_v2.dirty_reasons ? 'FULL'
              OR EXCLUDED.dirty_reasons ? 'FULL'
              OR (jsonb_array_length(race_resolution_jobs_v2.dirty_participant_ids || EXCLUDED.dirty_participant_ids) > 1000
                  AND (SELECT COUNT(*) FROM (
                        SELECT DISTINCT value
                        FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_participant_ids || EXCLUDED.dirty_participant_ids)
                      ) scope_check) > 1000)
              THEN '[]'::jsonb
            ELSE (
              SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_participant_ids || EXCLUDED.dirty_participant_ids)
                  WITH ORDINALITY AS merged(value, ordinality)
                GROUP BY value
                HAVING COUNT(*) >= 1
              ) stable
            )
          END,
          dirty_powerup_types = CASE
            WHEN jsonb_typeof(race_resolution_jobs_v2.dirty_reasons) IS DISTINCT FROM 'array'
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_participant_ids) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_powerup_types) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
              OR (race_resolution_jobs_v2.dirty_reasons = '[]'::jsonb
                  AND race_resolution_jobs_v2.state <> 'succeeded')
              OR race_resolution_jobs_v2.dirty_reasons ? 'FULL'
              OR EXCLUDED.dirty_reasons ? 'FULL'
              OR (jsonb_array_length(race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types) > 64
                  AND (SELECT COUNT(*) FROM (
                        SELECT DISTINCT value
                        FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types)
                      ) scope_check) > 64)
              THEN CASE
                WHEN jsonb_typeof(race_resolution_jobs_v2.dirty_powerup_types) = 'array'
                  AND jsonb_typeof(EXCLUDED.dirty_powerup_types) = 'array'
                  AND (race_resolution_jobs_v2.dirty_reasons || EXCLUDED.dirty_reasons) ? 'EFFECT_BOUNDARY'
                  AND (race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types) ? 'UMBRELLA'
                  THEN '["UMBRELLA"]'::jsonb
                ELSE '[]'::jsonb
              END
            ELSE (
              SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(race_resolution_jobs_v2.dirty_powerup_types || EXCLUDED.dirty_powerup_types)
                  WITH ORDINALITY AS merged(value, ordinality)
                GROUP BY value
              ) stable
            )
          END,
          dirty_priority = CASE
            WHEN race_resolution_jobs_v2.dirty_priority = 'IMMEDIATE' OR EXCLUDED.dirty_priority = 'IMMEDIATE'
              THEN 'IMMEDIATE' ELSE 'COALESCE' END,
          not_before_at = CASE
            WHEN $4::boolean THEN NULL
            ELSE race_resolution_jobs_v2.not_before_at
          END,
          display_artifact_id = CASE
            WHEN EXCLUDED.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb
              AND (NOT ($3::boolean
                        AND race_resolution_jobs_v2.state = 'queued'
                        AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                             OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
                        AND (race_resolution_jobs_v2.processing_generation IS NULL
                             OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation))
                   OR race_resolution_jobs_v2.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb)
              THEN EXCLUDED.display_artifact_id ELSE NULL END,
          display_artifact_digest = CASE
            WHEN EXCLUDED.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb
              AND (NOT ($3::boolean
                        AND race_resolution_jobs_v2.state = 'queued'
                        AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                             OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
                        AND (race_resolution_jobs_v2.processing_generation IS NULL
                             OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation))
                   OR race_resolution_jobs_v2.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb)
              THEN EXCLUDED.display_artifact_digest ELSE NULL END,
          display_artifact_schema = CASE
            WHEN EXCLUDED.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb
              AND (NOT ($3::boolean
                        AND race_resolution_jobs_v2.state = 'queued'
                        AND (race_resolution_jobs_v2.lease_expires_at IS NULL
                             OR race_resolution_jobs_v2.lease_expires_at <= $2::timestamp)
                        AND (race_resolution_jobs_v2.processing_generation IS NULL
                             OR race_resolution_jobs_v2.processing_generation < race_resolution_jobs_v2.generation))
                   OR race_resolution_jobs_v2.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb)
              THEN EXCLUDED.display_artifact_schema ELSE NULL END,
          updated_at = $2::timestamp
        RETURNING ${jobColumns()}
        `,
        JSON.stringify(rowsIn),
        now,
        queuedGenerationMerge === true,
        bypassDebounce === true
      );

      // RETURNING order is not guaranteed, and callers depend on the ascending
      // ordering (sync-v2 reports the lexicographically-first race's job to
      // frozen clients). Re-key and emit in the requested order.
      const byRaceId = new Map();
      for (const row of rows) {
        const normalized = normalizeRow(row);
        if (normalized) byRaceId.set(normalized.raceId, normalized);
      }
      return ordered.map((raceId) => byRaceId.get(raceId) || null);
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
      raceId = null,
      force = false,
    } = {}) {
      const rows = await prisma.$queryRawUnsafe(
        `
        WITH candidate AS (
          SELECT id
          FROM race_resolution_jobs_v2
          WHERE ($4::text IS NULL OR race_id = $4)
            AND (
              (
                state = 'queued'
                AND ($5::boolean OR retry_at IS NULL OR retry_at <= $1)
                AND ($5::boolean OR not_before_at IS NULL OR not_before_at <= $1)
              )
              OR (
                state = 'running'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= $1
              )
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
            processing_dirty_reasons = CASE
              WHEN jsonb_typeof(j.processing_dirty_reasons) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_reasons) IS DISTINCT FROM 'array'
                OR NOT (j.processing_dirty_reasons || j.dirty_reasons) <@ '["DISPLAY_REFRESH","STEP_SYNC","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
                OR jsonb_typeof(j.processing_dirty_participant_ids) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_participant_ids) IS DISTINCT FROM 'array'
                OR jsonb_path_exists(j.processing_dirty_participant_ids || j.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
                OR jsonb_typeof(j.processing_dirty_powerup_types) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_powerup_types) IS DISTINCT FROM 'array'
                OR jsonb_path_exists(j.processing_dirty_powerup_types || j.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
                OR (j.processing_dirty_reasons = '[]'::jsonb
                    AND j.dirty_reasons = '[]'::jsonb)
                OR (j.processing_dirty_reasons || j.dirty_reasons) ? 'FULL'
                OR (SELECT COUNT(DISTINCT value)
                    FROM jsonb_array_elements(j.processing_dirty_participant_ids || j.dirty_participant_ids)) > 1000
                OR (SELECT COUNT(DISTINCT value)
                    FROM jsonb_array_elements(j.processing_dirty_powerup_types || j.dirty_powerup_types)) > 64
                THEN CASE
                  WHEN (j.processing_dirty_reasons || j.dirty_reasons) ? 'EFFECT_BOUNDARY'
                    THEN '["FULL","EFFECT_BOUNDARY"]'::jsonb
                  ELSE '["FULL"]'::jsonb
                END
              ELSE (
                SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
                FROM (
                  SELECT value, MIN(ordinality) AS first_ordinal
                  FROM jsonb_array_elements(j.processing_dirty_reasons || j.dirty_reasons)
                    WITH ORDINALITY AS merged(value, ordinality)
                  GROUP BY value
                ) stable
              )
            END,
            processing_dirty_participant_ids = CASE
              WHEN jsonb_typeof(j.processing_dirty_reasons) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_reasons) IS DISTINCT FROM 'array'
                OR (j.processing_dirty_reasons || j.dirty_reasons) ? 'FULL'
                OR jsonb_typeof(j.processing_dirty_participant_ids) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_participant_ids) IS DISTINCT FROM 'array'
                OR jsonb_path_exists(j.processing_dirty_participant_ids || j.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
                OR (SELECT COUNT(DISTINCT value)
                    FROM jsonb_array_elements(j.processing_dirty_participant_ids || j.dirty_participant_ids)) > 1000
                THEN '[]'::jsonb
              ELSE (
                SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
                FROM (
                  SELECT value, MIN(ordinality) AS first_ordinal
                  FROM jsonb_array_elements(j.processing_dirty_participant_ids || j.dirty_participant_ids)
                    WITH ORDINALITY AS merged(value, ordinality)
                  GROUP BY value
                ) stable
              )
            END,
            processing_dirty_powerup_types = CASE
              WHEN jsonb_typeof(j.processing_dirty_reasons) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_reasons) IS DISTINCT FROM 'array'
                OR (j.processing_dirty_reasons || j.dirty_reasons) ? 'FULL'
                OR jsonb_typeof(j.processing_dirty_powerup_types) IS DISTINCT FROM 'array'
                OR jsonb_typeof(j.dirty_powerup_types) IS DISTINCT FROM 'array'
                OR jsonb_path_exists(j.processing_dirty_powerup_types || j.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
                OR (SELECT COUNT(DISTINCT value)
                    FROM jsonb_array_elements(j.processing_dirty_powerup_types || j.dirty_powerup_types)) > 64
                THEN CASE
                  WHEN jsonb_typeof(j.processing_dirty_powerup_types) = 'array'
                    AND jsonb_typeof(j.dirty_powerup_types) = 'array'
                    AND (j.processing_dirty_reasons || j.dirty_reasons) ? 'EFFECT_BOUNDARY'
                    AND (j.processing_dirty_powerup_types || j.dirty_powerup_types) ? 'UMBRELLA'
                    THEN '["UMBRELLA"]'::jsonb
                  ELSE '[]'::jsonb
                END
              ELSE (
                SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
                FROM (
                  SELECT value, MIN(ordinality) AS first_ordinal
                  FROM jsonb_array_elements(j.processing_dirty_powerup_types || j.dirty_powerup_types)
                    WITH ORDINALITY AS merged(value, ordinality)
                  GROUP BY value
                ) stable
              )
            END,
            processing_dirty_priority = CASE
              WHEN j.processing_dirty_reasons = '[]'::jsonb THEN j.dirty_priority
              WHEN j.processing_dirty_priority = 'IMMEDIATE' OR j.dirty_priority = 'IMMEDIATE'
                THEN 'IMMEDIATE' ELSE 'COALESCE' END,
            processing_display_artifact_id = j.display_artifact_id,
            processing_display_artifact_digest = j.display_artifact_digest,
            processing_display_artifact_schema = j.display_artifact_schema,
            triggered_by_user_ids = '[]'::jsonb,
            dirty_reasons = '[]'::jsonb,
            dirty_participant_ids = '[]'::jsonb,
            dirty_powerup_types = '[]'::jsonb,
            dirty_priority = 'IMMEDIATE',
            display_artifact_id = NULL,
            display_artifact_digest = NULL,
            display_artifact_schema = NULL,
            updated_at = $1
        FROM candidate c
        WHERE j.id = c.id
        RETURNING ${jobColumns("j.")}
        `,
        now,
        new Date(now.getTime() + leaseMs),
        leaseToken,
        raceId,
        force === true
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
            processing_dirty_reasons = '[]'::jsonb,
            processing_dirty_participant_ids = '[]'::jsonb,
            processing_dirty_powerup_types = '[]'::jsonb,
            processing_dirty_priority = 'IMMEDIATE',
            processing_display_artifact_id = NULL,
            processing_display_artifact_digest = NULL,
            processing_display_artifact_schema = NULL,
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

    async discardSuperseded(
      { id, leaseToken, now = new Date() },
      tx = prisma
    ) {
      const rows = await tx.$queryRawUnsafe(
        `WITH merged AS MATERIALIZED (
           SELECT job.id,
             (SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(job.dirty_reasons || job.processing_dirty_reasons)
                  WITH ORDINALITY AS item(value, ordinality)
                GROUP BY value
              ) stable) AS reasons,
             (SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(job.dirty_participant_ids || job.processing_dirty_participant_ids)
                  WITH ORDINALITY AS item(value, ordinality)
                GROUP BY value
              ) stable) AS participants,
             (SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(job.dirty_powerup_types || job.processing_dirty_powerup_types)
                  WITH ORDINALITY AS item(value, ordinality)
                GROUP BY value
              ) stable) AS powerups,
             (SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal), '[]'::jsonb)
              FROM (
                SELECT value, MIN(ordinality) AS first_ordinal
                FROM jsonb_array_elements(job.triggered_by_user_ids || job.processing_triggered_by_user_ids)
                  WITH ORDINALITY AS item(value, ordinality)
                GROUP BY value
              ) stable) AS triggers
           FROM race_resolution_jobs_v2 job
           WHERE job.id=$1 AND job.lease_token=$2
             AND job.generation > job.processing_generation
             AND job.dirty_priority='COALESCE'
             AND job.processing_dirty_priority='COALESCE'
             AND job.last_completed_at >= $3::timestamp - INTERVAL '15 seconds'
         )
         UPDATE race_resolution_jobs_v2 job
         SET state='queued', attempts=0, retry_at=NULL,
             dirty_reasons = CASE
               WHEN merged.reasons ? 'FULL'
                 OR jsonb_array_length(merged.participants) > 1000
                 OR jsonb_array_length(merged.powerups) > 64
                 THEN CASE
                   WHEN merged.reasons ? 'EFFECT_BOUNDARY'
                     THEN '["FULL","EFFECT_BOUNDARY"]'::jsonb
                   ELSE '["FULL"]'::jsonb
                 END
               ELSE merged.reasons END,
             dirty_participant_ids = CASE
               WHEN merged.reasons ? 'FULL'
                 OR jsonb_array_length(merged.participants) > 1000
                 OR jsonb_array_length(merged.powerups) > 64
                 THEN '[]'::jsonb
               ELSE merged.participants END,
             dirty_powerup_types = CASE
               WHEN merged.reasons ? 'FULL'
                 OR jsonb_array_length(merged.participants) > 1000
                 OR jsonb_array_length(merged.powerups) > 64
                 THEN CASE
                   WHEN merged.reasons ? 'EFFECT_BOUNDARY'
                     AND merged.powerups ? 'UMBRELLA'
                     THEN '["UMBRELLA"]'::jsonb
                   ELSE '[]'::jsonb
                 END
               ELSE merged.powerups END,
             dirty_priority='COALESCE',
             processing_dirty_reasons='[]'::jsonb,
             processing_dirty_participant_ids='[]'::jsonb,
             processing_dirty_powerup_types='[]'::jsonb,
             processing_dirty_priority='IMMEDIATE',
             triggered_by_user_ids = merged.triggers,
             processing_triggered_by_user_ids='[]'::jsonb,
             lease_expires_at=NULL, lease_token=NULL, updated_at=$3
         FROM merged
         WHERE job.id=merged.id
         RETURNING job.id`,
        id,
        leaseToken,
        now
      );
      return { applied: rows.length === 1 };
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

    async findByRaceIds(raceIds, tx = prisma) {
      const ids = [...new Set(raceIds || [])].filter(Boolean).sort();
      if (ids.length === 0) return [];
      const rows = await tx.$queryRawUnsafe(
        `SELECT ${jobColumns()} FROM race_resolution_jobs_v2
         WHERE race_id = ANY($1::text[]) ORDER BY race_id`,
        ids
      );
      return rows.map(normalizeRow);
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

    // One once-per-minute aggregate probe using the exact claimNext predicate.
    // The existing state/deadline indexes remain usable and no hot-path query is
    // added. Oldest request age is retained separately for continuity.
    async queueServiceSnapshot(now = new Date()) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT
           COALESCE(MAX(EXTRACT(EPOCH FROM ($1::timestamp-requested_at))*1000)
             FILTER (WHERE state IN ('queued','running')), 0)::float8 AS "oldestRequestAgeMs",
           COUNT(*) FILTER (WHERE
             (state='queued' AND (retry_at IS NULL OR retry_at <= $1)
              AND (not_before_at IS NULL OR not_before_at <= $1))
             OR (state='running' AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= $1))::int AS "claimableCount",
           COALESCE(MAX(EXTRACT(EPOCH FROM ($1::timestamp-requested_at))*1000)
             FILTER (WHERE
               (state='queued' AND (retry_at IS NULL OR retry_at <= $1)
                AND (not_before_at IS NULL OR not_before_at <= $1))
               OR (state='running' AND lease_expires_at IS NOT NULL
                   AND lease_expires_at <= $1)), 0)::float8 AS "oldestClaimableAgeMs",
           COUNT(*) FILTER (WHERE state='running')::int AS "runningCount"
         FROM race_resolution_jobs_v2
         WHERE state IN ('queued','running')`,
        now
      );
      const row = rows[0] || {};
      const safeMs = (value) => {
        const numeric = Number(value || 0);
        return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
      };
      return {
        oldestRequestAgeMs: safeMs(row.oldestRequestAgeMs),
        claimableCount: Math.max(0, Number(row.claimableCount || 0)),
        oldestClaimableAgeMs: safeMs(row.oldestClaimableAgeMs),
        runningCount: Math.max(0, Number(row.runningCount || 0)),
      };
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
