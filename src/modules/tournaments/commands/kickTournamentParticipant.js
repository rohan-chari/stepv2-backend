const { prisma: defaultPrisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { softRemoveAndRefund } = require("../services/tournamentParticipants");
const {
  serializeTournamentPayload,
} = require("../queries/serializeTournament");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
} = require("../../../shared/competition/lifecycle");

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
    supportsRemoteAssets = false,
  }) {
    await withTournamentLock(
      tournamentId,
      async (tx, _deferred, lockedTournament) => {
        const tournament = assertFound(
          lockedTournament,
          () => new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND")
        );
        assertCreator(
          tournament,
          userId,
          () => new TournamentError("Only the creator can kick", 403, "NOT_CREATOR")
        );
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
      { prisma: db, userIds: [targetUserId] }
    );

    const full = await tournamentModel.findById(tournamentId);
    return serializeTournamentPayload(full, userId, {
      supportsCharacters,
      supportsRemoteAssets,
    });
  };
}

const kickTournamentParticipant = buildKickTournamentParticipant();

module.exports = { buildKickTournamentParticipant, kickTournamentParticipant };
