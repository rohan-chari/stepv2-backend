const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../models/user");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const {
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");
const {
  validateRaceName,
  validateDuration,
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
} = require("../services/validateRaceConfig");

class RaceCreationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceCreationError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildCreateRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function createRace({
    userId,
    name,
    maxDurationDays = 7,
    powerupsEnabled = false,
    powerupStepInterval,
    buyInAmount = 0,
    payoutPreset,
    isPublic = false,
    maxParticipants = 10,
    // 1.1.4 compat: legacy clients still send targetSteps on createRace. New
    // clients don't, in which case it stays 0. The value isn't used by the
    // backend for completion logic (time-based only) — kept solely so the
    // legacy UI can render the target it picked.
    targetSteps = 0,
  }) {
    validateRaceName(name, RaceCreationError);
    validateDuration(maxDurationDays, RaceCreationError);
    validatePowerupConfig({
      powerupsEnabled,
      powerupStepInterval,
      ErrorClass: RaceCreationError,
    });
    validateMaxParticipants(maxParticipants, RaceCreationError);

    const buyInConfig = validateRaceBuyInConfig({
      buyInAmount,
      payoutPreset,
      ErrorClass: RaceCreationError,
    });

    await ensureUserCanAfford({
      userModel,
      userId,
      amount: buyInConfig.buyInAmount,
      ErrorClass: RaceCreationError,
    });

    const race = await raceModel.create({
      creatorId: userId,
      name: name.trim(),
      // 1.1.4 compat: persist whatever targetSteps the legacy client sent so it
      // can render its own UI. Not used for completion (time-based only).
      targetSteps: Number.isFinite(targetSteps) && targetSteps > 0 ? targetSteps : 0,
      maxDurationDays,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? powerupStepInterval : null,
      buyInAmount: buyInConfig.buyInAmount,
      payoutPreset: buyInConfig.payoutPreset,
      isPublic: !!isPublic,
      maxParticipants,
    });

    await participantModel.create({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
      buyInAmount: buyInConfig.buyInAmount,
      buyInStatus: buyInConfig.buyInAmount > 0 ? "HELD" : "NONE",
    });

    await reserveRaceBuyIn({
      awardCoinsFn,
      userId,
      raceId: race.id,
      amount: buyInConfig.buyInAmount,
    });

    const fullRace = await raceModel.findById(race.id);

    events.emit("RACE_CREATED", {
      raceId: race.id,
      creatorUserId: userId,
    });

    return fullRace;
  };
}

const createRace = buildCreateRace();

module.exports = { buildCreateRace, createRace, RaceCreationError };
