const { prisma: defaultPrisma } = require("../../../db");
const { RaceResolutionJobV2: defaultRaceJob } = require("../models/raceResolutionJobV2");
const { buildHistoricalRaceReconciliationIntentModel } = require("../models/historicalRaceReconciliationIntent");
const { buildHistoricalRaceDiscovery } = require("../services/historicalRaceDiscovery");
const { buildHistoricalRaceDiscoveryCursorModel } = require("../models/historicalRaceDiscoveryCursor");
const { Race } = require("../models/race");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
  computeActiveTimedImpactCapture,
} = require("../services/raceStateResolution");
const { increment, observe } = require("../../../shared/observability/lateEventTimeMetrics");

const SUPPORTED_TYPES = [
  "RUNNERS_HIGH", "WRONG_TURN", "LEG_CRAMP", "QUICKSAND", "RAINSTORM",
  "CAMPFIRE_REST", "UPRISING", "RALLY_FLAG", "COIN_FLIP", "GHOST_PEPPER",
];

async function reconcileIntent({ row, prisma, raceJob, intentModel, now, effectModel, stepSampleModel, stepsModel, invalidateRaceProgress, invalidateRaceList }) {
  const race = await prisma.race.findUnique({
    where: { id: row.race_id },
    include: { participants: { where: { userId: row.user_id, status: "ACCEPTED" }, take: 1 } },
  });
  const participant = race?.participants?.[0];
  if (!race || !participant) return { skipped: true };
  const effects = await effectModel.findSupportedHistoricalEffects({
    raceId: race.id,
    targetParticipantId: participant.id,
    changedStart: row.changed_start,
    changedEnd: row.changed_end,
    types: SUPPORTED_TYPES,
  });
  increment("historical_effects_checked", { race_status: String(race.status || "unknown").toLowerCase() }, effects.length);
  if (effects.length === 0) return { skipped: true };

  const nowAt = race.endsAt && new Date(race.endsAt) > now ? new Date(race.endsAt) : now;
  const base = await calculateBaseAdjusted({
    participant,
    raceStartedAt: race.startedAt,
    timeZone: race.timezone || "UTC",
    stepsModel: stepsModel,
    stepSampleModel,
    now: nowAt,
    raceEndsAt: race.endsAt,
  });
  const current = await calculateCurrentTotal({
    raceId: race.id,
    racePowerupsEnabled: race.powerupsEnabled,
    participant,
    baseAdjusted: base.baseAdjusted,
    hasSampleData: base.hasSampleData,
    raceActiveEffectModel: effectModel,
    stepSampleModel,
    now: nowAt,
  });
  const preLeech = [{ participant, baseAdjusted: base.baseAdjusted, hasSampleData: base.hasSampleData, preLeechTotal: current.total }];
  let sourceRowsRead = 0;
  const capture = await computeActiveTimedImpactCapture({
    race,
    participants: [participant],
    preLeech,
    currentTime: nowAt,
    raceActiveEffectModel: effectModel,
    stepSampleModel,
    selectedEffects: effects,
    onSourceRowsRead: (count) => { sourceRowsRead += Number(count) || 0; },
  });
  const expected = new Map(effects.map((effect) => [effect.id, 0]));
  for (const impact of capture.resolved || []) expected.set(impact.effectId, Number(impact.deltaSteps) || 0);

  let changed = 0;
  let correctionTotal = 0;
  await prisma.$transaction(async (tx) => {
    const claimed = await intentModel.lockClaimed({
      id: row.id,
      leaseToken: row.lease_token,
      claimedGeneration: row.requested_source_generation,
    }, tx);
    if (!claimed) {
      const error = new Error("STALE_INTENT_LEASE_OR_GENERATION");
      error.code = "STALE_INTENT_LEASE_OR_GENERATION";
      throw error;
    }
    const freshRows = await tx.$queryRawUnsafe(
      `SELECT generation FROM user_scoring_input_versions WHERE user_id=$1 FOR UPDATE`,
      row.user_id,
    );
    const freshGeneration = freshRows[0]?.generation;
    if (freshGeneration != null && BigInt(freshGeneration) !== BigInt(row.requested_source_generation)) {
      const error = new Error("SOURCE_GENERATION_ADVANCED");
      error.code = "SOURCE_GENERATION_ADVANCED";
      throw error;
    }
    const fence = await raceJob.acquireForWrite(tx, { raceId: race.id, now });
    if (!fence) throw new Error("RACE_FENCE_UNAVAILABLE");
    for (const effect of effects) {
      const target = expected.get(effect.id) || 0;
      const projection = await tx.historicalEffectContribution.findUnique({
        where: { raceId_userId_effectId_calculationVersion: { raceId: race.id, userId: row.user_id, effectId: effect.id, calculationVersion: 1 } },
      });
      const original = projection || await tx.raceEffectImpact.findUnique({
        where: { raceId_userId_effectId: { raceId: race.id, userId: row.user_id, effectId: effect.id } },
      }) || await tx.raceImpactEvent.findFirst({
        where: { raceId: race.id, recipientUserId: row.user_id, sourceId: effect.id },
        select: { deltaSteps: true },
      });
      const previous = Number(projection?.currentDeltaSteps ?? original?.deltaSteps ?? 0);
      const priorGeneration = projection?.sourceGeneration == null ? 0n : BigInt(projection.sourceGeneration);
      if (priorGeneration > BigInt(row.requested_source_generation)) continue;
      const delta = target - previous;
      if (delta !== 0) {
        const sourceRevision = `v1:${row.requested_source_generation}:${effect.id}:${target}`;
        const existingAudit = await tx.historicalEffectCorrection.findUnique({ where: { projectionId_sourceGeneration_calculationVersion: { projectionId: projection?.id || "00000000-0000-0000-0000-000000000000", sourceGeneration: BigInt(row.requested_source_generation), calculationVersion: 1 } } });
        if (!existingAudit) {
          const savedProjection = await tx.historicalEffectContribution.upsert({
            where: { raceId_userId_effectId_calculationVersion: { raceId: race.id, userId: row.user_id, effectId: effect.id, calculationVersion: 1 } },
            create: { raceId: race.id, userId: row.user_id, effectId: effect.id, powerupType: effect.type, currentDeltaSteps: target, sourceGeneration: BigInt(row.requested_source_generation), calculationVersion: 1 },
            update: { currentDeltaSteps: target, sourceGeneration: BigInt(row.requested_source_generation) },
          });
          await tx.historicalEffectCorrection.create({ data: { projectionId: savedProjection.id, raceId: race.id, userId: row.user_id, effectId: effect.id, fromDeltaSteps: previous, toDeltaSteps: target, correctionDeltaSteps: delta, sourceGeneration: BigInt(row.requested_source_generation), calculationVersion: 1, sourceRevision } });
          correctionTotal += delta;
          changed += 1;
        }
      } else {
        await tx.historicalEffectContribution.upsert({
          where: { raceId_userId_effectId_calculationVersion: { raceId: race.id, userId: row.user_id, effectId: effect.id, calculationVersion: 1 } },
          create: { raceId: race.id, userId: row.user_id, effectId: effect.id, powerupType: effect.type, currentDeltaSteps: target, sourceGeneration: BigInt(row.requested_source_generation), calculationVersion: 1 },
          update: { sourceGeneration: BigInt(row.requested_source_generation) },
        });
      }
    }
    if (correctionTotal !== 0) {
      await tx.raceParticipant.update({ where: { id: participant.id }, data: { totalSteps: { increment: correctionTotal }, ...(participant.finishTotalSteps != null ? { finishTotalSteps: { increment: correctionTotal } } : {}) } });
    }
    const acknowledged = await intentModel.acknowledgeDryRun({ id: row.id, leaseToken: row.lease_token, claimedGeneration: row.requested_source_generation, now }, tx);
    if (!acknowledged) {
      const error = new Error("STALE_INTENT_LEASE_OR_GENERATION");
      error.code = "STALE_INTENT_LEASE_OR_GENERATION";
      throw error;
    }
  }, { timeout: 15000, maxWait: 10000 });
  if (correctionTotal !== 0) {
    increment("historical_effects_corrected", { race_status: String(race.status || "unknown").toLowerCase() }, changed);
    increment("historical_corrections_created", {}, changed);
    observe("correction_delta_steps_absolute", Math.abs(correctionTotal));
    try { await invalidateRaceProgress(race.id); } catch {}
    try { await invalidateRaceList(race.id); } catch {}
  } else increment("historical_reconciliation_noop", {}, 1);
  increment("historical_source_rows_read", { race_status: String(race.status || "unknown").toLowerCase() }, sourceRowsRead);
  return { corrected: changed, correctionTotal };
}

