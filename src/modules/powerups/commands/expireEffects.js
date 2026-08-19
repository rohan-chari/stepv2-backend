const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerup } = require("../models/racePowerup");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const { StepSample } = require("../../steps/models/stepSample");
const { eventBus } = require("../../../shared/events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");
const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");

let immediateRaceResolutionWorker = null;
async function defaultResolveRaceResolution(input) {
  // Lazy require avoids introducing a module-initialization cycle: the C0
  // worker's post-commit hook itself loads expireEffects. One process-local
  // worker is enough; ownership is still the durable race job lease/fence.
  if (!immediateRaceResolutionWorker) {
    const { buildRaceResolutionWorkerV2 } = require("../../races/jobs/raceResolutionQueueV2");
    immediateRaceResolutionWorker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  }
  return immediateRaceResolutionWorker.processRace(input);
}

// Both lists live in a dependency-free constants module so consumers (the
// race-scoring dependency-closure table) can derive from them without loading
// this file's model/eventBus/awardCoins graph. Re-exported below unchanged.
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
  ACTIVE_IMPACT_EXPIRY_TYPES,
} = require("../constants/expiryEffectTypes");

// Compute a participant's steps over [start, end] from samples, falling back to
// a snapshot diff when there is no sample data.
async function windowStepsForTarget(stepSampleModel, effect, startDate, endDate, snapshotSteps) {
  const samp = await stepSampleModel.sumStepsInWindow(effect.targetUserId, startDate, endDate);
  if (samp > 0) return samp;
  const meta = effect.metadata || {};
  const start = meta.stepsAtStart || 0;
  const end = snapshotSteps != null ? snapshotSteps : (meta.stepsAtExpiry != null ? meta.stepsAtExpiry : start);
  return Math.max(0, end - start);
}

