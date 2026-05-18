const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");

class RaceKickError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceKickError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildKickRaceParticipant(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function kickRaceParticipant({ userId, raceId, targetUserId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceKickError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceKickError("Only the race creator can remove participants", 403);
    }
    if (targetUserId === userId) {
      throw new RaceKickError("You cannot remove yourself", 400);
    }
    if (race.status !== "PENDING" && race.status !== "ACTIVE") {
      throw new RaceKickError("Cannot modify a completed or cancelled race", 400);
    }

    const target = await participantModel.findByRaceAndUser(raceId, targetUserId);
    if (!target) {
      throw new RaceKickError("That user is not in this race", 404);
    }

    if (target.buyInStatus === "HELD" && target.buyInAmount > 0) {
      await refundRaceBuyIn({
        awardCoinsFn,
        userId: targetUserId,
        raceId,
        amount: target.buyInAmount,
      });
    }

    await participantModel.delete(target.id);

    events.emit("RACE_PARTICIPANT_KICKED", {
      raceId,
      kickedUserId: targetUserId,
      creatorUserId: userId,
      raceName: race.name,
    });

    return { success: true };
  };
}

const kickRaceParticipant = buildKickRaceParticipant();

module.exports = {
  buildKickRaceParticipant,
  kickRaceParticipant,
  RaceKickError,
};
