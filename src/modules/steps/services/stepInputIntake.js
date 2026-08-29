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
  stampSourceQueueSemanticsGeneration,
} = require("./scoringInputVersion");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
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
    const existingDaily = daily
      ? await measureStepTelemetryPhase("daily", () => tx.step.findUnique({
          where: { userId_date: { userId, date: new Date(daily.date) } },
        }))
      : null;
    const beforeSamples = await measureStepTelemetryPhase(
      "sample",
      () => readCanonicalSampleInput(tx, userId, scoringState.dbNow),
    );

    let record = existingDaily;
    let dailyStorageChanged = false;
    if (daily) {
      dailyStorageChanged =
        !existingDaily || Number(existingDaily.steps) !== Number(daily.steps);
      record = await measureStepTelemetryPhase("daily", () => tx.step.upsert({
        where: {
          userId_date: { userId, date: new Date(daily.date) },
        },
        create: {
          userId,
          date: new Date(daily.date),
          steps: daily.steps,
          stepGoal: null,
        },
        update: { steps: daily.steps },
      }));
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
          { noopSuppression: true, manageScoringVersion: false },
        ),
      );
    }

    const afterSamples = await measureStepTelemetryPhase(
      "sample",
      () => readCanonicalSampleInput(tx, userId),
    );
    const decisionState = { ...scoringState, dbNow: afterSamples.dbNow };
    const sampleScoringChanged =
      !scoringBoundaryIsSafe(decisionState) ||
      scoringState.scoringWatermark !== afterSamples.scoringWatermark;
    const scoringChanged = dailyStorageChanged || sampleScoringChanged;
    const storageChanged =
      dailyStorageChanged ||
      samplePersistence.storageChanged === true ||
      beforeSamples.storageWatermark !== afterSamples.storageWatermark;

    await measureStepTelemetryPhase(
      "scoring_generation",
      () => persistScoringInputState(
        tx,
        userId,
        scoringState,
        afterSamples,
        scoringChanged,
      ),
    );
    const generation = resultingGeneration(scoringState, scoringChanged);
    const repairRequired = !generationsEqual(
      scoringState.sourceQueueSemanticsGeneration,
      generation
    );

    let jobs = [];
    let activeRaceCount = 0;
    if (scoringChanged || repairRequired) {
      const races = await measureStepTelemetryPhase("active_race", () => tx.race.findMany({
        where: {
          status: "ACTIVE",
          participants: { some: { userId, status: "ACCEPTED" } },
        },
        select: {
          id: true,
          participants: {
            where: { userId, status: "ACCEPTED" },
            select: { id: true, userId: true, status: true },
            take: 1,
          },
        },
        orderBy: { id: "asc" },
      }));
      activeRaceCount = races.length;
      const dirtyEnvelopeByRaceId = new Map();
      for (const race of races) {
        const participant = race.participants[0] || null;
        dirtyEnvelopeByRaceId.set(race.id, {
          reason: "STEP_INPUT_CHANGED",
          dirtyUserIds: [userId],
          dirtyParticipantIds: participant ? [participant.id] : [],
          powerupTypes: [],
          priority: participant ? "COALESCE" : "IMMEDIATE",
        });
      }
      jobs = await measureStepTelemetryPhase(
        "durable_enqueue",
        () => raceResolutionJobModel.enqueueMany(
          {
            raceIds: races.map((race) => race.id),
            userId,
            resolutionTimeZone: timeZone,
            now: new Date(requestTimestamp),
            dirtyEnvelopeByRaceId,
            burstCoalescing,
            queuedGenerationMerge,
            queuePriority: "MAINTENANCE",
          },
          tx,
        ),
      );
      await measureStepTelemetryPhase(
        "scoring_generation",
        () => stampSourceQueueSemanticsGeneration(tx, userId, generation),
      );
    }

    return {
      record,
      dailyExisted: Boolean(existingDaily),
      storageChanged,
      scoringChanged,
      repairRequired,
      generation,
      canonicalCoverageThrough: afterSamples.canonicalCoverageThrough,
      completedAt: afterSamples.dbNow,
      jobs,
      activeRaceCount,
    };
  }

  return async function stepInputIntake(input, tx = null) {
    const capacity = startCapacityPhase("step_source_intake");
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
  buildStepInputIntake,
  stepInputIntake,
  generationsEqual,
};
