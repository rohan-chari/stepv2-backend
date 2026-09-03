const { prisma: defaultPrisma } = require("../../../db");
const { StepSample: defaultStepSampleModel } = require("../models/stepSample");
const {
  RaceResolutionJobV2: defaultRaceResolutionJobModel,
} = require("../../races/models/raceResolutionJobV2");
const {
  lockScoringInputState,
  readCanonicalSampleInput,
  scoringBoundaryIsSafe,
  persistScoringInputState,
} = require("./scoringInputVersion");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const {
  PARTICIPANT_CAP,
} = require("../../races/services/raceResolutionReasonRegistry");
const {
  recordStepTelemetryPhase,
  measureStepTelemetryPhase,
  markStepTelemetryTransactionError,
} = require("../../../shared/observability/stepTelemetryContext");

function generationsEqual(left, right) {
  if (left == null || right == null) return false;
  return BigInt(left) === BigInt(right);
}

function resultingGeneration(state, scoringChanged) {
  const current = state?.generation == null ? 1n : BigInt(state.generation);
  return scoringChanged && state?.inserted !== true ? current + 1n : current;
}

// Participant-scoped queue envelopes are intentionally capped. A race whose
// immutable advertised capacity can exceed that cap is guaranteed to degrade
// to FULL once enough distinct uploads arrive, so doing it on the first upload
// avoids serially growing and re-aggregating a hot JSON array on the one
// race-keyed queue row. FULL is the same conservative correctness contract the
// queue already uses after the cap: the worker recomputes every participant.
function buildStepInputDirtyEnvelope({
  userId,
  participantId = null,
  maxParticipants = undefined,
}) {
  const requiresFullScope = maxParticipants === null ||
    (Number.isFinite(Number(maxParticipants)) &&
      Number(maxParticipants) > PARTICIPANT_CAP);
  if (requiresFullScope) {
    return {
      reason: "FULL",
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "COALESCE",
    };
  }
  return {
    reason: "STEP_INPUT_CHANGED",
    dirtyUserIds: [userId],
    dirtyParticipantIds: participantId ? [participantId] : [],
    powerupTypes: [],
    priority: participantId ? "COALESCE" : "IMMEDIATE",
  };
}

async function upsertDailyStep(tx, { userId, date, steps }) {
  // The per-user scoring fence is already held by the caller, so the prior
  // row seen here is authoritative. Classify create/update and persist the
  // value in one statement instead of a read followed by a Prisma upsert.
  let rows = await tx.$queryRawUnsafe(
    `WITH prior AS (
       SELECT EXISTS(
         SELECT 1 FROM steps WHERE user_id=$1 AND date=$2::date
       ) AS existed
     ), persisted AS (
       INSERT INTO steps (id,user_id,date,steps,step_goal,created_at)
       VALUES (gen_random_uuid()::text,$1,$2::date,$3,NULL,CURRENT_TIMESTAMP)
       ON CONFLICT (user_id,date) DO UPDATE SET steps=EXCLUDED.steps
         WHERE steps.steps IS DISTINCT FROM EXCLUDED.steps
       RETURNING id,user_id AS "userId",steps,step_goal AS "stepGoal",
                 date,created_at AS "createdAt"
     )
     SELECT persisted.*,prior.existed,TRUE AS "storageChanged"
       FROM persisted CROSS JOIN prior`,
    userId,
    new Date(date),
    Number(steps),
  );
  // PostgreSQL returns no row when the conflict value is identical. That is
  // the uncommon no-op path and can afford its own read; changed launch-wave
  // writes retain the single short UPSERT statement.
  if (rows.length === 0) {
    rows = await tx.$queryRawUnsafe(
      `SELECT id,user_id AS "userId",steps,step_goal AS "stepGoal",
              date,created_at AS "createdAt",TRUE AS existed,
              FALSE AS "storageChanged"
         FROM steps WHERE user_id=$1 AND date=$2::date`,
      userId,
      new Date(date),
    );
  }
  const { existed, storageChanged, ...record } = rows[0];
  return {
    record,
    existed: existed === true,
    storageChanged: storageChanged === true,
  };
}