function buildExpireEffects(dependencies = {}) {
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const awardCoins = dependencies.awardCoins || defaultAwardCoins;
  const events = dependencies.eventBus || eventBus;
  const settings = dependencies.appSettings || defaultAppSettings;
  const enqueueRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolution"
  )
    ? dependencies.enqueueRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultEnqueueRaceResolution;
  const resolveRaceResolution = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceResolution"
  )
    ? dependencies.resolveRaceResolution
    : Object.keys(dependencies).length > 0
      ? async () => null
      : defaultResolveRaceResolution;
  const nowFn = dependencies.now || (() => new Date());

  return async function expireEffects({ raceId, participantSteps } = {}) {
    const currentTime = nowFn();
    const activeImpactEnabled =
      (Object.keys(dependencies).length === 0 || dependencies.appSettings) &&
      (await isStrictFlagEnabled(settings, "apiActiveImpactNoticesV1Enabled"));
    const expired =
      raceId && typeof effectModel.findExpiredForRace === "function"
        ? await effectModel.findExpiredForRace(raceId, currentTime)
        : await effectModel.findExpired(currentTime);

    // Drill judgement changes authoritative participant steps. It may never run
    // in this legacy request/post-commit helper: only the race-keyed C0 writer
    // can atomically commit the penalty, effect metadata/status and durable
    // active-impact source under the rollout fence. A progress read marks each
    // affected race dirty and, for the legacy response-timing contract, awaits
    // that race's C0 generation; it never judges the effect itself. Enqueue is
    // idempotent/coalescing and a failed enqueue leaves the ACTIVE row due for
    // the next discovery pass.
    const dueDrillsByRace = new Map();
    for (const effect of expired) {
      if (effect.type !== "DRILL_SERGEANT" || !effect.raceId) continue;
      if (!dueDrillsByRace.has(effect.raceId)) {
        dueDrillsByRace.set(effect.raceId, { userIds: new Set(), participantIds: new Set() });
      }
      const due = dueDrillsByRace.get(effect.raceId);
      if (effect.targetUserId) due.userIds.add(effect.targetUserId);
      if (effect.targetParticipantId) due.participantIds.add(effect.targetParticipantId);
    }
    for (const [dueRaceId, due] of dueDrillsByRace) {
      const job = await enqueueRaceResolution({
        raceId: dueRaceId,
        userId: [...due.userIds][0] || null,
        dirtyUserIds: [...due.userIds],
        dirtyParticipantIds: [...due.participantIds],
        powerupTypes: ["DRILL_SERGEANT"],
        reason: "EFFECT_BOUNDARY",
        priority: "IMMEDIATE",
        now: currentTime,
      });
      if (job?.id) {
        await resolveRaceResolution({
          raceId: dueRaceId,
          generation: Number(job.generation),
        });
      }
    }

    const results = [];

    for (const effect of expired) {
      if (raceId && effect.raceId !== raceId) continue;
      if (effect.type === "DRILL_SERGEANT") continue;

      const metadata = effect.metadata || {};
      if (
        !activeImpactEnabled &&
        ACTIVE_IMPACT_EXPIRY_TYPES.includes(effect.type)
      ) {
        metadata.activeImpactResolutionSkippedVersion = 1;
      }
      // Store current steps at expiry for snapshot-based timed modifiers.
      if (SNAPSHOT_AT_EXPIRY_TYPES.includes(effect.type)) {
        const currentStepsForTarget = participantSteps?.[effect.targetParticipantId];
        if (currentStepsForTarget !== undefined) {
          metadata.stepsAtExpiry = currentStepsForTarget;
        }
      }

      // Revert Fanny Pack slot expansion (items stay — extra slot just won't refill)
      if (effect.type === "FANNY_PACK") {
        try {
          const participant = await participantModel.findById(effect.targetParticipantId);
          if (participant && participant.powerupSlots > 3) {
            await participantModel.updatePowerupSlots(participant.id, participant.powerupSlots - 1);
          }
        } catch (e) {
          console.error("Failed to revert Fanny Pack slots:", e);
        }
      }

      // ── PIGGY_BANK (§3.10): mint coins for the window at expiry (idempotent via
      // awardCoins refId = effect.id; the settlement path uses the same refId).
      if (effect.type === "PIGGY_BANK") {
        try {
          await mintPiggyBank({ effect, raceModel, stepSampleModel, awardCoins, endCap: effect.expiresAt });
        } catch (e) {
          console.error("Piggy Bank mint failed:", e);
        }
      }

      await effectModel.update(effect.id, {
        status: "EXPIRED",
        metadata,
      });

      await eventModel.create({
        raceId: effect.raceId,
        actorUserId: effect.targetUserId,
        eventType: "EFFECT_EXPIRED",
        powerupType: effect.type,
        description: `${POWERUP_NAMES[effect.type]} wore off.`,
      });

      events.emit("EFFECT_EXPIRED", {
        raceId: effect.raceId,
        effectId: effect.id,
        type: effect.type,
        targetUserId: effect.targetUserId,
      });

      results.push(effect);
    }

    // C3 (spec §5 Phase D step 9): an expiry changes what every viewer of that
    // race should see, so the shared standings snapshot must go. Only races we
    // actually touched are invalidated, and only when something expired — this
    // runs on the worker's post-commit path, where the publish that follows
    // immediately re-SETs the fresh value.
    if (results.length > 0) {
      const touchedRaceIds = [...new Set(results.map((e) => e.raceId).filter(Boolean))];
      const {
        invalidateRaceProgress,
      } = require("../../races/services/raceProgressSnapshot");
      for (const id of touchedRaceIds) {
        await invalidateRaceProgress(id);
      }
    }

    return results;
  };
}