function buildHistoricalRaceReconciliationWorker({
  prisma = defaultPrisma,
  intentModel = buildHistoricalRaceReconciliationIntentModel(prisma),
  raceJob = defaultRaceJob,
  discovery = buildHistoricalRaceDiscovery({ prisma }),
  cursorModel = buildHistoricalRaceDiscoveryCursorModel(prisma),
  logger = console,
  effectModel = RaceActiveEffect,
  stepSampleModel = StepSample,
  stepsModel = Steps,
  invalidateRaceProgress = async (raceId) => require("../services/raceProgressSnapshot").invalidateRaceProgress(raceId),
  invalidateRaceList = async (raceId) => require("../services/raceListCache").invalidateRaces([raceId]),
} = {}) {
  let running = false;
  async function runOnce(now = new Date()) {
    if (running) return { claimed: 0 };
    running = true;
    try {
      const cursor = await cursorModel.claim(now);
      if (cursor) {
        const page = await discovery({
          userId: cursor.user_id,
          changedStart: cursor.changed_start,
          changedEnd: cursor.changed_end,
          cursor: cursor.cursor_race_id ? { raceId: cursor.cursor_race_id, participantId: cursor.cursor_participant_id } : null,
          limit: 100,
        });
        const completed = page.rows.filter((row) => String(row.raceStatus).toLowerCase() === "completed");
        if (completed.length) await intentModel.admitMany({
          rows: completed,
          changedStart: cursor.changed_start,
          changedEnd: cursor.changed_end,
          sourceGeneration: cursor.requested_source_generation,
          now,
        });
        await cursorModel.advance(cursor, page.nextCursor, !page.nextCursor, now);
      }
      const rows = await intentModel.claimBatch({ now });
      const totals = { corrected: 0, noop: 0, stale: 0, skipped: 0 };
      for (const row of rows) {
        const reconciliationStartedAt = process.hrtime.bigint();
        try {
          const result = await reconcileIntent({ row, prisma, raceJob, intentModel, now, effectModel, stepSampleModel, stepsModel, invalidateRaceProgress, invalidateRaceList });
          totals.corrected += result.corrected || 0;
          totals.noop += result.correctionTotal === 0 && !result.skipped ? 1 : 0;
          totals.skipped += result.skipped ? 1 : 0;
        } catch (error) {
          if (error?.code === "SOURCE_GENERATION_ADVANCED" || error?.code === "STALE_INTENT_LEASE_OR_GENERATION") {
            totals.stale += 1;
            increment("historical_reconciliation_generation_stale", { reason: error.code });
            await intentModel.releaseForRetry({
              id: row.id,
              leaseToken: row.lease_token,
              now,
              errorCode: error.code,
            });
          }
          logger.warn?.({ err: error, intentId: row.id, raceId: row.race_id }, "historical reconciliation failed");
        } finally {
          observe("historical_reconciliation_duration_ms", Number(process.hrtime.bigint() - reconciliationStartedAt) / 1e6, {
            result: "completed",
          });
        }
      }
      return { claimed: rows.length, ...totals };
    } finally {
      running = false;
    }
  }
  return { runOnce };
}

function scheduleHistoricalRaceReconciliationWorker(options = {}) {
  const worker = buildHistoricalRaceReconciliationWorker(options);
  const interval = setInterval(() => worker.runOnce().catch(() => {}), 5000);
  interval.unref?.();
  worker.runOnce().catch(() => {});
  return { worker, stop: () => clearInterval(interval) };
}

module.exports = { buildHistoricalRaceReconciliationWorker, scheduleHistoricalRaceReconciliationWorker };
