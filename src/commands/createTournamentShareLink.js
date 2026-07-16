const { prisma: defaultPrisma } = require("../db");
const { Tournament } = require("../models/tournament");
const { generateShareToken } = require("../utils/shareToken");
const { TournamentError } = require("../services/tournamentErrors");

// Returns the tournament's shareable token (minted at creation; re-minted here
// only defensively if somehow absent). Any ACCEPTED participant may share.
function buildCreateTournamentShareLink(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const mintToken = dependencies.generateShareToken || generateShareToken;

  return async function createTournamentShareLink({ userId, tournamentId }) {
    const tournament = await tournamentModel.findById(tournamentId);
    if (!tournament) {
      throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
    }
    const isMember = (tournament.participants || []).some(
      (p) => p.userId === userId && p.status === "ACCEPTED"
    );
    if (!isMember) {
      throw new TournamentError(
        "Only a participant can share this tournament",
        403,
        "NOT_INVITED"
      );
    }
    if (tournament.shareToken) {
      return { shareToken: tournament.shareToken };
    }
    const shareToken = mintToken();
    await db.tournament.update({
      where: { id: tournamentId },
      data: { shareToken },
    });
    return { shareToken };
  };
}

const createTournamentShareLink = buildCreateTournamentShareLink();

module.exports = { buildCreateTournamentShareLink, createTournamentShareLink };
