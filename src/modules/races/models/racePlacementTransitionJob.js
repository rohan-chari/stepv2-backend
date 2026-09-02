const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const LEASE_MS = 30_000;
const DEBOUNCE_MS = 1_000;
const PAGE_SIZE = 250;
const RETRY_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000];

const columns = (q = "") => `
  ${q}id,
  ${q}race_id AS "raceId",
  ${q}requested_generation AS "requestedGeneration",
  ${q}processing_generation AS "processingGeneration",
  ${q}completed_generation AS "completedGeneration",
  ${q}state,
  ${q}requested_at AS "requestedAt",
  ${q}observed_at AS "observedAt",
  ${q}processing_observed_at AS "processingObservedAt",
  ${q}not_before_at AS "notBeforeAt",
  ${q}attempts,
  ${q}retry_at AS "retryAt",
  ${q}started_at AS "startedAt",
  ${q}completed_at AS "completedAt",
  ${q}last_completed_at AS "lastCompletedAt",
  ${q}lease_token AS "leaseToken",
  ${q}lease_expires_at AS "leaseExpiresAt",
  ${q}last_error_code AS "lastErrorCode"
`;

function normalize(row) {
  return row ? {
    ...row,
    state: typeof row.state === "string" ? row.state.toUpperCase() : row.state,
  } : null;
}

