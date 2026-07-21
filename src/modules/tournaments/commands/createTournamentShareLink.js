const { prisma: defaultPrisma } = require("../../../db");
const { Tournament } = require("../models/tournament");
const { generateShareToken } = require("../../../shared/lib/shareToken");
const { TournamentError } = require("../services/tournamentErrors");
const {
  assertAcceptedParticipant,
  assertFound,
  reuseOrMintShareToken,
} = require("../../../shared/competition/lifecycle");

// Returns the tournament's shareable token (minted at creation; re-minted here
// only defensively if somehow absent). Any ACCEPTED participant may share.
function buildCreateTournamentShareLink(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const mintToken = dependencies.generateShareToken || generateShareToken;

  return async function createTournamentShareLink({ userId, tournamentId }) {
    const tournament = assertFound(
      await tournamentModel.findById(tournamentId),
      () => new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND")
    );

    assertAcceptedParticipant(
      tournament,
      userId,
      () =>
        new TournamentError(
          "Only a participant can share this tournament",
          403,
          "NOT_INVITED"
        )
    );

    return reuseOrMintShareToken({
      entity: tournament,
      mintToken,
      persist: (shareToken) =>
        db.tournament.update({
          where: { id: tournamentId },
          data: { shareToken },
        }),
    });
  };
}

const createTournamentShareLink = buildCreateTournamentShareLink();

module.exports = { buildCreateTournamentShareLink, createTournamentShareLink };
