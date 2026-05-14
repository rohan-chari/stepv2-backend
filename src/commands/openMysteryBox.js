const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { eventBus } = require("../events/eventBus");
const { rollPowerup: rollPowerupOdds, RARITY_TIERS, RARITY_ORDER } = require("../utils/powerupOdds");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../services/racePowerupStateSync");

class MysteryBoxOpenError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "MysteryBoxOpenError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildOpenMysteryBox(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const effectModel = dependencies.RaceActiveEffect || (hasInjectedDeps
    ? {
        async findActiveByTypeForParticipant() { return null; },
        async update() {},
      }
    : RaceActiveEffect);
  const events = dependencies.eventBus || eventBus;
  const rollFn = dependencies.rollPowerupOdds || rollPowerupOdds;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;

  return async function openMysteryBox({ userId, raceId, powerupId, displayName }) {
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new MysteryBoxOpenError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new MysteryBoxOpenError("This powerup does not belong to you", 403);
    }
    if (powerup.status !== "MYSTERY_BOX") {
      throw new MysteryBoxOpenError("This powerup is not a mystery box", 400);
    }

    const race = await raceModel.findById(raceId);
    if (!race || race.status !== "ACTIVE") {
      throw new MysteryBoxOpenError("Race is not active", 400);
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new MysteryBoxOpenError("You are not in this race", 403);
    }

    const maxSlots = participant.powerupSlots || DEFAULT_POWERUP_SLOTS;
    const occupiedCount = await powerupModel.countOccupiedSlots(participant.id);

    // Calculate current position for odds
    const allParticipants = await participantModel.findAcceptedByRace(raceId);
    const sorted = [...allParticipants].sort((a, b) => b.totalSteps - a.totalSteps);
    const position = sorted.findIndex((p) => p.userId === userId) + 1;
    const totalParticipants = sorted.length;

    const luckyEffect = await effectModel.findActiveByTypeForParticipant?.(
      participant.id,
      "LUCKY_HORSESHOE"
    );
    const minRarity = luckyEffect?.metadata?.minRarity;

    // Roll the powerup type now
    let rolled = rollFn(position, totalParticipants, Math.random, { minRarity });
    if (minRarity) {
      const rolledIndex = RARITY_ORDER.indexOf(rolled.rarity);
      const minIndex = RARITY_ORDER.indexOf(minRarity);
      if (rolledIndex !== -1 && minIndex !== -1 && rolledIndex < minIndex) {
        rolled = {
          type: RARITY_TIERS[minRarity][0],
          rarity: minRarity,
        };
      }
    }
    // Re-roll Fanny Pack if user already has expanded slots
    while (rolled.type === "FANNY_PACK" && maxSlots > DEFAULT_POWERUP_SLOTS) {
      rolled = rollFn(position, totalParticipants, Math.random, { minRarity });
    }

    if (luckyEffect) {
      await effectModel.update(luckyEffect.id, { status: "EXPIRED" });
    }

    // Fanny Pack auto-activates when inventory is full
    if (rolled.type === "FANNY_PACK" && occupiedCount >= maxSlots) {
      await participantModel.update(participant.id, { powerupSlots: maxSlots + 1 });
      await powerupModel.update(powerupId, { type: rolled.type, rarity: rolled.rarity, status: "USED", usedAt: new Date() });

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_EARNED",
        powerupType: rolled.type,
        description: `${displayName || "A runner"} opened a mystery box — ${POWERUP_NAMES[rolled.type]}! Auto-activated — extra slot unlocked.`,
      });

      events.emit("MYSTERY_BOX_OPENED", {
        raceId,
        userId,
        powerupId,
        type: rolled.type,
        rarity: rolled.rarity,
        autoActivated: true,
      });

      await syncRacePowerupState({ raceId, userId });

      return { id: powerup.id, type: rolled.type, rarity: rolled.rarity, autoActivated: true };
    }

    await powerupModel.update(powerupId, { type: rolled.type, rarity: rolled.rarity, status: "HELD" });

    events.emit("MYSTERY_BOX_OPENED", {
      raceId,
      userId,
      powerupId,
      type: rolled.type,
      rarity: rolled.rarity,
      autoActivated: false,
    });

    await syncRacePowerupState({ raceId, userId });

    return { id: powerup.id, type: rolled.type, rarity: rolled.rarity, autoActivated: false };
  };
}

const openMysteryBox = buildOpenMysteryBox();

module.exports = { buildOpenMysteryBox, openMysteryBox, MysteryBoxOpenError };
