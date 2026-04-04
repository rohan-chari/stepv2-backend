const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerup } = require("../models/racePowerup");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");

function buildExpireEffects(dependencies = {}) {
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;
  const nowFn = dependencies.now || (() => new Date());

  return async function expireEffects({ raceId, participantSteps } = {}) {
    const currentTime = nowFn();
    const expired = await effectModel.findExpired(currentTime);

    const results = [];

    for (const effect of expired) {
      if (raceId && effect.raceId !== raceId) continue;

      const metadata = effect.metadata || {};
      // Store current steps at expiry for Leg Cramp and Runner's High
      if (effect.type === "LEG_CRAMP" || effect.type === "RUNNERS_HIGH") {
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

    return results;
  };
}

const expireEffects = buildExpireEffects();

module.exports = { buildExpireEffects, expireEffects };
