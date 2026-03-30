const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../events/eventBus");

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
  const events = dependencies.eventBus || eventBus;

  return async function createRace({ userId, name, targetSteps, maxDurationDays = 7, powerupsEnabled = false, powerupStepInterval }) {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new RaceCreationError("Race name is required", 400);
    }
    if (name.trim().length > 50) {
      throw new RaceCreationError("Race name must be 50 characters or less", 400);
    }
    if (!targetSteps || targetSteps < 1000) {
      throw new RaceCreationError("Target steps must be at least 1,000", 400);
    }
    if (targetSteps > 1000000) {
      throw new RaceCreationError("Target steps must be 1,000,000 or less", 400);
    }
    if (maxDurationDays < 1 || maxDurationDays > 30) {
      throw new RaceCreationError("Duration must be between 1 and 30 days", 400);
    }
    if (powerupsEnabled) {
      if (!powerupStepInterval || powerupStepInterval < 1000 || powerupStepInterval > 50000) {
        throw new RaceCreationError("Powerup step interval must be between 1,000 and 50,000", 400);
      }
    }

    const race = await raceModel.create({
      creatorId: userId,
      name: name.trim(),
      targetSteps,
      maxDurationDays,
      powerupsEnabled: !!powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? powerupStepInterval : null,
    });

    await participantModel.create({
      raceId: race.id,
      userId,
      status: "ACCEPTED",
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
