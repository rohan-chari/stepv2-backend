const { prisma: defaultPrisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { softRemoveAndRefund } = require("../services/tournamentParticipants");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");

// Creator-only kick of an ACCEPTED participant from a PENDING lobby. Same
// soft-remove + refund as leave.
function buildKickTournamentParticipant(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;

  return async function kickTournamentParticipant({
    userId,
    tournamentId,
    targetUserId,
    supportsCharacters,
  }) {
    await withTournamentLock(
      tournamentId,
      async (tx) => {
        const tournament = await tx.tournament.findUnique({
          where: { id: tournamentId },
        });
        if (!tournament) {
          throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }
        if (tournament.creatorId !== userId) {
          throw new TournamentError("Only the creator can kick", 403, "NOT_CREATOR");
        }
        if (tournament.status !== "PENDING") {
          throw new TournamentError(
            "This tournament has already started",
            409,
            "TOURNAMENT_NOT_PENDING"
          );
        }
        const participant = await tx.tournamentParticipant.findUnique({
          where: { tournamentId_userId: { tournamentId, userId: targetUserId } },
        });
        if (!participant || participant.status !== "ACCEPTED") {
          throw new TournamentError(
            "That player isn't in the lobby",
            404,
            "PARTICIPANT_NOT_FOUND"
          );
        }
        await softRemoveAndRefund({ tx, tournamentId, participant, awardCoinsFn });
      },
      { prisma: db }
    );

    const full = await tournamentModel.findById(tournamentId);
    return serializeTournamentPayload(full, userId, { supportsCharacters });
  };
}

const kickTournamentParticipant = buildKickTournamentParticipant();

module.exports = { buildKickTournamentParticipant, kickTournamentParticipant };
