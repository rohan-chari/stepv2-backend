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
const QUEUE_PRIORITIES = Object.freeze([
  "SETTLEMENT",
  "RECOVERY",
  "LIVE",
  "MAINTENANCE",
]);
const DEFAULT_DEBOUNCE_MS = 5000;
// At the measured 140 uploads/s surge, one five-second window stays below the
// planner's bounded 1,000-row envelope. Coalescing the whole window prevents
// several overlapping partial resolutions from competing with launch reads.
// Viewer totals remain immediate because Home overlays the persisted row.
const LARGE_SCOPED_DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
const DEFAULT_RECOVERY_STALE_MS = 60 * 60 * 1000;
const FULL_TRIGGER_PROMOTION_BATCH_SIZE = 500;
const {
  normalizeDirtyEnvelope,
  DIRTY_REASONS,
  POWERUP_SCOPE_BY_TYPE,
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

function normalizeQueuePriority(value) {
  return QUEUE_PRIORITIES.includes(value) ? value : "LIVE";
}

// Shared by the parallel read fast path and the upsert's conflict-row guard.
// Only pending pure display work can cover a request. Processing-only viewer
// scope is deliberately excluded: an in-flight snapshot may predate this GET.
// Source/mixed reasons always retain the existing enqueue/generation behavior.
function displayRefreshCoveredSql(job, incoming) {
  return `(
    ${incoming}.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb
    AND ${job}.dirty_reasons = '["DISPLAY_REFRESH"]'::jsonb
    AND NOT ${job}.full_trigger_seed_only
    AND (
      (${job}.state = 'queued'::"RaceResolutionJobState"
        AND (${job}.lease_expires_at IS NULL OR ${job}.lease_expires_at <= $2::timestamp)
        AND (${job}.processing_generation IS NULL OR ${job}.processing_generation < ${job}.generation))
      OR (${job}.state = 'running'::"RaceResolutionJobState"
        AND ${job}.processing_generation IS NOT NULL
        AND ${job}.generation > ${job}.processing_generation)
    )
    AND ${job}.resolution_time_zone IS NOT DISTINCT FROM ${incoming}.resolution_time_zone
    AND ${job}.display_artifact_id IS NOT DISTINCT FROM ${incoming}.display_artifact_id
    AND ${job}.display_artifact_digest IS NOT DISTINCT FROM ${incoming}.display_artifact_digest
    AND ${job}.display_artifact_schema IS NOT DISTINCT FROM ${incoming}.display_artifact_schema
    AND jsonb_typeof(${job}.triggered_by_user_ids) = 'array'
    AND NOT jsonb_path_exists(${job}.triggered_by_user_ids, '$[*] ? (@.type() != "string" || @ == "")')
    AND ${job}.triggered_by_user_ids @> ${incoming}.triggered_by_user_ids
    AND ${job}.dirty_participant_ids = ${incoming}.dirty_participant_ids
    AND ${job}.dirty_powerup_types = ${incoming}.dirty_powerup_types
  )`;
}

function mergeClaimDirty(locked, promotedProcessingReasons = null) {
  const stable = (left, right, cap) => {
    const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
    if (values.some((value) => typeof value !== "string" || !value)) return null;
    const merged = [...new Set(values)];
    return merged.length <= cap ? merged : null;
  };
  let processingReasons = stable(
    locked.processingDirtyReasons,
    promotedProcessingReasons,
    DIRTY_REASONS.size
  );
  if (processingReasons?.includes("STEP_INPUT_CHANGED")) {
    processingReasons = processingReasons.filter((reason) => reason !== "STEP_SYNC");
  }
  const reasons = stable(processingReasons, locked.dirtyReasons, DIRTY_REASONS.size);
  const dirtyUserIds = stable(locked.processingTriggeredByUserIds, locked.triggeredByUserIds, 1000);
  const dirtyParticipantIds = stable(locked.processingDirtyParticipantIds, locked.dirtyParticipantIds, 1000);
  const powerupTypes = stable(locked.processingDirtyPowerupTypes, locked.dirtyPowerupTypes, 64);
  const invalid = !reasons || reasons.length === 0 ||
    reasons.includes("FULL") || reasons.some((reason) => !DIRTY_REASONS.has(reason)) ||
    !dirtyUserIds || !dirtyParticipantIds || !powerupTypes ||
    powerupTypes.some((type) => !POWERUP_SCOPE_BY_TYPE[type]);
  if (invalid) {
    const boundaryReasons = [
      ...(reasons?.includes("EFFECT_BOUNDARY") ? ["EFFECT_BOUNDARY"] : []),
      ...(reasons?.includes("GLOBAL_EVENT_BOUNDARY") ? ["GLOBAL_EVENT_BOUNDARY"] : []),
    ];
    return {
      reasons: ["FULL", ...boundaryReasons],
      dirtyUserIds: [], dirtyParticipantIds: [], powerupTypes: [], priority: "IMMEDIATE",
    };
  }
  return {
    reasons, dirtyUserIds, dirtyParticipantIds, powerupTypes,
    priority: locked.processingDirtyPriority === "IMMEDIATE" ||
      locked.dirtyPriority === "IMMEDIATE" ? "IMMEDIATE" : "COALESCE",
  };
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
  ${q}full_trigger_seed_only              AS "fullTriggerSeedOnly",
  ${q}queue_priority                      AS "queuePriority",
  ${q}processing_dirty_reasons            AS "processingDirtyReasons",
  ${q}processing_dirty_participant_ids    AS "processingDirtyParticipantIds",
  ${q}processing_dirty_powerup_types      AS "processingDirtyPowerupTypes",
  ${q}processing_dirty_priority           AS "processingDirtyPriority",
  ${q}processing_queue_priority           AS "processingQueuePriority",
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
    queuePriority: normalizeQueuePriority(row.queuePriority),
    processingDirtyReasons: Array.isArray(row.processingDirtyReasons)
      ? row.processingDirtyReasons
      : [],
    processingDirtyParticipantIds: Array.isArray(row.processingDirtyParticipantIds)
      ? row.processingDirtyParticipantIds
      : [],
    processingDirtyPowerupTypes: Array.isArray(row.processingDirtyPowerupTypes)
      ? row.processingDirtyPowerupTypes
      : [],
    processingQueuePriority: normalizeQueuePriority(row.processingQueuePriority),
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
        queuePriority = "LIVE",
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
          queuePriority,
        },
        tx
      );
      return row || null;
    },

    // Large races use an append-only intake handoff. Every source transaction
    // owns a different UUID row, so 10,000 simultaneous uploads do not queue
    // behind one mutable race job. The first uploader seeds the normal job;
    // the dedicated resolution process folds all committed trigger rows into
    // that job in bounded pages before claiming work.
    async enqueueFullScopeTrigger(
      {
        raceId,
        resolutionTimeZone = null,
        now = new Date(),
        burstCoalescing = false,
        queuePriority = "MAINTENANCE",
        scope = null,
      },
      tx = prisma,
    ) {
      const [row] = await this.enqueueFullScopeTriggers({
        entries: [{ raceId, resolutionTimeZone, queuePriority, scope }],
        now,
        burstCoalescing,
      }, tx);
      return row || null;
    },

    async enqueueFullScopeTriggers(
      { entries, now = new Date(), burstCoalescing = false },
      tx = prisma,
    ) {
      const ordered = [...new Map((entries || [])
        .filter((entry) => entry?.raceId)
        .map((entry) => [entry.raceId, entry])).values()]
        .sort((a, b) => String(a.raceId).localeCompare(String(b.raceId)));
      const results = [];
      // Bound statement payloads for non-HTTP callers too. Pages retain global
      // ascending race order, including when a transaction holds earlier locks.
      const batchSize = 250;
      for (let offset = 0; offset < ordered.length; offset += batchSize) {
        const batch = ordered.slice(offset, offset + batchSize).map((entry) => ({
          raceId: entry.raceId,
          userId: entry.scope?.userId || null,
          participantId: entry.scope?.participantId || null,
          resolutionTimeZone: entry.resolutionTimeZone || null,
          queuePriority: normalizeQueuePriority(entry.queuePriority || "MAINTENANCE"),
          seedOnly: Boolean(entry.scope?.userId && entry.scope?.participantId),
          notBeforeAt: burstCoalescing
            ? new Date(now.getTime() + (entry.scope?.userId && entry.scope?.participantId
              ? LARGE_SCOPED_DEBOUNCE_MS : DEFAULT_DEBOUNCE_MS)).toISOString()
            : null,
        }));
        await tx.$executeRawUnsafe(
          `INSERT INTO race_resolution_full_triggers (
             id,race_id,user_id,participant_id,resolution_time_zone,requested_at,created_at
           ) SELECT gen_random_uuid(),i."raceId",i."userId",i."participantId",
                    i."resolutionTimeZone",$2::timestamp,$2::timestamp
             FROM jsonb_to_recordset($1::jsonb) AS i(
               "raceId" text,"userId" text,"participantId" text,"resolutionTimeZone" text
             ) ORDER BY i."raceId"`,
          JSON.stringify(batch), now,
        );
        // The trigger is the durable handoff. Do not upsert already-active jobs:
        // even DO NOTHING would wait behind a worker holding their row locks.
        const existing = await tx.$queryRawUnsafe(
          `SELECT ${jobColumns()} FROM race_resolution_jobs_v2 WHERE race_id=ANY($1::text[])`,
          batch.map((entry) => entry.raceId),
        );
        const byRaceId = new Map(existing.map((row) => [row.raceId, row]));
        const inactive = batch.filter((entry) =>
          !["queued", "running"].includes(byRaceId.get(entry.raceId)?.state));
        if (inactive.length > 0) {
          // Seed and reactivate in ONE ordered statement. Separate insert and
          // update passes can invert lock order across overlapping race sets.
          // A concurrent uploader may already have activated a row after our
          // read; the conflict predicate preserves that uploader's generation.
          const activated = await tx.$queryRawUnsafe(
            `INSERT INTO race_resolution_jobs_v2 AS job (
               id,race_id,generation,resolution_time_zone,state,attempts,
               requested_at,not_before_at,triggered_by_user_ids,
               processing_triggered_by_user_ids,dirty_reasons,
               dirty_participant_ids,dirty_powerup_types,dirty_priority,
               queue_priority,full_trigger_seed_only,created_at,updated_at
             ) SELECT gen_random_uuid()::text,i."raceId",1,i."resolutionTimeZone",'queued',0,
                      $2::timestamp,i."notBeforeAt",'[]'::jsonb,'[]'::jsonb,'["FULL"]'::jsonb,
                      '[]'::jsonb,'[]'::jsonb,'COALESCE',i."queuePriority",i."seedOnly",
                      $2::timestamp,$2::timestamp
               FROM jsonb_to_recordset($1::jsonb) AS i(
                 "raceId" text,"resolutionTimeZone" text,"notBeforeAt" timestamp,
                 "queuePriority" text,"seedOnly" boolean
               ) ORDER BY i."raceId"
             ON CONFLICT (race_id) DO UPDATE SET
               generation=job.generation+1,
               resolution_time_zone=COALESCE(EXCLUDED.resolution_time_zone,job.resolution_time_zone),
               state='queued',attempts=0,requested_at=EXCLUDED.requested_at,
               not_before_at=EXCLUDED.not_before_at,retry_at=NULL,last_error_code=NULL,
               dirty_reasons='["FULL"]'::jsonb,dirty_participant_ids='[]'::jsonb,
               dirty_powerup_types='[]'::jsonb,dirty_priority='COALESCE',
               queue_priority=EXCLUDED.queue_priority,
               full_trigger_seed_only=EXCLUDED.full_trigger_seed_only,
               triggered_by_user_ids='[]'::jsonb,updated_at=EXCLUDED.updated_at
             WHERE job.state IN ('succeeded','failed')
             RETURNING ${jobColumns()}`,
            JSON.stringify(inactive), now,
          );
          const activatedIds = new Set();
          for (const row of activated) {
            byRaceId.set(row.raceId, row);
            activatedIds.add(row.raceId);
          }
          const racedIds = inactive.filter((entry) => !activatedIds.has(entry.raceId))
            .map((entry) => entry.raceId);
          if (racedIds.length > 0) {
            // READ COMMITTED: see the concurrent winner after the conflict wait.
            const winners = await tx.$queryRawUnsafe(
              `SELECT ${jobColumns()} FROM race_resolution_jobs_v2 WHERE race_id=ANY($1::text[])`,
              racedIds,
            );
            for (const row of winners) byRaceId.set(row.raceId, row);
          }
        }
        results.push(...batch.map((entry) => normalizeRow(byRaceId.get(entry.raceId))));
      }
      return results;
    },

    async promoteFullScopeTriggers({
      now = new Date(),
      batchSize = FULL_TRIGGER_PROMOTION_BATCH_SIZE,
    } = {}) {
      const limit = Math.min(
        FULL_TRIGGER_PROMOTION_BATCH_SIZE,
        Math.max(1, Number(batchSize) || FULL_TRIGGER_PROMOTION_BATCH_SIZE),
      );
      const claimFloor = new Date(now.getTime() + debounceMs());
      const scopedClaimFloor = new Date(
        now.getTime() + LARGE_SCOPED_DEBOUNCE_MS,
      );
      return prisma.$transaction(async (tx) => {
        // Defensive mixed-version recovery: a trigger may outlive an old job
        // row deleted by repair tooling. Seed its ordinary queue destination
        // before the atomic promotion/deletion statement.
        await tx.$executeRawUnsafe(
          `WITH candidate_races AS (
             SELECT trigger.race_id,
                    MIN(trigger.requested_at) AS requested_at,
                    MAX(trigger.resolution_time_zone) AS resolution_time_zone
               FROM (
                 SELECT trigger.race_id,trigger.requested_at,
                        trigger.resolution_time_zone
                   FROM race_resolution_full_triggers trigger
                   JOIN races race ON race.id=trigger.race_id
                  WHERE race.status='active'
                  ORDER BY trigger.requested_at,trigger.id
                  LIMIT $1
               ) trigger
              GROUP BY trigger.race_id
           )
           INSERT INTO race_resolution_jobs_v2 (
             id,race_id,generation,resolution_time_zone,state,attempts,
             requested_at,not_before_at,triggered_by_user_ids,
             processing_triggered_by_user_ids,dirty_reasons,
             dirty_participant_ids,dirty_powerup_types,dirty_priority,
             queue_priority,created_at,updated_at
           )
           SELECT gen_random_uuid()::text,race_id,1,resolution_time_zone,
                  'queued',0,requested_at,$3,'[]'::jsonb,'[]'::jsonb,
                  '["FULL"]'::jsonb,'[]'::jsonb,'[]'::jsonb,
                  'COALESCE','MAINTENANCE',requested_at,$2
             FROM candidate_races
           ON CONFLICT (race_id) DO NOTHING`,
          limit,
          now,
          claimFloor,
        );
        const rows = await tx.$queryRawUnsafe(
          `WITH candidates AS MATERIALIZED (
             SELECT trigger.id,trigger.race_id,trigger.user_id,trigger.participant_id,
                    trigger.resolution_time_zone,trigger.requested_at
               FROM race_resolution_full_triggers trigger
               JOIN race_resolution_jobs_v2 job ON job.race_id=trigger.race_id
               JOIN races race ON race.id=trigger.race_id
              WHERE job.full_trigger_seed_only
                AND race.status='active'
                AND (
                  job.full_trigger_seed_only
                  OR NOT (job.dirty_reasons ? 'STEP_INPUT_CHANGED')
                  OR jsonb_array_length(job.dirty_participant_ids) < 500
                )
               ORDER BY trigger.requested_at,trigger.id
              LIMIT $1
              FOR UPDATE SKIP LOCKED
           ), grouped AS MATERIALIZED (
             SELECT race_id,MIN(requested_at) AS requested_at,
                    MAX(resolution_time_zone) AS resolution_time_zone,
                    COUNT(*)::int AS trigger_count,
                    BOOL_AND(user_id IS NOT NULL AND participant_id IS NOT NULL)
                      AS all_scoped,
                    COUNT(DISTINCT user_id)::int AS scoped_user_count,
                    COUNT(DISTINCT participant_id)::int AS scoped_participant_count,
                    COALESCE(jsonb_agg(DISTINCT to_jsonb(user_id))
                      FILTER (WHERE user_id IS NOT NULL),'[]'::jsonb) AS user_ids,
                    COALESCE(jsonb_agg(DISTINCT to_jsonb(participant_id))
                      FILTER (WHERE participant_id IS NOT NULL),'[]'::jsonb)
                      AS participant_ids
               FROM candidates GROUP BY race_id
           ), scoped AS MATERIALIZED (
             SELECT grouped.*,
                    grouped.all_scoped
                    AND grouped.scoped_user_count <= 1000
                    AND grouped.scoped_participant_count <= 1000
                    AND (
                      job.full_trigger_seed_only
                      OR NOT (job.dirty_reasons ? 'FULL')
                    )
                    AND (
                      SELECT COUNT(DISTINCT value) <= 1000
                        FROM jsonb_array_elements(
                          (CASE WHEN job.full_trigger_seed_only
                            THEN '[]'::jsonb
                            ELSE job.triggered_by_user_ids END) || grouped.user_ids
                        ) merged(value)
                    )
                    AND (
                      SELECT COUNT(DISTINCT value) <= 1000
                        FROM jsonb_array_elements(
                          (CASE WHEN job.full_trigger_seed_only
                            THEN '[]'::jsonb
                            ELSE job.dirty_participant_ids END) || grouped.participant_ids
                        ) merged(value)
                    ) AS can_scope
               FROM grouped
               JOIN race_resolution_jobs_v2 job ON job.race_id=grouped.race_id
           ), promoted AS (
             UPDATE race_resolution_jobs_v2 job
                SET generation=CASE
                      WHEN job.state='running' THEN job.generation+1
                      WHEN job.state='queued' THEN job.generation
                      ELSE job.generation+1 END,
                    resolution_time_zone=COALESCE(scoped.resolution_time_zone,
                                                  job.resolution_time_zone),
                    state=CASE WHEN job.state='running' THEN job.state
                               ELSE 'queued'::"RaceResolutionJobState" END,
                    attempts=CASE WHEN job.state='running' THEN job.attempts ELSE 0 END,
                    requested_at=CASE
                      WHEN job.state IN ('queued','running') THEN job.requested_at
                      ELSE scoped.requested_at END,
                    not_before_at=GREATEST(
                      '-infinity'::timestamp,
                      CASE WHEN job.state='queued'
                                  AND (job.queue_priority='LIVE'
                                    OR job.dirty_reasons ? 'GLOBAL_EVENT_BOUNDARY')
                        THEN COALESCE(job.not_before_at,'-infinity'::timestamp)
                      WHEN scoped.can_scope THEN
                        CASE WHEN job.state='running' THEN $4::timestamp
                             ELSE GREATEST(
                               COALESCE(job.not_before_at,$4::timestamp),
                               $4::timestamp
                             ) END
                      ELSE GREATEST(
                        COALESCE(job.not_before_at,'-infinity'::timestamp),
                        $3::timestamp
                      ) END
                    ),
                    retry_at=NULL,last_error_code=NULL,
                    triggered_by_user_ids=CASE WHEN scoped.can_scope THEN (
                      SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal),'[]'::jsonb)
                        FROM (
                          SELECT value,MIN(ordinality) AS first_ordinal
                            FROM jsonb_array_elements(
                              (CASE WHEN job.full_trigger_seed_only
                                THEN '[]'::jsonb
                                ELSE job.triggered_by_user_ids END) || scoped.user_ids
                            ) WITH ORDINALITY AS merged(value,ordinality)
                           GROUP BY value
                        ) stable
                    ) ELSE '[]'::jsonb END,
                    dirty_reasons=CASE WHEN scoped.can_scope THEN (
                      SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal),'[]'::jsonb)
                        FROM (
                          SELECT value,MIN(ordinality) AS first_ordinal
                            FROM jsonb_array_elements(
                              (CASE WHEN job.full_trigger_seed_only
                                THEN (
                                  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb)
                                    FROM jsonb_array_elements(job.dirty_reasons)
                                      WITH ORDINALITY AS preserved(value,ordinality)
                                   WHERE value IN ('"EFFECT_BOUNDARY"'::jsonb,
                                                   '"GLOBAL_EVENT_BOUNDARY"'::jsonb)
                                )
                                ELSE job.dirty_reasons END) ||
                              '["STEP_INPUT_CHANGED"]'::jsonb
                            ) WITH ORDINALITY AS merged(value,ordinality)
                           WHERE value <> '"STEP_SYNC"'::jsonb
                           GROUP BY value
                        ) stable
                    ) ELSE '["FULL"]'::jsonb
                      || CASE WHEN job.dirty_reasons ? 'EFFECT_BOUNDARY'
                           THEN '["EFFECT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb END
                      || CASE WHEN job.dirty_reasons ? 'GLOBAL_EVENT_BOUNDARY'
                           THEN '["GLOBAL_EVENT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb END
                    END,
                    dirty_participant_ids=CASE WHEN scoped.can_scope THEN (
                      SELECT COALESCE(jsonb_agg(value ORDER BY first_ordinal),'[]'::jsonb)
                        FROM (
                          SELECT value,MIN(ordinality) AS first_ordinal
                            FROM jsonb_array_elements(
                              (CASE WHEN job.full_trigger_seed_only
                                THEN '[]'::jsonb
                                ELSE job.dirty_participant_ids END) ||
                              scoped.participant_ids
                            ) WITH ORDINALITY AS merged(value,ordinality)
                           GROUP BY value
                        ) stable
                    ) ELSE '[]'::jsonb END,
                    dirty_powerup_types=CASE WHEN scoped.can_scope
                      THEN job.dirty_powerup_types
                      WHEN job.dirty_reasons ? 'EFFECT_BOUNDARY'
                           AND job.dirty_powerup_types ? 'UMBRELLA'
                        THEN '["UMBRELLA"]'::jsonb
                      ELSE '[]'::jsonb END,
                    dirty_priority='COALESCE',
                    queue_priority=CASE
                      WHEN job.state='queued' AND job.queue_priority='LIVE'
                        THEN 'LIVE'
                      ELSE 'MAINTENANCE' END,
                    full_trigger_seed_only=false,updated_at=$2
               FROM scoped WHERE job.race_id=scoped.race_id
             RETURNING job.race_id
           ), deleted AS (
             DELETE FROM race_resolution_full_triggers trigger
              USING candidates,promoted
              WHERE trigger.id=candidates.id
                AND candidates.race_id=promoted.race_id
             RETURNING trigger.id
           )
           SELECT (SELECT COUNT(*)::int FROM deleted) AS promoted,
                  (SELECT COUNT(*)::int FROM grouped) AS races`,
          limit,
          now,
          claimFloor,
          scopedClaimFloor,
        );
        return {
          promoted: Number(rows[0]?.promoted || 0),
          races: Number(rows[0]?.races || 0),
        };
      }, { timeout: 15_000, maxWait: 10_000 });
    },

    async cleanupOrphanFullScopeTriggers({
      before = new Date(Date.now() - 24 * 60 * 60 * 1000),
      limit = 500,
    } = {}) {
      const safeLimit = Math.min(500, Math.max(1, Number(limit) || 500));
      const [result = {}] = await prisma.$queryRawUnsafe(
        `WITH candidates AS MATERIALIZED (
           SELECT trigger.id
             FROM race_resolution_full_triggers trigger
             LEFT JOIN races race ON race.id=trigger.race_id
             LEFT JOIN race_resolution_jobs_v2 job ON job.race_id=trigger.race_id
            WHERE trigger.created_at < $1
              AND (
                race.id IS NULL
                OR (
                  race.status <> 'active'
                  AND (job.id IS NULL OR job.state NOT IN ('queued','running'))
                )
              )
            ORDER BY trigger.created_at,trigger.id
            LIMIT $2
            FOR UPDATE OF trigger SKIP LOCKED
         ), deleted AS (
           DELETE FROM race_resolution_full_triggers trigger
            USING candidates
            WHERE trigger.id=candidates.id
           RETURNING trigger.id
         ) SELECT COUNT(*)::int AS deleted FROM deleted`,
        before,
        safeLimit,
      );
      return Number(result.deleted || 0);
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
        largeRaceScopeByRaceId = null,
        triggeredUserIdsByRaceId = null,
        displayArtifactByRaceId = null,
        burstCoalescing = false,
        queuedGenerationMerge = false,
        bypassDebounce = false,
        queuePriority = "LIVE",
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
        const fullScope = dirty?.reasons?.includes("FULL") === true;
        return {
          raceId,
          resolutionTimeZone,
          // FULL already means recompute every participant. Retaining a
          // per-uploader list beside it has no consumer-visible meaning and
          // turns a large shared race into an ever-growing JSON aggregation on
          // the hottest row in the system.
          triggered: fullScope
            ? []
            : triggeredUserIdsByRaceId?.get?.(raceId)
            ? [...new Set(triggeredUserIdsByRaceId.get(raceId).filter((id) => typeof id === "string" && id))].slice(0, 1000)
            : triggered,
          dirtyReasons: dirty?.reasons || [],
          dirtyParticipantIds: dirty?.dirtyParticipantIds || [],
          dirtyPowerupTypes: dirty?.powerupTypes || [],
          dirtyPriority: priority,
          queuePriority: normalizeQueuePriority(queuePriority),
          artifactId: artifact?.id || null,
          artifactDigest: artifact?.digest || null,
          artifactSchema: artifact?.schema || null,
          notBeforeAt:
            burstCoalescing && (
              priority === "COALESCE" || dirty?.reasons?.includes("GLOBAL_EVENT_BOUNDARY")
            )
              ? new Date(now.getTime() + DEFAULT_DEBOUNCE_MS).toISOString()
              : null,
        };
      });

      // Most repeated reads take a shared lock, allowing sibling viewers whose
      // pending scope is already included to proceed in parallel without a row
      // rewrite. A claim/source enqueue cannot cross this coverage check. The
      // same predicate below handles concurrent first-read INSERT conflicts.
      if (bypassDebounce !== true && rowsIn.length === 1 && rowsIn[0].dirtyReasons.length === 1 &&
          rowsIn[0].dirtyReasons[0] === "DISPLAY_REFRESH") {
        const input = rowsIn[0];
        const covered = await tx.$queryRawUnsafe(
          `SELECT ${jobColumns("job.")}
           FROM race_resolution_jobs_v2 job
           CROSS JOIN jsonb_to_record($3::jsonb) AS incoming(
             dirty_reasons jsonb, triggered_by_user_ids jsonb,
             dirty_participant_ids jsonb, dirty_powerup_types jsonb,
             resolution_time_zone text, display_artifact_id text,
             display_artifact_digest text, display_artifact_schema integer
           )
           WHERE job.race_id = $1 AND ${displayRefreshCoveredSql("job", "incoming")}
           FOR SHARE OF job`,
          input.raceId,
          now,
          JSON.stringify({
            dirty_reasons: input.dirtyReasons,
            triggered_by_user_ids: input.triggered,
            dirty_participant_ids: input.dirtyParticipantIds,
            dirty_powerup_types: input.dirtyPowerupTypes,
            resolution_time_zone: input.resolutionTimeZone,
            display_artifact_id: input.artifactId,
            display_artifact_digest: input.artifactDigest,
            display_artifact_schema: input.artifactSchema,
          }),
        );
        if (covered.length === 1) return [normalizeRow(covered[0])];
      }

      if (queuedGenerationMerge === true && rowsIn.some((row) =>
        row.dirtyReasons.includes("FULL"))) {
        const byRaceId = new Map();
        const fullRows = rowsIn.filter((row) => row.dirtyReasons.includes("FULL"));
        const fullJobs = await this.enqueueFullScopeTriggers({
          entries: fullRows.map((row) => ({
            raceId: row.raceId,
            resolutionTimeZone: row.resolutionTimeZone,
            queuePriority: row.queuePriority,
            scope: largeRaceScopeByRaceId?.get?.(row.raceId) || null,
          })),
          now,
          burstCoalescing,
        }, tx);
        fullJobs.forEach((row, index) => byRaceId.set(fullRows[index].raceId, row));
        const ordinaryRaceIds = rowsIn
          .filter((row) => !row.dirtyReasons.includes("FULL"))
          .map((row) => row.raceId);
        if (ordinaryRaceIds.length > 0) {
          const ordinary = await this.enqueueMany({
            raceIds: ordinaryRaceIds,
            userId,
            resolutionTimeZone,
            now,
            dirtyEnvelopeByRaceId,
            largeRaceScopeByRaceId,
            triggeredUserIdsByRaceId,
            displayArtifactByRaceId,
            burstCoalescing,
            queuedGenerationMerge,
            bypassDebounce,
            queuePriority,
          }, tx);
          ordinary.forEach((row, index) => byRaceId.set(ordinaryRaceIds[index], row));
        }
        return ordered.map((raceId) => byRaceId.get(raceId) || null);
      }

      // Once a queued generation already carries FULL, another uploader cannot
      // add scoring scope: FULL means every participant. Share-locking that one
      // row makes the source transaction commit before a worker can claim or
      // refresh it, while allowing all sibling upload transactions to proceed
      // concurrently without rewriting/serializing on the same JSONB row.
      //
      // Keep this optimization to the single-race case. Multi-race requests
      // need the established one-statement ascending lock order; selectively
      // share-locking a subset before updating another subset could invert lock
      // order between two uploaders.
      if (
        queuedGenerationMerge === true &&
        rowsIn.length === 1 &&
        rowsIn[0].dirtyReasons.includes("FULL")
      ) {
        const coveredRows = await tx.$queryRawUnsafe(
          `SELECT ${jobColumns()}
             FROM race_resolution_jobs_v2
            WHERE race_id=$1
              AND dirty_reasons ? 'FULL'
              AND (
                state='queued'::"RaceResolutionJobState"
                OR (
                  state='running'::"RaceResolutionJobState"
                  AND processing_generation IS NOT NULL
                  AND generation > processing_generation
                )
              )
            FOR SHARE`,
          rowsIn[0].raceId,
        );
        if (coveredRows.length === 1) return [normalizeRow(coveredRows[0])];
      }

      const rows = await tx.$queryRawUnsafe(
        `
        INSERT INTO race_resolution_jobs_v2 (
          id, race_id, generation, resolution_time_zone, state, attempts,
          requested_at, not_before_at, triggered_by_user_ids, processing_triggered_by_user_ids,
          dirty_reasons, dirty_participant_ids, dirty_powerup_types, dirty_priority,
          queue_priority,
          display_artifact_id, display_artifact_digest, display_artifact_schema,
          created_at, updated_at
        )
        SELECT
          gen_random_uuid()::text, i."raceId", 1, i."resolutionTimeZone", 'queued', 0,
          $2::timestamp, i."notBeforeAt", i."triggered", '[]'::jsonb,
          i."dirtyReasons", i."dirtyParticipantIds", i."dirtyPowerupTypes", i."dirtyPriority",
          i."queuePriority",
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
          "queuePriority" text,
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
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","STEP_INPUT_CHANGED","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_participant_ids) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_participant_ids, '$[*] ? (@.type() != "string" || @ == "")')
              OR jsonb_typeof(race_resolution_jobs_v2.dirty_powerup_types) IS DISTINCT FROM 'array'
              OR jsonb_path_exists(race_resolution_jobs_v2.dirty_powerup_types, '$[*] ? (@.type() != "string" || @ == "")')
              OR (race_resolution_jobs_v2.dirty_reasons = '[]'::jsonb
                  AND race_resolution_jobs_v2.state NOT IN ('succeeded', 'running'))
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
              THEN '["FULL"]'::jsonb
                || CASE
                     WHEN (race_resolution_jobs_v2.dirty_reasons || EXCLUDED.dirty_reasons) ? 'EFFECT_BOUNDARY'
                       THEN '["EFFECT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb
                   END
                || CASE
                     WHEN (race_resolution_jobs_v2.dirty_reasons || EXCLUDED.dirty_reasons) ? 'GLOBAL_EVENT_BOUNDARY'
                       THEN '["GLOBAL_EVENT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb
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
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","STEP_INPUT_CHANGED","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
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
              OR NOT race_resolution_jobs_v2.dirty_reasons <@ '["DISPLAY_REFRESH","STEP_SYNC","STEP_INPUT_CHANGED","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
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
          queue_priority = CASE
            WHEN race_resolution_jobs_v2.queue_priority = 'SETTLEMENT' OR EXCLUDED.queue_priority = 'SETTLEMENT' THEN 'SETTLEMENT'
            WHEN race_resolution_jobs_v2.queue_priority = 'RECOVERY' OR EXCLUDED.queue_priority = 'RECOVERY' THEN 'RECOVERY'
            WHEN race_resolution_jobs_v2.queue_priority = 'LIVE' OR EXCLUDED.queue_priority = 'LIVE' THEN 'LIVE'
            ELSE 'MAINTENANCE' END,
          not_before_at = CASE
            WHEN $4::boolean THEN NULL
            WHEN EXCLUDED.not_before_at IS NOT NULL
              AND EXCLUDED.dirty_reasons ? 'GLOBAL_EVENT_BOUNDARY'
              THEN GREATEST(
                COALESCE(race_resolution_jobs_v2.not_before_at,'-infinity'::timestamp),
                EXCLUDED.not_before_at
              )
            WHEN EXCLUDED.not_before_at IS NOT NULL
              THEN LEAST(
                COALESCE(race_resolution_jobs_v2.not_before_at,EXCLUDED.not_before_at),
                EXCLUDED.not_before_at
              )
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
        WHERE $4::boolean OR NOT ${displayRefreshCoveredSql("race_resolution_jobs_v2", "EXCLUDED")}
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
      // ON CONFLICT ... WHERE may have found coverage after another first GET
      // won the insert. Return that durable row so the caller still publishes
      // a wakeup (including when the original writer's wakeup was lost).
      const coveredIds = ordered.filter((raceId) => !byRaceId.has(raceId));
      if (coveredIds.length) {
        const covered = await tx.$queryRawUnsafe(
          `SELECT ${jobColumns()} FROM race_resolution_jobs_v2 WHERE race_id = ANY($1::text[])`,
          coveredIds,
        );
        for (const row of covered) {
          const normalized = normalizeRow(row);
          if (normalized) byRaceId.set(normalized.raceId, normalized);
        }
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
      // A targeted HTTP-assisted claim already owns an exact race key. Give
      // PostgreSQL a distinct statement shape so it can use the unique race
      // index instead of planning both queue-wide eligibility branches.
      const candidatePredicate = raceId ? "race_id = $4" : "$4::text IS NULL";
      const candidateOrder = raceId ? "" : `ORDER BY CASE queue_priority
              WHEN 'SETTLEMENT' THEN 0
              WHEN 'RECOVERY' THEN 1
              WHEN 'LIVE' THEN 2
              ELSE 3 END,
              requested_at ASC,
              race_id ASC`;
      const rows = await prisma.$queryRawUnsafe(
        `
        WITH candidate AS (
          SELECT id
          FROM race_resolution_jobs_v2
          WHERE ${candidatePredicate}
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
            ${candidateOrder}
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
                OR NOT (j.processing_dirty_reasons || j.dirty_reasons) <@ '["DISPLAY_REFRESH","STEP_SYNC","STEP_INPUT_CHANGED","POWERUP_MUTATION","BOX_OPEN","JOIN_LEAVE_KICK","FORFEIT_TEAM","RACE_START","EFFECT_BOUNDARY","GLOBAL_EVENT_BOUNDARY","RECOVERY","DAILY_MOVER","FULL"]'::jsonb
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
                THEN '["FULL"]'::jsonb
                  || CASE
                       WHEN (j.processing_dirty_reasons || j.dirty_reasons) ? 'EFFECT_BOUNDARY'
                         THEN '["EFFECT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb
                     END
                  || CASE
                       WHEN (j.processing_dirty_reasons || j.dirty_reasons) ? 'GLOBAL_EVENT_BOUNDARY'
                         THEN '["GLOBAL_EVENT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb
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
            processing_queue_priority = j.queue_priority,
            processing_display_artifact_id = j.display_artifact_id,
            processing_display_artifact_digest = j.display_artifact_digest,
            processing_display_artifact_schema = j.display_artifact_schema,
            triggered_by_user_ids = '[]'::jsonb,
            dirty_reasons = '[]'::jsonb,
            dirty_participant_ids = '[]'::jsonb,
            dirty_powerup_types = '[]'::jsonb,
            dirty_priority = 'COALESCE',
            queue_priority = 'LIVE',
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
            processing_dirty_priority = 'COALESCE',
            processing_queue_priority = 'LIVE',
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
                 THEN '["FULL"]'::jsonb
                   || CASE WHEN merged.reasons ? 'EFFECT_BOUNDARY'
                        THEN '["EFFECT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb END
                   || CASE WHEN merged.reasons ? 'GLOBAL_EVENT_BOUNDARY'
                        THEN '["GLOBAL_EVENT_BOUNDARY"]'::jsonb ELSE '[]'::jsonb END
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
             processing_dirty_priority='COALESCE',
             processing_queue_priority='LIVE',
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

    // A source-input fence can discover a newer generation after computation.
    // Keep the lease, fold every pending reason/scope into this claim, and move
    // processingGeneration forward before the same worker recomputes. This is
    // the same ownership transition as claimNext, without releasing a RUNNING
    // row for another worker to race.
    async refreshClaim({
      id,
      leaseToken,
      processingDirtyReasons = null,
      now = new Date(),
    }) {
      return prisma.$transaction(async (tx) => {
        const locked = await this.acquireForWrite(tx, {
          id,
          expectedLeaseToken: leaseToken,
          now,
        });
        if (!locked || locked.state !== "RUNNING") return null;
        const merged = mergeClaimDirty(locked, processingDirtyReasons);
        const priorityRank = (value) => QUEUE_PRIORITIES.indexOf(
          normalizeQueuePriority(value)
        );
        const processingQueuePriority = priorityRank(locked.queuePriority) <
          priorityRank(locked.processingQueuePriority)
          ? normalizeQueuePriority(locked.queuePriority)
          : normalizeQueuePriority(locked.processingQueuePriority);
        const rows = await tx.$queryRawUnsafe(
          `UPDATE race_resolution_jobs_v2
              SET processing_generation=generation,
                  processing_time_zone=COALESCE(resolution_time_zone, processing_time_zone),
                  processing_triggered_by_user_ids=$3::jsonb,
                  processing_dirty_reasons=$4::jsonb,
                  processing_dirty_participant_ids=$5::jsonb,
                  processing_dirty_powerup_types=$6::jsonb,
                  processing_dirty_priority=$7,
                  processing_queue_priority=$8,
                  processing_display_artifact_id=NULL,
                  processing_display_artifact_digest=NULL,
                  processing_display_artifact_schema=NULL,
                  triggered_by_user_ids='[]'::jsonb,
                  dirty_reasons='[]'::jsonb,
                  dirty_participant_ids='[]'::jsonb,
                  dirty_powerup_types='[]'::jsonb,
                  dirty_priority='COALESCE',
                  display_artifact_id=NULL,
                  display_artifact_digest=NULL,
                  display_artifact_schema=NULL,
                  updated_at=$9
            WHERE id=$1 AND lease_token=$2 AND state='running'
            RETURNING ${jobColumns()}`,
          id,
          leaseToken,
          JSON.stringify(merged.dirtyUserIds),
          JSON.stringify(merged.reasons),
          JSON.stringify(merged.dirtyParticipantIds),
          JSON.stringify(merged.powerupTypes),
          merged.priority,
          processingQueuePriority,
          now
        );
        return normalizeRow(rows[0]);
      }, { timeout: 15_000, maxWait: 10_000 });
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
        // Ensure an INERT row exists to lock. A membership-only C0 acquisition
        // is not a resolution request: generation 0 + SUCCEEDED keeps workers
        // asleep. The first real enqueue advances it to the established
        // generation 1 QUEUED contract; an existing job remains untouched.
        await tx.$queryRawUnsafe(
          `
          INSERT INTO race_resolution_jobs_v2 (
            id, race_id, generation, state, requested_at,
            completed_at, last_completed_at, created_at, updated_at
          )
          VALUES (
            gen_random_uuid()::text, $1, 0,
            'succeeded'::"RaceResolutionJobState", $2,
            $2, $2, $2, $2
          )
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
          generation: true,
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
          // acquireForWrite's generation-zero SUCCEEDED row is only a lock
          // anchor, never a standings result. Recovery must promote it into a
          // real resolution generation without waiting for the stale window.
          if (job.generation === 0) {
            return { raceId, priority: 0, age: 0 };
          }
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

    async nextDueAt() {
      const [row = {}] = await prisma.$queryRawUnsafe(
        `SELECT LEAST(
           (SELECT MIN(GREATEST(COALESCE(not_before_at,clock_timestamp()),
                                COALESCE(retry_at,clock_timestamp())))
              FROM race_resolution_jobs_v2 WHERE state='queued'),
           (SELECT MIN(lease_expires_at)
              FROM race_resolution_jobs_v2 WHERE state='running')
         ) AS "dueAt"`,
      );
      return row.dueAt || null;
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
           COUNT(*) FILTER (WHERE state='running')::int AS "runningCount",
           COUNT(*) FILTER (WHERE state='running' AND lease_expires_at IS NOT NULL
             AND lease_expires_at <= $1)::int AS "expiredRunningCount",
           COUNT(*) FILTER (WHERE queue_priority='SETTLEMENT')::int AS "settlementCount",
           COUNT(*) FILTER (WHERE queue_priority='RECOVERY')::int AS "recoveryCount",
           COUNT(*) FILTER (WHERE queue_priority='LIVE')::int AS "liveCount",
           COUNT(*) FILTER (WHERE queue_priority='MAINTENANCE')::int AS "maintenanceCount"
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
        expiredRunningCount: Math.max(0, Number(row.expiredRunningCount || 0)),
        settlementCount: Math.max(0, Number(row.settlementCount || 0)),
        recoveryCount: Math.max(0, Number(row.recoveryCount || 0)),
        liveCount: Math.max(0, Number(row.liveCount || 0)),
        maintenanceCount: Math.max(0, Number(row.maintenanceCount || 0)),
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
  FULL_TRIGGER_PROMOTION_BATCH_SIZE,
  buildRaceResolutionJobV2Model,
  RaceResolutionJobV2,
  newLeaseToken,
  debounceMs,
  LEASE_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  QUEUE_PRIORITIES,
  normalizeQueuePriority,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECOVERY_STALE_MS,
};
