const { RacePowerup } = require("../models/racePowerup");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Race } = require("../models/race");
const { eventBus } = require("../events/eventBus");
const { POWERUP_NAMES, DEFAULT_POWERUP_SLOTS } = require("./rollPowerup");

class MysteryBoxOpenError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "MysteryBoxOpenError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildOpenMysteryBox(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;

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
    const heldCount = await powerupModel.countHeldByParticipant(participant.id);

    // Fanny Pack auto-activates even when inventory is full
    if (powerup.type === "FANNY_PACK" && heldCount >= maxSlots) {
      await participantModel.update(participant.id, { powerupSlots: maxSlots + 1 });
      await powerupModel.update(powerupId, { status: "USED", usedAt: new Date() });

      await eventModel.create({
        raceId,
        actorUserId: userId,
        eventType: "POWERUP_EARNED",
        powerupType: powerup.type,
        description: `${displayName || "A runner"} opened a mystery box — ${POWERUP_NAMES[powerup.type]}! Auto-activated — extra slot unlocked.`,
      });

      events.emit("MYSTERY_BOX_OPENED", {
        raceId,
        userId,
        powerupId,
        type: powerup.type,
        rarity: powerup.rarity,
        autoActivated: true,
      });

      return { id: powerup.id, type: powerup.type, rarity: powerup.rarity, autoActivated: true };
    }

    if (heldCount >= maxSlots) {
      throw new MysteryBoxOpenError("Inventory full — discard a powerup first", 400);
    }

    await powerupModel.update(powerupId, { status: "HELD" });

    events.emit("MYSTERY_BOX_OPENED", {
      raceId,
      userId,
      powerupId,
      type: powerup.type,
      rarity: powerup.rarity,
      autoActivated: false,
    });

    return { id: powerup.id, type: powerup.type, rarity: powerup.rarity, autoActivated: false };
  };
}

const openMysteryBox = buildOpenMysteryBox();

module.exports = { buildOpenMysteryBox, openMysteryBox, MysteryBoxOpenError };
