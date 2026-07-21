const { prisma: defaultPrisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { softRemoveAndRefund } = require("../services/tournamentParticipants");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");
const { assertFound, assertStatusIn } = require("../../../shared/competition/lifecycle");

// Leave a PENDING tournament lobby: refunds the held buy-in and soft-removes the
// participant. The creator cannot leave (they cancel instead). After start:
// TOURNAMENT_NOT_PENDING (use forfeit).
function buildLeaveTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const tournamentModel = dependencies.Tournament || Tournament;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;

  return async function leaveTournament({ userId, tournamentId, supportsCharacters }) {
    await withTournamentLock(
      tournamentId,
      async (tx) => {
        const tournament = assertFound(
          await tx.tournament.findUnique({ where: { id: tournamentId } }),
          () => new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND")
        );
        // Inverse of assertCreator (the creator must NOT be the caller) — a
        // leave-only rule, kept inline.
        if (tournament.creatorId === userId) {
          throw new TournamentError(
            "The creator can't leave — cancel the tournament instead",
            400,
            "CREATOR_CANNOT_LEAVE"
          );
        }
        assertStatusIn(
          tournament,
          ["PENDING"],
          () =>
            new TournamentError(
              "This tournament has already started",
              409,
              "TOURNAMENT_NOT_PENDING"
            )
        );
        const participant = await tx.tournamentParticipant.findUnique({
          where: { tournamentId_userId: { tournamentId, userId } },
        });
        if (!participant || participant.status !== "ACCEPTED") {
          throw new TournamentError(
            "You are not in this tournament",
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

const leaveTournament = buildLeaveTournament();

module.exports = { buildLeaveTournament, leaveTournament };