// Drill Sergeant resolution (shared shape for expiry). VOID when the race ended
// before the dare's expiry.
async function evaluateDrillSergeant({ effect, raceModel, participantModel, stepSampleModel, eventModel, participantSteps }) {
  const meta = effect.metadata || {};
  const goalSteps = Number(meta.goalSteps) || 3000;
  const penaltySteps = Number(meta.penaltySteps) || 1500;

  const race = await raceModel.findById(effect.raceId);
  const endedFirst =
    !race ||
    race.status !== "ACTIVE" ||
    (race.endsAt && new Date(race.endsAt) <= new Date(effect.expiresAt));

  if (endedFirst) {
    await eventModel.create({
      raceId: effect.raceId,
      actorUserId: effect.targetUserId,
      eventType: "POWERUP_USED",
      powerupType: "DRILL_SERGEANT",
      targetUserId: effect.targetUserId,
      description: `The Drill Sergeant dare was voided. The race ended first.`,
      metadata: { outcome: "VOID" },
    });
    return { outcome: "VOID", deltaSteps: 0 };
  }

  const snapshotSteps = participantSteps?.[effect.targetParticipantId];
  const windowSteps = await windowStepsForTarget(
    stepSampleModel, effect, new Date(effect.startsAt), new Date(effect.expiresAt), snapshotSteps
  );

  if (windowSteps >= goalSteps) {
    await eventModel.create({
      raceId: effect.raceId,
      actorUserId: effect.targetUserId,
      eventType: "POWERUP_USED",
      powerupType: "DRILL_SERGEANT",
      targetUserId: effect.targetUserId,
      description: `Dare survived! They walked ${Math.round(windowSteps).toLocaleString()} steps and dodged the Drill Sergeant penalty.`,
      metadata: { outcome: "SURVIVED", windowSteps: Math.round(windowSteps) },
    });
    return { outcome: "SURVIVED", deltaSteps: 0 };
  }

  // Missed the goal → instant penalty (Red Card bonus-subtraction, floored at 0).
  await participantModel.subtractBonusSteps(effect.targetParticipantId, penaltySteps);
  await eventModel.create({
    raceId: effect.raceId,
    actorUserId: effect.sourceUserId,
    eventType: "POWERUP_USED",
    powerupType: "DRILL_SERGEANT",
    targetUserId: effect.targetUserId,
    description: `Dare failed! They fell short of ${goalSteps.toLocaleString()} steps and lost ${penaltySteps.toLocaleString()}.`,
    metadata: { outcome: "FAILED", penalty: penaltySteps, windowSteps: Math.round(windowSteps) },
  });
  return { outcome: "FAILED", deltaSteps: -penaltySteps };
}

// Piggy Bank mint (shared by expiry + settlement). Window is [startsAt,
// min(expiresAt, endCap)]. Idempotent via awardCoins refId = effect.id.
async function mintPiggyBank({ effect, stepSampleModel, awardCoins, endCap }) {
  const meta = effect.metadata || {};
  const stepsPerCoin = Number(meta.stepsPerCoin) || 300;
  const coinCap = Number.isFinite(Number(meta.coinCap)) ? Number(meta.coinCap) : 80;
  if (coinCap <= 0 || stepsPerCoin <= 0) return; // env kill switch: nothing to mint

  const start = new Date(effect.startsAt);
  const expiry = effect.expiresAt ? new Date(effect.expiresAt) : new Date();
  const cap = endCap ? new Date(endCap) : expiry;
  const end = cap.getTime() < expiry.getTime() ? cap : expiry;
  if (end.getTime() <= start.getTime()) return;

  const windowSteps = await stepSampleModel.sumStepsInWindow(effect.targetUserId, start, end);
  const coins = Math.min(Math.floor(Math.max(0, windowSteps) / stepsPerCoin), coinCap);
  if (coins <= 0) {
    // Still record the (zero) attempt so a later settlement mint is a no-op via
    // the same refId only if coins > 0; a zero mint intentionally does nothing.
    return;
  }
  await awardCoins({ userId: effect.targetUserId, amount: coins, reason: "piggy_bank", refId: effect.id });
}

const expireEffects = buildExpireEffects();

// Both type lists are re-exported so existing importers of this module keep
// working; the dependency-free constants module is the definition site.
module.exports = {
  buildExpireEffects,
  expireEffects,
  evaluateDrillSergeant,
  mintPiggyBank,
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
  ACTIVE_IMPACT_EXPIRY_TYPES,
};
