const { milestonesChanged } = require("./milestoneCacheInvalidation");
const { StepSample: defaultStepSampleModel } = require("../models/stepSample");
const {
  lockScoringInputState,
  readSampleInputBounds,
  scoringRevisionWatermark,
  scoringRevisionIsCurrent,
  scoringBoundaryIsSafe,
  persistScoringInputState,
} = require("./scoringInputVersion");

function generationsEqual(left, right) {
  if (left == null || right == null) return false;
  return BigInt(left) === BigInt(right);
}

function resultingGeneration(state, scoringChanged) {
  const current = state?.generation == null ? 1n : BigInt(state.generation);
  return scoringChanged && state?.inserted !== true ? current + 1n : current;
}

async function upsertDailyStep(tx, { userId, date, steps }) {
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
       FROM persisted CROSS JOIN prior
     UNION ALL
     SELECT id,user_id AS "userId",steps,step_goal AS "stepGoal",date,
            created_at AS "createdAt",TRUE AS existed,FALSE AS "storageChanged"
       FROM steps WHERE user_id=$1 AND date=$2::date
         AND steps IS NOT DISTINCT FROM $3
         AND NOT EXISTS (SELECT 1 FROM persisted)`,
    userId,
    new Date(date),
    Number(steps),
  );
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
  return { record, existed: existed === true, storageChanged: storageChanged === true };
}

function buildPersistStepInput(dependencies = {}) {
  const stepSampleModel = dependencies.StepSample || defaultStepSampleModel;

  return async function persistStepInput({
    tx,
    userId,
    daily,
    samples,
    requestTimestamp,
    beforeSourceWrites = null,
  }) {
    if (!tx) throw new TypeError("persistStepInput requires transaction client");
    if (!userId) throw new TypeError("persistStepInput requires userId");

    const scoringState = await lockScoringInputState(tx, userId);
    if (beforeSourceWrites) await beforeSourceWrites(tx);

    let dailyExisted = false;
    let record = null;
    let dailyStorageChanged = false;

    if (daily) {
      const persistedDaily = await upsertDailyStep(tx, { userId, ...daily });
      record = persistedDaily.record;
      dailyExisted = persistedDaily.existed;
      dailyStorageChanged = persistedDaily.storageChanged;
      if (dailyStorageChanged) await milestonesChanged(userId, record.date);
    }

    let samplePersistence = {
      storageChanged: false,
      scoringChanged: false,
      earliestChangedStartMs: null,
      latestChangedEndMs: null,
      changedBucketCount: 0,
    };

    if (Array.isArray(samples) && samples.length > 0) {
      samplePersistence = await stepSampleModel.reconcileBatchOn(
        tx,
        userId,
        samples,
        new Date(requestTimestamp).getTime(),
        {
          noopSuppression: true,
          manageScoringVersion: false,
          classifyScoringDelta: true,
          appendOnlyFastPath: true,
          scoringInputLockHeld: true,
        },
      );
    }

    const canonicalInput = await readSampleInputBounds(tx, userId);
    const decisionState = { ...scoringState, dbNow: canonicalInput.dbNow };
    const sampleScoringChanged =
      samplePersistence.scoringChanged === true ||
      !scoringRevisionIsCurrent(userId, scoringState) ||
      !scoringBoundaryIsSafe(decisionState);
    const scoringChanged = dailyStorageChanged || sampleScoringChanged;
    const storageChanged = dailyStorageChanged || samplePersistence.storageChanged === true;

    const generation = resultingGeneration(scoringState, scoringChanged);
    canonicalInput.scoringWatermark = scoringRevisionWatermark(userId, generation);
    const repairRequired = !generationsEqual(
      scoringState.sourceQueueSemanticsGeneration,
      generation,
    );

    const sourceEnvelope =
      samplePersistence.scoringChanged === true &&
      Number.isFinite(samplePersistence.earliestChangedStartMs) &&
      Number.isFinite(samplePersistence.latestChangedEndMs)
        ? {
            changedStart: new Date(samplePersistence.earliestChangedStartMs),
            changedEnd: new Date(samplePersistence.latestChangedEndMs),
            changedBucketCount: samplePersistence.changedBucketCount || 0,
            sourceGeneration: generation,
          }
        : null;

    await persistScoringInputState(
      tx,
      userId,
      scoringState,
      canonicalInput,
      scoringChanged,
      {
        ...((scoringChanged || repairRequired)
          ? { sourceQueueSemanticsGeneration: generation }
          : {}),
        rawSampleChange: {
          complete:
            samplePersistence.scoringChanged !== true ||
            Number.isFinite(samplePersistence.earliestChangedStartMs),
          earliestChangedStartMs: samplePersistence.earliestChangedStartMs ?? null,
        },
      },
    );

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
      sourceEnvelope,
      canonicalCoverageThrough: canonicalInput.canonicalCoverageThrough,
      completedAt: canonicalInput.dbNow,
    };
  };
}

const persistStepInput = buildPersistStepInput();

module.exports = {
  buildPersistStepInput,
  persistStepInput,
  upsertDailyStep,
  generationsEqual,
  resultingGeneration,
};
