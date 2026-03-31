const { RacePowerup } = require("../models/racePowerup");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { eventBus } = require("../events/eventBus");
const { POWERUP_NAMES } = require("./rollPowerup");

class PowerupDiscardError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "PowerupDiscardError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildDiscardPowerup(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;

  return async function discardPowerup({ userId, raceId, powerupId, displayName }) {
    const powerup = await powerupModel.findById(powerupId);
    if (!powerup) {
      throw new PowerupDiscardError("Powerup not found", 404);
    }
    if (powerup.userId !== userId || powerup.raceId !== raceId) {
      throw new PowerupDiscardError("This powerup does not belong to you", 403);
    }
    if (!["HELD", "MYSTERY_BOX"].includes(powerup.status)) {
      throw new PowerupDiscardError("This powerup cannot be discarded", 400);
    }

    await powerupModel.update(powerupId, { status: "DISCARDED" });

    const isMysteryBox = powerup.status === "MYSTERY_BOX";
    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "POWERUP_DISCARDED",
      powerupType: isMysteryBox ? null : powerup.type,
      description: isMysteryBox
        ? `${displayName || "A runner"} discarded a mystery box.`
        : `${displayName || "A runner"} discarded a ${POWERUP_NAMES[powerup.type]}.`,
    });

    events.emit("POWERUP_DISCARDED", {
      raceId,
      userId,
      type: powerup.type,
    });

    return { success: true };
  };
}

const discardPowerup = buildDiscardPowerup();

module.exports = { buildDiscardPowerup, discardPowerup, PowerupDiscardError };
