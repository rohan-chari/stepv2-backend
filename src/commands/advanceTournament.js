const { prisma: defaultPrisma } = require("../db");
const { eventBus } = require("../events/eventBus");
const { awardCoins } = require("./awardCoins");
const {
  payoutTournamentPot,
  mintChampionPrize,
} = require("../services/tournamentBuyIns");
const { createRoundRaces } = require("../services/tournamentRounds");
const {
  totalRoundsFor,
  nextRoundPairings,
  roundLabel,
} = require("../constants/tournaments");

// Advance a tournament when its current round is fully settled. Idempotent and
// concurrency-safe: runs under a tournament FOR UPDATE lock, and the
// @@unique([tournamentId, round, matchIndex]) on races makes a double round
// creation a hard DB error rather than duplicate matchups.
//
// Losers' eliminatedInRound is stamped at MATCHUP completion (completeRace
// tournament branch, D12) so a round-1 loser is freed immediately; this service
// only READS it and drives the round-level side effects (next-round creation or
// champion crowning) plus the grouped pushes.
function buildAdvanceTournament(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const events = dependencies.eventBus || eventBus;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const now = dependencies.now || (() => new Date());
  const stepsModel = dependencies.Steps; // undefined -> createRoundRaces default

  return async function advanceTournament({ tournamentId }) {
    // Events to emit AFTER the transaction commits (settled DB state).
    const deferred = [];

    await db.$transaction(async (tx) => {
      // FOR UPDATE lock so two settling matchups (or the safety sweep) can't both
      // advance the same round.
      const lockedRows = await tx.$queryRaw`
        SELECT id FROM "tournaments" WHERE id = ${tournamentId} FOR UPDATE
      `;
      if (!lockedRows || lockedRows.length === 0) return;

      const tournament = await tx.tournament.findUnique({
        where: { id: tournamentId },
        include: { seed: { select: { championPrizeCoins: true } } },
      });
      if (!tournament || tournament.status !== "ACTIVE") return;

      const round = tournament.currentRound;
      if (!round || round < 1) return;

      const roundRaces = await tx.race.findMany({
        where: { tournamentId, tournamentRound: round },
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            include: { user: { select: { id: true, displayName: true } } },
          },
        },
        orderBy: { tournamentMatchIndex: "asc" },
      });

      if (roundRaces.length === 0) return;
      // No-op until every current-round matchup has settled.
      if (roundRaces.some((r) => r.status !== "COMPLETED")) return;

      // Name lookup for pushes.
      const nameByUser = new Map();
      for (const r of roundRaces) {
        for (const p of r.participants) {
          nameByUser.set(p.userId, p.user?.displayName || "Someone");
        }
      }

      // Winners in match order.
      const winners = roundRaces.map((r) => r.winnerUserId);
      const losers = roundRaces.map((r) => {
        const loser = r.participants.find((p) => p.userId !== r.winnerUserId);
        return loser ? loser.userId : null;
      });

      const totalRounds = totalRoundsFor(tournament.bracketSize);
      const label = roundLabel(tournament.bracketSize, round);

      if (round >= totalRounds) {
        // ── The final ──
        const championUserId = winners[0];
        await tx.tournament.update({
          where: { id: tournamentId },
          data: {
            championUserId,
            status: "COMPLETED",
            completedAt: now(),
          },
        });

        // Exactly one prize path: pot (paid user tournament) OR minted (seeded).
        if ((tournament.buyInAmount || 0) > 0 && (tournament.potCoins || 0) > 0) {
          await payoutTournamentPot({
            awardCoinsFn,
            userId: championUserId,
            tournamentId,
            amount: tournament.potCoins,
          });
        } else if (tournament.seedId && tournament.seed) {
          await mintChampionPrize({
            awardCoinsFn,
            userId: championUserId,
            tournamentId,
            amount: tournament.seed.championPrizeCoins || 0,
          });
        }

        const prizeAmount =
          (tournament.buyInAmount || 0) > 0
            ? tournament.potCoins || 0
            : tournament.seed
              ? tournament.seed.championPrizeCoins || 0
              : 0;

        deferred.push({
          type: "TOURNAMENT_CHAMPION",
          tournamentId,
          tournamentName: tournament.name,
          userId: championUserId,
          prizeCoins: prizeAmount,
        });

        const allParticipants = await tx.tournamentParticipant.findMany({
          where: { tournamentId, status: "ACCEPTED" },
          select: { userId: true },
        });
        for (const p of allParticipants) {
          if (p.userId === championUserId) continue;
          deferred.push({
            type: "TOURNAMENT_COMPLETED",
            tournamentId,
            tournamentName: tournament.name,
            userId: p.userId,
            championName: nameByUser.get(championUserId) || "The champion",
          });
        }
        return;
      }

      // ── Not the final: build round r+1 ──
      const pairIndices = nextRoundPairings(roundRaces.length);
      const nextMatchups = pairIndices.map(([m0, m1]) => [winners[m0], winners[m1]]);

      const startedAt = now();
      const nextRound = round + 1;
      const createdRaces = await createRoundRaces({
        tx,
        tournament,
        round: nextRound,
        matchups: nextMatchups,
        startedAt,
        stepsModel,
      });

      await tx.tournament.update({
        where: { id: tournamentId },
        data: { currentRound: nextRound },
      });

      const nextLabel = roundLabel(tournament.bracketSize, nextRound);

      // Grouped pushes: winners advanced, losers knocked out this round.
      for (const winnerId of winners) {
        deferred.push({
          type: "TOURNAMENT_MATCHUP_WON",
          tournamentId,
          tournamentName: tournament.name,
          userId: winnerId,
          nextLabel,
        });
      }
      for (let i = 0; i < losers.length; i++) {
        const loserId = losers[i];
        if (!loserId) continue;
        deferred.push({
          type: "TOURNAMENT_ELIMINATED",
          tournamentId,
          tournamentName: tournament.name,
          userId: loserId,
          label,
          opponentName: nameByUser.get(winners[i]) || "your opponent",
        });
      }
      // Round-start pushes carry each survivor's new opponent + raceId.
      for (const created of createdRaces) {
        const [a, b] = created.userIds;
        deferred.push({
          type: "TOURNAMENT_ROUND_STARTED",
          tournamentId,
          tournamentName: tournament.name,
          userId: a,
          raceId: created.raceId,
          label: nextLabel,
          opponentName: nameByUser.get(b) || "your opponent",
          days: tournament.matchupDurationDays,
        });
        deferred.push({
          type: "TOURNAMENT_ROUND_STARTED",
          tournamentId,
          tournamentName: tournament.name,
          userId: b,
          raceId: created.raceId,
          label: nextLabel,
          opponentName: nameByUser.get(a) || "your opponent",
          days: tournament.matchupDurationDays,
        });
      }
    });

    for (const payload of deferred) {
      events.emit(payload.type, payload);
    }

    return deferred;
  };
}

const advanceTournament = buildAdvanceTournament();

module.exports = { buildAdvanceTournament, advanceTournament };