function buildStepInputIntake(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const stepSampleModel = dependencies.StepSample || defaultStepSampleModel;
  const raceResolutionJobModel =
    dependencies.RaceResolutionJobV2 || defaultRaceResolutionJobModel;
  const now = dependencies.now || (() => new Date());

  async function runOn(tx, {
    userId,
    daily = null,
    samples = null,
    timeZone = "UTC",
    requestTimestamp = now(),
    burstCoalescing = true,
    queuedGenerationMerge = true,
  }) {
    if (!userId) throw new TypeError("step input intake requires userId");
    if (!daily && !Array.isArray(samples)) {
      throw new TypeError("step input intake requires daily and/or samples");
    }

    const scoringState = await measureStepTelemetryPhase(
      "scoring_state",
      () => lockScoringInputState(tx, userId),
    );
    let dailyExisted = false;
    let record = null;
    let dailyStorageChanged = false;
    if (daily) {
      const persistedDaily = await measureStepTelemetryPhase(
        "daily",
        () => upsertDailyStep(tx, { userId, ...daily }),
      );
      record = persistedDaily.record;
      dailyExisted = persistedDaily.existed;
      dailyStorageChanged = persistedDaily.storageChanged;
    }

    let samplePersistence = { storageChanged: false, scoringChanged: false };
    if (Array.isArray(samples) && samples.length > 0) {
      samplePersistence = await measureStepTelemetryPhase(
        "sample",
        () => stepSampleModel.reconcileBatchOn(
          tx,
          userId,
          samples,
          new Date(requestTimestamp).getTime(),
          { noopSuppression: true, manageScoringVersion: false, returnCanonicalInput: true },
        ),
      );
    }
    const canonicalInput = samplePersistence.canonicalInput || await measureStepTelemetryPhase(
      "sample", () => readCanonicalSampleInput(tx, userId),
    );
    const decisionState = { ...scoringState, dbNow: canonicalInput.dbNow };
    const sampleScoringChanged =
      !scoringBoundaryIsSafe(decisionState) ||
      scoringState.scoringWatermark !== canonicalInput.scoringWatermark;
    const scoringChanged = dailyStorageChanged || sampleScoringChanged;
    const storageChanged =
      dailyStorageChanged ||
      samplePersistence.storageChanged === true;

    const generation = resultingGeneration(scoringState, scoringChanged);
    const repairRequired = !generationsEqual(
      scoringState.sourceQueueSemanticsGeneration,
      generation
    );

    let jobs = [];
    let activeRaceCount = 0;
    let hasFullScopeResolutionWork = false;
    if (scoringChanged || repairRequired) {
      const races = await measureStepTelemetryPhase("active_race", () => tx.$queryRawUnsafe(
        `SELECT race.id AS "raceId",participant.id AS "participantId",
                race.max_participants AS "maxParticipants"
           FROM races race
           JOIN race_participants participant ON participant.race_id=race.id
          WHERE race.status='active' AND participant.user_id=$1 AND participant.status='accepted'
          ORDER BY race.id`,
        userId,
      ));
      activeRaceCount = races.length;
      const dirtyEnvelopeByRaceId = new Map();
      const largeRaceScopeByRaceId = new Map();
      for (const race of races) {
        const dirtyEnvelope = buildStepInputDirtyEnvelope({
          userId,
          participantId: race.participantId,
          maxParticipants: race.maxParticipants,
        });
        dirtyEnvelopeByRaceId.set(race.raceId, dirtyEnvelope);
        if (dirtyEnvelope.reason === "FULL") hasFullScopeResolutionWork = true;
        if (Number(race.maxParticipants) > PARTICIPANT_CAP && race.participantId) {
          largeRaceScopeByRaceId.set(race.raceId, {
            userId,
            participantId: race.participantId,
          });
        }
      }
      jobs = await measureStepTelemetryPhase(
        "durable_enqueue",
        () => raceResolutionJobModel.enqueueMany(
          {
            raceIds: races.map((race) => race.raceId),
            userId,
            resolutionTimeZone: timeZone,
            now: new Date(requestTimestamp),
            dirtyEnvelopeByRaceId,
            largeRaceScopeByRaceId,
            burstCoalescing,
            queuedGenerationMerge,
            queuePriority: "MAINTENANCE",
          },
          tx,
        ),
      );
    }

    // The generation, canonical watermark, and durable-queue ownership fence
    // become visible atomically. Keeping them in one UPDATE removes a second
    // database round trip from every accepted launch-wave upload.
    await measureStepTelemetryPhase(
      "scoring_generation",
      () => persistScoringInputState(
        tx,
        userId,
        scoringState,
        canonicalInput,
        scoringChanged,
        (scoringChanged || repairRequired)
          ? { sourceQueueSemanticsGeneration: generation }
          : undefined,
      ),
    );

    // Reuse the transaction's already-checked-out connection for this tiny
    // durability stamp. Performing it after commit required a second pool
    // checkout per successful upload; under a launch wave that wait dominated
    // the otherwise sub-millisecond update and held the admission permit open.
    await tx.$executeRawUnsafe(
      `UPDATE users
          SET last_step_sync_at = GREATEST(
            COALESCE(last_step_sync_at, '-infinity'::timestamptz),
            $2::timestamptz
          )
        WHERE id=$1`,
      userId,
      requestTimestamp,
    );

    return {
      record,
      dailyExisted,
      storageChanged,
      scoringChanged,
      repairRequired,
      generation,
      canonicalCoverageThrough: canonicalInput.canonicalCoverageThrough,
      completedAt: canonicalInput.dbNow,
      jobs,
      activeRaceCount,
      hasFullScopeResolutionWork,
      lastStepSyncStamped: true,
    };
  }

  return async function stepInputIntake(input, tx = null) {
    // Keep the established capacity-telemetry surface name stable. The
    // implementation beneath it is now the single canonical intake path, but
    // existing dashboards and evidence tests still consume this identifier.
    const capacity = startCapacityPhase("uploader_reconciliation");
    const endpoint = input?.endpoint || "unknown";
    let outcome = "transaction_error";
    try {
      const result = tx
        ? await runOn(tx, input)
        : await (async () => {
            const startedAt = process.hrtime.bigint();
            try {
              return await prisma.$transaction((client) => runOn(client, input), {
                timeout: 15_000,
                maxWait: 10_000,
              });
            } catch (error) {
              markStepTelemetryTransactionError(error);
              throw error;
            } finally {
              recordStepTelemetryPhase(
                "transaction_total",
                Number(process.hrtime.bigint() - startedAt) / 1e6,
              );
            }
          })();
      outcome = result.scoringChanged ? "changed" : "scoring_noop";
      capacity.setCounts({
        enqueueRaceCount: result.activeRaceCount,
        storageChanged: result.storageChanged ? 1 : 0,
        scoringChanged: result.scoringChanged ? 1 : 0,
        repairRequired: result.repairRequired ? 1 : 0,
      });
      return result;
    } finally {
      capacity.setDimensions({ endpoint, sourceOutcome: outcome });
      capacity.finish(outcome === "transaction_error" ? "error" : "success");
    }
  };
}

const stepInputIntake = buildStepInputIntake();

module.exports = {
  buildStepInputDirtyEnvelope,
  buildStepInputIntake,
  stepInputIntake,
  generationsEqual,
  upsertDailyStep,
};
