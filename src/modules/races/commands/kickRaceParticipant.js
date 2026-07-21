const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

class RaceKickError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceKickError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildKickRaceParticipant(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function kickRaceParticipant({ userId, raceId, targetUserId }) {
    const race = assertFound(
      await raceModel.findById(raceId),
      () => new RaceKickError("Race not found", 404)
    );
    if (race.tournamentId) {
      throw new RaceKickError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    assertCreator(
      race,
      userId,
      () => new RaceKickError("Only the race creator can remove participants", 403)
    );
    if (targetUserId === userId) {
      throw new RaceKickError("You cannot remove yourself", 400);
    }
    assertStatusIn(
      race,
      ["PENDING", "ACTIVE"],
      () => new RaceKickError("Cannot modify a completed or cancelled race", 400)
    );

    const target = await participantModel.findByRaceAndUser(raceId, targetUserId);
    if (!target) {
      throw new RaceKickError("That user is not in this race", 404);
    }

    await refundHeldBuyIn({
      participant: target,
      awardCoinsFn,
      refundFn: ({ awardCoinsFn: fn, userId: uid, amount }) =>
        refundRaceBuyIn({ awardCoinsFn: fn, userId: uid, raceId, amount }),
    });

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
