const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { RacePowerup } = require("../models/racePowerup");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../../races/models/race");
const { StepSample } = require("../../steps/models/stepSample");
const { eventBus } = require("../../../shared/events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");
const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");

// Both lists live in a dependency-free constants module so consumers (the
// race-scoring dependency-closure table) can derive from them without loading
// this file's model/eventBus/awardCoins graph. Re-exported below unchanged.
const {
  SNAPSHOT_AT_EXPIRY_TYPES,
  EXPIRY_CONSEQUENCE_TYPES,
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
  const nowFn = dependencies.now || (() => new Date());

  return async function expireEffects({ raceId, participantSteps } = {}) {
    const currentTime = nowFn();
    const expired =
      raceId && typeof effectModel.findExpiredForRace === "function"
        ? await effectModel.findExpiredForRace(raceId, currentTime)
        : await effectModel.findExpired(currentTime);

    const results = [];

    for (const effect of expired) {
      if (raceId && effect.raceId !== raceId) continue;

      const metadata = effect.metadata || {};
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

      // ── DRILL_SERGEANT (§3.9): judged at expiry. VOID if the race ended before
      // the dare's expiry; otherwise penalize the target if they missed the goal.
      if (effect.type === "DRILL_SERGEANT") {
        try {
          await evaluateDrillSergeant({
            effect, raceModel, participantModel, stepSampleModel, eventModel,
            participantSteps,
          });
        } catch (e) {
          console.error("Drill Sergeant evaluation failed:", e);
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
    return;
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
    return;
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
};
