const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");

// TR-205: leaving a PENDING team race is free — the HELD buy-in is released and
// the participant row is deleted, so a later re-join is a fresh join (either
// side). TR-208: the creator can never leave their own lobby (their exits are
// cancel/delete while PENDING or forfeit while ACTIVE). Team races only: the
// individual-race lobby has never had a leave affordance, and adding one would
// change shipped-client behavior.
class RaceLeaveError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceLeaveError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildLeaveRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;

  return async function leaveRace({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceLeaveError("Race not found", 404);
    }
    if (race.tournamentId) {
      throw new RaceLeaveError(
        "This race is managed by its tournament",
        400,
        "TOURNAMENT_RACE_LOCKED"
      );
    }
    if (!race.isTeamRace) {
      throw new RaceLeaveError("This race does not support leaving", 400);
    }
    if (race.creatorId === userId) {
      throw new RaceLeaveError(
        "The race creator can't leave — cancel the race instead",
        400
      );
    }
    if (race.status === "ACTIVE") {
      throw new RaceLeaveError(
        "The race has already started — you can forfeit instead",
        409,
        "RACE_ALREADY_STARTED"
      );
    }
    if (race.status !== "PENDING") {
      throw new RaceLeaveError("This race is no longer running", 400);
    }

    const participant = await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant) {
      throw new RaceLeaveError("You are not in this race", 403);
    }

    // Release a HELD buy-in before dropping the row (mirrors kickRaceParticipant).
    if (participant.buyInStatus === "HELD" && participant.buyInAmount > 0) {
      await refundRaceBuyIn({
        awardCoinsFn,
        userId,
        raceId,
        amount: participant.buyInAmount,
      });
    }

    await participantModel.delete(participant.id);

    events.emit("RACE_PARTICIPANT_LEFT", {
      raceId,
      userId,
      creatorUserId: race.creatorId,
      raceName: race.name,
    });

    return { success: true };
  };
}

const leaveRace = buildLeaveRace();

module.exports = { buildLeaveRace, leaveRace, RaceLeaveError };
