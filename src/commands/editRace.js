const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../events/eventBus");
const {
  validateRaceName,
  validateDuration,
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
} = require("../services/validateRaceConfig");

class RaceEditError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceEditError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function hasField(updates, key) {
  return Object.prototype.hasOwnProperty.call(updates, key);
}

function buildEditRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const events = dependencies.eventBus || eventBus;

  return async function editRace({ userId, raceId, updates = {} }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceEditError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceEditError("Only the race creator can edit the race", 403);
    }
    if (race.status !== "PENDING") {
      throw new RaceEditError(
        "Race settings can only be edited while the race is pending",
        400
      );
    }

    const fields = {};

    if (hasField(updates, "name")) {
      fields.name = validateRaceName(updates.name, RaceEditError);
    }

    if (hasField(updates, "maxDurationDays")) {
      fields.maxDurationDays = validateDuration(
        updates.maxDurationDays,
        RaceEditError
      );
    }

    // Determine effective powerup state for combined validation
    const effectivePowerupsEnabled = hasField(updates, "powerupsEnabled")
      ? !!updates.powerupsEnabled
      : race.powerupsEnabled;
    const effectivePowerupInterval = hasField(updates, "powerupStepInterval")
      ? updates.powerupStepInterval
      : race.powerupStepInterval;

    if (
      hasField(updates, "powerupsEnabled") ||
      hasField(updates, "powerupStepInterval")
    ) {
      validatePowerupConfig({
        powerupsEnabled: effectivePowerupsEnabled,
        powerupStepInterval: effectivePowerupInterval,
        ErrorClass: RaceEditError,
      });
      if (hasField(updates, "powerupsEnabled")) {
        fields.powerupsEnabled = effectivePowerupsEnabled;
      }
      if (hasField(updates, "powerupStepInterval")) {
        fields.powerupStepInterval = updates.powerupStepInterval;
      }
    }

    if (hasField(updates, "isPublic")) {
      fields.isPublic = !!updates.isPublic;
    }

    if (hasField(updates, "maxParticipants")) {
      const newMax = validateMaxParticipants(
        updates.maxParticipants,
        RaceEditError
      );
      // newMax === null => unlimited; the "already N accepted" floor only
      // applies to a finite cap.
      if (newMax !== null) {
        const acceptedCount = await participantModel.countAccepted(raceId);
        if (newMax < acceptedCount) {
          throw new RaceEditError(
            `Cannot reduce max participants to ${newMax}; already ${acceptedCount} accepted`,
            400
          );
        }
      }
      fields.maxParticipants = newMax;
    }

    if (hasField(updates, "buyInAmount") || hasField(updates, "payoutPreset")) {
      const proposedBuyIn = hasField(updates, "buyInAmount")
        ? updates.buyInAmount
        : race.buyInAmount;
      const proposedPreset = hasField(updates, "payoutPreset")
        ? updates.payoutPreset
        : race.payoutPreset;

      const buyInConfig = validateRaceBuyInConfig({
        buyInAmount: proposedBuyIn,
        payoutPreset: proposedPreset,
        ErrorClass: RaceEditError,
      });

      if (
        hasField(updates, "buyInAmount") &&
        buyInConfig.buyInAmount !== race.buyInAmount
      ) {
        const chargedParticipants = await participantModel.findChargedByRace(
          raceId
        );
        if (chargedParticipants.length > 0) {
          throw new RaceEditError(
            "Cannot edit buy-in after a participant has accepted and paid in",
            400
          );
        }
        fields.buyInAmount = buyInConfig.buyInAmount;
      }

      if (hasField(updates, "payoutPreset")) {
        fields.payoutPreset = buyInConfig.payoutPreset;
      }
    }

    if (Object.keys(fields).length === 0) {
      // Nothing to update; return the race as-is.
      return race;
    }

    await raceModel.update(raceId, fields);
    const updated = await raceModel.findById(raceId);

    events.emit("RACE_EDITED", {
      raceId,
      creatorUserId: userId,
      updatedFields: Object.keys(fields),
    });

    return updated;
  };
}

const editRace = buildEditRace();

module.exports = { buildEditRace, editRace, RaceEditError };
