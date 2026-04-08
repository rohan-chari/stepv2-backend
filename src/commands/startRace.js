const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerupEvent } = require("../models/racePowerupEvent");
const { Steps } = require("../models/steps");
const { eventBus } = require("../events/eventBus");
const { isRacePayoutPresetCompatible } = require("../utils/racePayoutPresets");

class RaceStartError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceStartError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildStartRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const eventModel = dependencies.RacePowerupEvent || RacePowerupEvent;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function startRace({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceStartError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceStartError("Only the race creator can start the race", 403);
    }
    if (race.status !== "PENDING") {
      throw new RaceStartError("Race has already been started or is no longer active", 400);
    }

    const acceptedCount = await participantModel.countAccepted(raceId);
    if (acceptedCount < 2) {
      throw new RaceStartError("At least 2 accepted participants are required to start", 400);
    }

    if (
      !isRacePayoutPresetCompatible({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        acceptedCount,
      })
    ) {
      throw new RaceStartError(
        "This payout mode only supports races with at least 4 accepted participants",
        400
      );
    }

    const startedAt = now();
    const endsAt = new Date(startedAt.getTime() + race.maxDurationDays * 24 * 60 * 60 * 1000);
    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const heldPot = acceptedParticipants.reduce((sum, participant) => {
      if ((participant.buyInStatus || "NONE") === "HELD") {
        return sum + (participant.buyInAmount || 0);
      }
      return sum;
    }, 0);

    const updated = await raceModel.update(raceId, {
      status: "ACTIVE",
      startedAt,
      endsAt,
      potCoins: (race.potCoins || 0) + heldPot,
    });

    // Snapshot each participant's current steps so only post-race steps count
    const today = startedAt.toISOString().slice(0, 10);
    for (const p of acceptedParticipants) {
      const todaySteps = await stepsModel.findByUserIdAndDate(p.userId, today);
      const updateFields = {
        baselineSteps: todaySteps?.steps ?? 0,
        joinedAt: startedAt,
      };
      // Initialize powerup thresholds if powerups are enabled
      if (race.powerupsEnabled && race.powerupStepInterval) {
        updateFields.nextBoxAtSteps = race.powerupStepInterval;
      }
      if ((p.buyInAmount || 0) > 0 && p.buyInStatus === "HELD") {
        updateFields.buyInStatus = "COMMITTED";
      }
      await participantModel.update(p.id, updateFields);
    }

    const participantUserIds = acceptedParticipants.map((p) => p.userId);

    await eventModel.create({
      raceId,
      actorUserId: userId,
      eventType: "RACE_STARTED",
      description: "Race started!",
    });

    events.emit("RACE_STARTED", {
      raceId,
      raceName: race.name,
      creatorUserId: userId,
      participantUserIds,
    });

    return updated;
  };
}

const startRace = buildStartRace();

module.exports = { buildStartRace, startRace, RaceStartError };
