const { prisma: defaultPrisma } = require("../db");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { refundTournamentBuyIn } = require("../services/tournamentBuyIns");

// Creator-only cancel of a PENDING tournament: refund every HELD buy-in, flip to
// CANCELLED, and push TOURNAMENT_CANCELLED to accepted + invited. After start it
// cannot be cancelled (409 TOURNAMENT_NOT_PENDING) — the creator can forfeit.
function buildCancelTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function cancelTournament({ userId, tournamentId }) {
    const { deferred } = await withTournamentLock(
      tournamentId,
      async (tx, def) => {
        const tournament = await tx.tournament.findUnique({
          where: { id: tournamentId },
          include: { participants: true },
        });
        if (!tournament) {
          throw new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        }
        // creatorId null (featured) matches no caller -> NOT_CREATOR.
        if (tournament.creatorId !== userId) {
          throw new TournamentError("Only the creator can cancel", 403, "NOT_CREATOR");
        }
        if (tournament.status !== "PENDING") {
          throw new TournamentError(
            "This tournament has already started",
            409,
            "TOURNAMENT_NOT_PENDING"
          );
        }

        for (const p of tournament.participants) {
          if ((p.buyInAmount || 0) > 0 && p.buyInStatus === "HELD") {
            await refundTournamentBuyIn({
              awardCoinsFn,
              userId: p.userId,
              tournamentId,
              amount: p.buyInAmount,
              version: p.buyInVersion || 0,
            });
            await tx.tournamentParticipant.update({
              where: { id: p.id },
              data: {
                buyInStatus: "REFUNDED",
                buyInVersion: (p.buyInVersion || 0) + 1,
              },
            });
          }
        }

        await tx.tournament.update({
          where: { id: tournamentId },
          data: { status: "CANCELLED", completedAt: now() },
        });

        for (const p of tournament.participants) {
          if (p.status === "ACCEPTED" || p.status === "INVITED") {
            def.push({
              type: "TOURNAMENT_CANCELLED",
              tournamentId,
              tournamentName: tournament.name,
              userId: p.userId,
              buyInAmount: tournament.buyInAmount || 0,
            });
          }
        }
      },
      { prisma: db }
    );

    for (const payload of deferred) {
      events.emit(payload.type, payload);
    }
    return { success: true };
  };
}

const cancelTournament = buildCancelTournament();

module.exports = { buildCancelTournament, cancelTournament };
