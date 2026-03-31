const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../events/eventBus");
const { rollPowerup: rollPowerupOdds } = require("../utils/powerupOdds");

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
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;

  return async function rollPowerup({ raceId, participantId, userId, currentSteps, nextBoxAtSteps, position, totalParticipants, powerupStepInterval, displayName, powerupSlots }) {
    const maxSlots = powerupSlots || DEFAULT_POWERUP_SLOTS;
    const results = [];
    let currentThreshold = nextBoxAtSteps;

    while (currentSteps >= currentThreshold && currentThreshold > 0) {
      const heldCount = await powerupModel.countHeldByParticipant(participantId);

      // Roll first, then decide what to do based on type and inventory
      let rolled = rollFn(position, totalParticipants);
      while (rolled.type === "FANNY_PACK" && maxSlots > DEFAULT_POWERUP_SLOTS) {
        // Already has Fanny Pack active — re-roll silently
        rolled = rollFn(position, totalParticipants);
      }

      // Auto-activate Fanny Pack when inventory is full
      if (rolled.type === "FANNY_PACK" && heldCount >= maxSlots) {
        await participantModel.updatePowerupSlots(participantId, maxSlots + 1);

        await eventModel.create({
          raceId,
          actorUserId: userId,
          eventType: "POWERUP_EARNED",
          powerupType: rolled.type,
          description: `${displayName || "A runner"} earned a ${POWERUP_NAMES[rolled.type]}! Auto-activated — extra slot unlocked.`,
        });

        events.emit("POWERUP_EARNED", {
          raceId,
          userId,
          type: rolled.type,
          rarity: rolled.rarity,
          autoActivated: true,
        });

        results.push({
          inventoryFull: false,
          powerup: { id: null, type: rolled.type, rarity: rolled.rarity, autoActivated: true },
          threshold: currentThreshold,
        });

        currentThreshold += powerupStepInterval;
        await participantModel.updateNextBoxAtSteps(participantId, currentThreshold);
        continue;
      }

      const powerup = await powerupModel.create({
        raceId,
        participantId,
        userId,
        type: rolled.type,
        rarity: rolled.rarity,
        status: "MYSTERY_BOX",
        earnedAtSteps: currentThreshold,
      });

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_EARNED",
        powerupType: null,
        description: `${displayName || "A runner"} earned a mystery box!`,
      });

      events.emit("POWERUP_EARNED", {
        raceId,
        userId,
        powerupId: powerup.id,
      });

      results.push({
        mysteryBox: { id: powerup.id },
        threshold: currentThreshold,
      });

      currentThreshold += powerupStepInterval;
      await participantModel.updateNextBoxAtSteps(participantId, currentThreshold);
    }

    return results;
  };
}

const rollPowerup = buildRollPowerup();

module.exports = { buildRollPowerup, rollPowerup, POWERUP_NAMES, DEFAULT_POWERUP_SLOTS };