function buildRacePlacementTransitionJobModel(prisma = defaultPrisma) {
  return {
    LEASE_MS,
    DEBOUNCE_MS,
    PAGE_SIZE,

    async enqueueCurrentGeneration({
      raceId,
      generation,
      observedAt = new Date(),
      now = observedAt,
    }, tx = prisma) {
      if (!raceId || !Number.isInteger(generation) || generation <= 0) return null;
      const [row] = await tx.$queryRawUnsafe(
        `INSERT INTO race_placement_transition_jobs (
           id, race_id, requested_generation, state, requested_at, observed_at,
           not_before_at, attempts, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, 'queued', $4::timestamp, $3::timestamp,
           $4::timestamp + interval '1 second', 0, $4::timestamp, $4::timestamp
         )
         ON CONFLICT (race_id) DO UPDATE SET
           requested_generation = EXCLUDED.requested_generation,
           state = CASE
             WHEN race_placement_transition_jobs.state = 'running' THEN 'running'::"RacePlacementTransitionJobState"
             ELSE 'queued'::"RacePlacementTransitionJobState"
           END,
           requested_at = CASE
             WHEN race_placement_transition_jobs.state IN ('running','succeeded') THEN EXCLUDED.requested_at
             ELSE race_placement_transition_jobs.requested_at
           END,
           observed_at = EXCLUDED.observed_at,
           not_before_at = EXCLUDED.not_before_at,
           attempts = CASE
             WHEN race_placement_transition_jobs.state = 'running' THEN race_placement_transition_jobs.attempts
             ELSE 0
           END,
           retry_at = CASE
             WHEN race_placement_transition_jobs.state = 'running' THEN race_placement_transition_jobs.retry_at
             ELSE NULL
           END,
           last_error_code = CASE
             WHEN race_placement_transition_jobs.state = 'running' THEN race_placement_transition_jobs.last_error_code
             ELSE NULL
           END,
           completed_at = CASE
             WHEN race_placement_transition_jobs.state = 'running' THEN race_placement_transition_jobs.completed_at
             ELSE NULL
           END,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.requested_generation > race_placement_transition_jobs.requested_generation
         RETURNING ${columns()}`,
        raceId,
        generation,
        observedAt,
        now,
      );
      if (row) return normalize(row);
      const existing = await tx.$queryRawUnsafe(
        `SELECT ${columns()} FROM race_placement_transition_jobs WHERE race_id=$1`,
        raceId,
      );
      return normalize(existing[0]);
    },

    async claimOne({ now = new Date() } = {}) {
      const leaseToken = crypto.randomUUID();
      const rows = await prisma.$transaction((tx) => tx.$queryRawUnsafe(
        `WITH candidate AS (
           SELECT p.id
             FROM race_placement_transition_jobs p
             JOIN race_resolution_jobs_v2 r ON r.race_id=p.race_id
            WHERE (
                    (p.state IN ('queued','retry')
                      AND p.not_before_at <= $1
                      AND (p.retry_at IS NULL OR p.retry_at <= $1))
                 OR (p.state='running' AND p.lease_expires_at <= clock_timestamp())
                  )
              AND p.requested_generation > COALESCE(p.completed_generation, 0)
              AND r.state='succeeded'
              AND r.generation > 0
              AND r.processing_generation=r.generation
              AND r.generation=p.requested_generation
              AND r.last_completed_at IS NOT NULL
            ORDER BY p.requested_at, p.race_id
            LIMIT 1
            FOR UPDATE OF p SKIP LOCKED
         )
         UPDATE race_placement_transition_jobs p
            SET state='running',
                processing_generation=p.requested_generation,
                processing_observed_at=p.observed_at,
                started_at=$1,
                lease_token=$2,
                lease_expires_at=clock_timestamp() + interval '30 seconds',
                attempts=p.attempts+1,
                updated_at=$1
           FROM candidate
          WHERE p.id=candidate.id
         RETURNING ${columns("p.")}`,
        now,
        leaseToken,
      ));
      return normalize(rows[0]);
    },

    async nextDueAt() {
      const [row = {}] = await prisma.$queryRawUnsafe(
        `SELECT LEAST(
           (SELECT MIN(GREATEST(p.not_before_at,COALESCE(p.retry_at,'-infinity'::timestamp)))
              FROM race_placement_transition_jobs p
              JOIN race_resolution_jobs_v2 r ON r.race_id=p.race_id
             WHERE p.state IN ('queued','retry')
               AND p.requested_generation > COALESCE(p.completed_generation,0)
               AND r.state='succeeded'
               AND r.generation > 0
               AND r.processing_generation=r.generation
               AND r.generation=p.requested_generation
               AND r.last_completed_at IS NOT NULL),
           (SELECT MIN(p.lease_expires_at)
              FROM race_placement_transition_jobs p
              JOIN race_resolution_jobs_v2 r ON r.race_id=p.race_id
             WHERE p.state='running'
               AND p.requested_generation > COALESCE(p.completed_generation,0)
               AND r.state='succeeded'
               AND r.generation > 0
               AND r.processing_generation=r.generation
               AND r.generation=p.requested_generation
               AND r.last_completed_at IS NOT NULL)
         ) AS "dueAt"`,
      );
      return row.dueAt || null;
    },

    async lockOwned(tx, { id, leaseToken, processingGeneration }) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT ${columns("p.")}
           FROM race_placement_transition_jobs p
          WHERE p.id=$1::uuid
            AND p.state='running'
            AND p.lease_token=$2
            AND p.processing_generation=$3
            AND p.lease_expires_at > clock_timestamp()
          FOR UPDATE`,
        id,
        leaseToken,
        processingGeneration,
      );
      return normalize(rows[0]);
    },

    async markSucceeded(tx, { id, leaseToken, processingGeneration, now }) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE race_placement_transition_jobs
            SET state='succeeded', completed_generation=$3,
                processing_generation=NULL, processing_observed_at=NULL,
                completed_at=$4, last_completed_at=$4,
                lease_token=NULL, lease_expires_at=NULL, retry_at=NULL,
                last_error_code=NULL, updated_at=$4
          WHERE id=$1::uuid AND state='running' AND lease_token=$2
            AND processing_generation=$3 AND requested_generation=$3
            AND lease_expires_at > clock_timestamp()
         RETURNING ${columns()}`,
        id,
        leaseToken,
        processingGeneration,
        now,
      );
      return normalize(rows[0]);
    },

    async requeueSuperseded(tx, { id, leaseToken, processingGeneration, now }) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE race_placement_transition_jobs
            SET state='queued', processing_generation=NULL,
                processing_observed_at=NULL, lease_token=NULL,
                lease_expires_at=NULL, retry_at=NULL, attempts=0,
                last_error_code=NULL, updated_at=$4
          WHERE id=$1::uuid AND state='running' AND lease_token=$2
            AND processing_generation=$3
            AND lease_expires_at > clock_timestamp()
         RETURNING ${columns()}`,
        id,
        leaseToken,
        processingGeneration,
        now,
      );
      return normalize(rows[0]);
    },

    async recordFailure({ id, leaseToken, processingGeneration, attempts, errorCode, now = new Date() }) {
      const index = Math.min(Math.max(1, Number(attempts) || 1) - 1, RETRY_BACKOFF_MS.length - 1);
      const retryAt = new Date(now.getTime() + RETRY_BACKOFF_MS[index]);
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE race_placement_transition_jobs
            SET state='retry', processing_generation=NULL,
                processing_observed_at=NULL, lease_token=NULL,
                lease_expires_at=NULL, retry_at=$4, last_error_code=$5,
                updated_at=$6
          WHERE id=$1::uuid AND state='running' AND lease_token=$2
            AND processing_generation=$3
            AND lease_expires_at > clock_timestamp()
         RETURNING ${columns()}`,
        id,
        leaseToken,
        processingGeneration,
        retryAt,
        String(errorCode || "PLACEMENT_WORKER_ERROR").slice(0, 128),
        now,
      );
      return normalize(rows[0]);
    },

    async recoverSucceededGenerations({ raceIds, now = new Date() }, tx = prisma) {
      const selected = [...new Set((raceIds || []).filter(Boolean))].sort().slice(0, 100);
      if (!selected.length) return { placementJobs: 0, resolutionJobs: 0 };
      const rows = await tx.raceResolutionJobV2.findMany({
        where: { raceId: { in: selected } },
        select: {
          raceId: true, generation: true, processingGeneration: true,
          state: true, lastCompletedAt: true,
        },
        orderBy: { raceId: "asc" },
      });
      let placementJobs = 0;
      let resolutionJobs = 0;
      for (const row of rows) {
        if (row.generation > 0 && row.processingGeneration === row.generation &&
            row.state === "SUCCEEDED" && row.lastCompletedAt) {
          await this.enqueueCurrentGeneration({
            raceId: row.raceId,
            generation: row.generation,
            observedAt: row.lastCompletedAt,
            now,
          }, tx);
          placementJobs += 1;
        } else if (row.generation === 0) {
          resolutionJobs += 1;
        }
      }
      return { placementJobs, resolutionJobs };
    },

    async findMissingHandoffRaceIds({ raceIds, limit = 2 }) {
      const selected = [...new Set((raceIds || []).filter(Boolean))];
      if (!selected.length) return [];
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 2));
      const rows = await prisma.$queryRawUnsafe(
        `SELECT resolution.race_id AS "raceId"
           FROM race_resolution_jobs_v2 resolution
           LEFT JOIN race_placement_transition_jobs placement
             ON placement.race_id=resolution.race_id
          WHERE resolution.race_id = ANY($1::text[])
            AND resolution.state='succeeded'
            AND resolution.generation > 0
            AND resolution.processing_generation=resolution.generation
            AND resolution.last_completed_at IS NOT NULL
            AND (placement.race_id IS NULL OR
                 placement.requested_generation < resolution.generation)
          ORDER BY resolution.race_id
          LIMIT $2`,
        selected,
        safeLimit,
      );
      return rows.map((row) => row.raceId);
    },

    async catchUpActiveSucceededPage({ afterRaceId = null, limit = 100, now = new Date() } = {}) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
      const rows = await prisma.$queryRawUnsafe(
        `SELECT resolution.race_id AS "raceId",
                resolution.generation,
                resolution.last_completed_at AS "lastCompletedAt"
           FROM race_resolution_jobs_v2 resolution
           JOIN races race ON race.id=resolution.race_id
           LEFT JOIN race_placement_transition_jobs placement
             ON placement.race_id=resolution.race_id
          WHERE race.status='active'
            AND ($1::text IS NULL OR resolution.race_id > $1)
            AND resolution.generation > 0
            AND resolution.processing_generation=resolution.generation
            AND resolution.state='succeeded'
            AND resolution.last_completed_at IS NOT NULL
            AND (placement.race_id IS NULL OR
                 placement.requested_generation < resolution.generation)
          ORDER BY resolution.race_id
          LIMIT $2`,
        afterRaceId,
        safeLimit,
      );
      for (const row of rows) {
        await this.enqueueCurrentGeneration({
          raceId: row.raceId,
          generation: row.generation,
          observedAt: row.lastCompletedAt,
          now,
        });
      }
      return {
        count: rows.length,
        nextCursor: rows.length ? rows[rows.length - 1].raceId : null,
      };
    },
  };
}

const RacePlacementTransitionJob = buildRacePlacementTransitionJobModel();

module.exports = {
  LEASE_MS,
  DEBOUNCE_MS,
  PAGE_SIZE,
  RETRY_BACKOFF_MS,
  buildRacePlacementTransitionJobModel,
  RacePlacementTransitionJob,
};
