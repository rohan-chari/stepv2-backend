const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { serializeTournamentPayload } = require("./serializeTournament");

function buildGetTournamentDetail(dependencies = {}) {
  const tournamentModel = dependencies.Tournament || Tournament;
  const now = dependencies.now || (() => new Date());
  return async function getTournamentDetail({ userId, tournamentId }) {
    const tournament = await tournamentModel.findDetailV1(tournamentId);
    if (!tournament) {
      throw new TournamentError(
        "Tournament not found",
        404,
        "TOURNAMENT_NOT_FOUND"
      );
    }
    const mine = tournament.participants.find(
      (participant) => participant.userId === userId
    );
    const isParticipant = mine && mine.status !== "DECLINED";
    const canSeePending =
      tournament.status === "PENDING" &&
      (tournament.isPublic === true || mine?.status === "INVITED");
    if (!isParticipant && !canSeePending) {
      throw new TournamentError(
        "Tournament not found",
        404,
        "TOURNAMENT_NOT_FOUND"
      );
    }
    const result = serializeTournamentPayload(tournament, userId, {
      supportsCharacters: false,
      supportsRemoteAssets: false,
      now,
    });
    result.participants = result.participants.map(
      ({ animal: _animal, accessories: _accessories, ...participant }) =>
        participant
    );
    return result;
  };
}

const getTournamentDetail = buildGetTournamentDetail();

module.exports = { buildGetTournamentDetail, getTournamentDetail };
