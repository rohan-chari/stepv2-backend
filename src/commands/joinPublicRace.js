const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { User } = require("../models/user");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const {
  ensureUserCanAfford,
  reserveRaceBuyIn,
} = require("../services/raceBuyIns");

class RaceJoinError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceJoinError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildJoinPublicRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const userModel = dependencies.User || User;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function joinPublicRace({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceJoinError("Race not found", 404);
    }
    if (!race.isPublic) {
      throw new RaceJoinError("This race is not public", 403);
    }
    if (race.status !== "PENDING") {
      throw new RaceJoinError(
        "This race is no longer accepting new participants",
        400
      );
    }

    const existing = await participantModel.findByRaceAndUser(raceId, userId);
    if (existing) {
      throw new RaceJoinError("You are already in this race", 400);
    }

    const acceptedCount = race.participants.filter(
      (p) => p.status === "ACCEPTED"
    ).length;
    const maxParticipants = race.maxParticipants || 10;
    if (acceptedCount >= maxParticipants) {
      throw new RaceJoinError("This race is full", 400);
    }

    const buyInAmount = race.buyInAmount || 0;
    if (buyInAmount > 0) {
      await ensureUserCanAfford({
        userModel,
        userId,
        amount: buyInAmount,
        ErrorClass: RaceJoinError,
      });
    }

    const participant = await participantModel.create({
      raceId,
      userId,
      status: "ACCEPTED",
      buyInAmount,
      buyInStatus: buyInAmount > 0 ? "HELD" : "NONE",
    });

    if (buyInAmount > 0) {
      await reserveRaceBuyIn({
        awardCoinsFn,
        userId,
        raceId,
        amount: buyInAmount,
      });
    }

    events.emit("RACE_PUBLIC_JOINED", {
      raceId,
      userId,
      creatorUserId: race.creatorId,
      raceName: race.name,
    });

    return participant;
  };
}

const joinPublicRace = buildJoinPublicRace();

module.exports = { buildJoinPublicRace, joinPublicRace, RaceJoinError };
