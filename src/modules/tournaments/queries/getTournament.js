const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { serializeTournamentPayload } = require("./serializeTournament");

// GET /tournaments/:id — full bracket payload. Viewable by any participant
// (including eliminated, per D8) or, while PENDING, by anyone who can see it
// (public or via an outstanding invite). Otherwise 404 (don't leak existence).
function buildGetTournament(dependencies = {}) {
  const tournamentModel = dependencies.Tournament || Tournament;
  const now = dependencies.now || (() => new Date());

  return async function getTournament({ userId, tournamentId, supportsCharacters = false }) {
    const t = await tournamentModel.findById(tournamentId);
    if (!t) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    const myParticipant = (t.participants || []).find((p) => p.userId === userId);
    const isParticipant = myParticipant && myParticipant.status !== "DECLINED";
    const canSeePending =
      t.status === "PENDING" &&
      (t.isPublic === true ||
        (myParticipant && myParticipant.status === "INVITED"));
    if (!isParticipant && !canSeePending) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    return serializeTournamentPayload(t, userId, { supportsCharacters, now });
  };
}

const getTournament = buildGetTournament();

module.exports = { buildGetTournament, getTournament };
