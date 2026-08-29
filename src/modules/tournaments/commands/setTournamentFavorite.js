const { prisma: defaultPrisma } = require("../../../db");
const { NotFoundError, ValidationError } = require("../../../shared/errors/AppError");

function buildSetTournamentFavorite(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());

  return async function setTournamentFavorite({
    tournamentId,
    userId,
    favorite,
  }) {
    if (typeof favorite !== "boolean") {
      throw new ValidationError("favorite must be boolean", "INVALID_FAVORITE");
    }

    const row = await prisma.$transaction(async (tx) => {
      const participant = await tx.tournamentParticipant.findFirst({
        where: {
          tournamentId,
          userId,
          status: "ACCEPTED",
          tournament: { status: { not: "CANCELLED" } },
        },
        select: { id: true },
      });
      if (!participant) return null;

      if (favorite) {
        await tx.tournamentParticipant.updateMany({
          where: { id: participant.id, favoritedAt: null },
          data: { favoritedAt: now() },
        });
      } else {
        await tx.tournamentParticipant.update({
          where: { id: participant.id },
          data: { favoritedAt: null },
        });
      }

      return tx.tournamentParticipant.findUnique({
        where: { id: participant.id },
        select: { tournamentId: true, favoritedAt: true },
      });
    });

    if (!row) {
      throw new NotFoundError(
        "Tournament not found",
        "TOURNAMENT_NOT_FOUND",
      );
    }

    return {
      tournamentId: row.tournamentId,
      isFavorite: row.favoritedAt instanceof Date,
      favoritedAt: row.favoritedAt,
    };
  };
}

const setTournamentFavorite = buildSetTournamentFavorite();

module.exports = { buildSetTournamentFavorite, setTournamentFavorite };
