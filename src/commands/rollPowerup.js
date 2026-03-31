const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../events/eventBus");

const DEFAULT_POWERUP_SLOTS = 3;

const POWERUP_NAMES = {
  LEG_CRAMP: "Leg Cramp",
  RED_CARD: "Red Card",
  SHORTCUT: "Shortcut",
  COMPRESSION_SOCKS: "Compression Socks",
  PROTEIN_SHAKE: "Protein Shake",
  RUNNERS_HIGH: "Runner's High",
  SECOND_WIND: "Second Wind",
  STEALTH_MODE: "Stealth Mode",
  WRONG_TURN: "Wrong Turn",
  FANNY_PACK: "Fanny Pack",
};

function buildRollPowerup(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;

  return async function rollPowerup({ raceId, participantId, userId, currentSteps, nextBoxAtSteps, powerupStepInterval, displayName, powerupSlots }) {
    const maxSlots = powerupSlots || DEFAULT_POWERUP_SLOTS;
    const results = [];
    let currentThreshold = nextBoxAtSteps;

    while (currentSteps >= currentThreshold && currentThreshold > 0) {
      const occupied = await powerupModel.countOccupiedSlots(participantId);
      const queued = occupied >= maxSlots;

      const powerup = await powerupModel.create({
        raceId,
        participantId,
        userId,
        status: queued ? "QUEUED" : "MYSTERY_BOX",
        earnedAtSteps: currentThreshold,
      });

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: queued
          ? `${displayName || "A runner"} earned a mystery box! (queued — inventory full)`
          : `${displayName || "A runner"} earned a mystery box!`,
      });

      events.emit("POWERUP_EARNED", {
        raceId,
        userId,
        powerupId: powerup.id,
      });

      results.push({
        mysteryBox: { id: powerup.id },
        threshold: currentThreshold,
        queued,
      });

      currentThreshold += powerupStepInterval;
      await participantModel.updateNextBoxAtSteps(participantId, currentThreshold);
    }

    return results;
  };
}

const rollPowerup = buildRollPowerup();

module.exports = { buildRollPowerup, rollPowerup, POWERUP_NAMES, DEFAULT_POWERUP_SLOTS };
