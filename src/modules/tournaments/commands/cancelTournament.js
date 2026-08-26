const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { Tournament } = require("../models/tournament");
const { TournamentError } = require("../services/tournamentErrors");
const { withTournamentLock } = require("../services/tournamentLock");
const { refundTournamentBuyIn } = require("../services/tournamentBuyIns");
const {
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
} = require("../../../shared/competition/lifecycle");

// Creator-only cancel of a PENDING tournament: refund every HELD buy-in, flip to
// CANCELLED, and push TOURNAMENT_CANCELLED to accepted + invited. After start it
// cannot be cancelled (409 TOURNAMENT_NOT_PENDING) — the creator can forfeit.
function buildCancelTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const compatibilityEvents = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function cancelTournament({ userId, tournamentId }) {
    const { deferred } = await withTournamentLock(
      tournamentId,
      async (tx, def) => {
        const tournament = assertFound(
          await tx.tournament.findUnique({
            where: { id: tournamentId },
            include: { participants: true },
          }),
          () => new TournamentError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND")
        );
        // creatorId null (featured) matches no caller -> NOT_CREATOR.
        assertCreator(
          tournament,
          userId,
          () => new TournamentError("Only the creator can cancel", 403, "NOT_CREATOR")
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

        for (const p of tournament.participants) {
          await refundHeldBuyIn({
            participant: p,
            awardCoinsFn,
            refundFn: ({ awardCoinsFn: fn, userId: uid, amount, participant }) =>
              refundTournamentBuyIn({
                awardCoinsFn: fn,
                userId: uid,
                tournamentId,
                amount,
                version: participant.buyInVersion || 0,
              }),
            onRefunded: (participant) =>
              tx.tournamentParticipant.update({
                where: { id: participant.id },
                data: {
                  buyInStatus: "REFUNDED",
                  buyInVersion: (participant.buyInVersion || 0) + 1,
                },
              }),
          });
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
              cancellationId: tournamentId,
              tournamentName: tournament.name,
              userId: p.userId,
              buyInAmount: tournament.buyInAmount || 0,
            });
          }
        }
      },
      {
        prisma: db,
        resolveUserIds: async (tx) => {
          const participants = await tx.tournamentParticipant.findMany({
            where: { tournamentId },
            select: { userId: true },
          });
          return participants.map((row) => row.userId);
        },
      }
    );

    for (const payload of deferred) {
      compatibilityEvents?.emit(payload.type, payload);
    }
    return { success: true };
  };
}

const cancelTournament = buildCancelTournament();

module.exports = { buildCancelTournament, cancelTournament };
