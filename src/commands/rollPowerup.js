const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../events/eventBus");
const { rollPowerup: rollPowerupOdds } = require("../utils/powerupOdds");

const MAX_INVENTORY = 3;

const POWERUP_NAMES = {
  LEG_CRAMP: "Leg Cramp",
  RED_CARD: "Red Card",
  BANANA_PEEL: "Banana Peel",
  COMPRESSION_SOCKS: "Compression Socks",
  PROTEIN_SHAKE: "Protein Shake",
  RUNNERS_HIGH: "Runner's High",
  SECOND_WIND: "Second Wind",
  STEALTH_MODE: "Stealth Mode",
};

function buildRollPowerup(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;

  return async function rollPowerup({ raceId, participantId, userId, currentSteps, nextBoxAtSteps, position, totalParticipants, powerupStepInterval, displayName }) {
    const results = [];
    let currentThreshold = nextBoxAtSteps;

    while (currentSteps >= currentThreshold && currentThreshold > 0) {
      const heldCount = await powerupModel.countHeldByParticipant(participantId);

      if (heldCount >= MAX_INVENTORY) {
        results.push({ inventoryFull: true, threshold: currentThreshold });
        currentThreshold += powerupStepInterval;
        await participantModel.updateNextBoxAtSteps(participantId, currentThreshold);
        break;
      }

      const { type, rarity } = rollFn(position, totalParticipants);

      const powerup = await powerupModel.create({
        raceId,
        participantId,
        userId,
        type,
        rarity,
        earnedAtSteps: currentThreshold,
      });

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_EARNED",
        powerupType: type,
        description: `${displayName || "A runner"} earned a ${POWERUP_NAMES[type]}!`,
      });

      events.emit("POWERUP_EARNED", {
        raceId,
        userId,
        powerupId: powerup.id,
        type,
        rarity,
      });

      results.push({
        inventoryFull: false,
        powerup: { id: powerup.id, type, rarity },
        threshold: currentThreshold,
      });

      currentThreshold += powerupStepInterval;
      await participantModel.updateNextBoxAtSteps(participantId, currentThreshold);
    }

    return results;
  };
}

const rollPowerup = buildRollPowerup();

module.exports = { buildRollPowerup, rollPowerup, POWERUP_NAMES, MAX_INVENTORY };
