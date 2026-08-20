const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const {
  payoutTournamentPot,
  mintChampionPrize,
  mintTournamentPrizePool,
} = require("../services/tournamentBuyIns");
const { createRoundRaces } = require("../services/tournamentRounds");
const {
  totalRoundsFor,
  nextRoundPairings,
  roundLabel,
} = require("../constants/tournaments");
const { computePrizePool } = require("../../../shared/economy/prizePool");
const { tournamentDurationDays } = require("../queries/serializeTournament");
const { buildPayoutPlan, payoutRoundingMetadata } = require("../../races/services/payoutRounding");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");
const {
  resolveTournamentPrizeStamp,
  lockFundedExposureUsers,
} = require("../../races/services/fundedExposure");

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
  const lockFundedExposureUsersFn =
    dependencies.lockFundedExposureUsers || lockFundedExposureUsers;
  const now = dependencies.now || (() => new Date());
  const stepsModel = dependencies.Steps; // undefined -> createRoundRaces default

  return async function advanceTournament({ tournamentId }) {
    // Events to emit AFTER the transaction commits (settled DB state).
    const deferred = [];

    await db.$transaction(async (tx) => {
      await acquireGlobalEnrollmentLock(tx);
      // Discovery happens before the tournament row lock because the universal
      // order is global-event -> sorted user guards -> competition row. Guard
      // every survivor (and every already-recorded winner) for funded and
      // non-funded brackets alike: createRoundRaces writes ACCEPTED race
      // memberships, so account deletion must not pass between discovery and
      // that write.
      const advancementSnapshot = await tx.tournament.findUnique({
        where: { id: tournamentId },
        select: { status: true, currentRound: true },
      });
      if (advancementSnapshot?.status !== "ACTIVE") return;
      const discoveredAliveParticipants =
        await tx.tournamentParticipant.findMany({
          where: {
            tournamentId,
            status: "ACCEPTED",
            eliminatedInRound: null,
          },
          select: { userId: true },
        });
      const discoveredRoundWinners = advancementSnapshot.currentRound
        ? await tx.race.findMany({
            where: {
              tournamentId,
              tournamentRound: advancementSnapshot.currentRound,
              winnerUserId: { not: null },
            },
            select: { winnerUserId: true },
          })
        : [];
      const discoveredAdvancementUserIds = [
        ...new Set([
          ...discoveredAliveParticipants.map((participant) => participant.userId),
          ...discoveredRoundWinners.map((race) => race.winnerUserId),
        ].filter(Boolean)),
      ].sort();
      await lockFundedExposureUsersFn(tx, discoveredAdvancementUserIds);
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

      // Admission, settlement, or account deletion may have won between the
      // optimistic discovery and the row lock. Reread under both lock classes
      // and fail closed if any survivor/winner was not guarded; the safety
      // sweep can retry from a fresh snapshot without creating an unguarded
      // matchup membership.
      const lockedAdvancementParticipants =
        await tx.tournamentParticipant.findMany({
          where: {
            tournamentId,
            status: "ACCEPTED",
            eliminatedInRound: null,
          },
          select: { userId: true },
        });
      const guardedAdvancementUsers = new Set(discoveredAdvancementUserIds);
      if (
        lockedAdvancementParticipants.some(
          (participant) => !guardedAdvancementUsers.has(participant.userId),
        )
      ) return;

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
      const lockedAliveUsers = new Set(
        lockedAdvancementParticipants.map((participant) => participant.userId),
      );
      if (
        winners.some(
          (winnerUserId) =>
            !winnerUserId ||
            !guardedAdvancementUsers.has(winnerUserId) ||
            !lockedAliveUsers.has(winnerUserId),
        )
      ) return;
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

        const allParticipants = await tx.tournamentParticipant.findMany({
          where: { tournamentId, status: "ACCEPTED" },
          select: { userId: true },
        });

        // EXACTLY ONE prize path, in this order (spec §4.4):
        //   1. legacy pot   — an in-flight paid bracket created before the flip,
        //                     holding real COMMITTED coins. Must pay as today.
        //   2. featured seed — already app-funded (seed.championPrizeCoins), so it
        //                     keeps its configured amount and never also mints a
        //                     funded pool.
        //   3. funded pool  — free-entry bracket: mint
        //                     players × durationPoints(totalDays) × unit, clamped
        //                     to MAX_CHAMPION_PRIZE.
        // `fundedPrize` on the row (never the feature flag) gates branch 3, so a
        // mid-bracket flip can neither strand nor duplicate a champion prize.
        let prizeAmount = 0;
        let payoutPlan = null;
        if ((tournament.buyInAmount || 0) > 0 && (tournament.potCoins || 0) > 0) {
          payoutPlan = buildPayoutPlan({
            payoutRoundingVersion: tournament.payoutRoundingVersion,
            awards: [{ recipientId: championUserId, placement: 1, rawAwardCoins: tournament.potCoins || 0 }],
          });
          prizeAmount = payoutPlan.totals.awardCoins;
          await payoutTournamentPot({
            awardCoinsFn,
            userId: championUserId,
            tournamentId,
            amount: prizeAmount,
            ...(tournament.payoutRoundingVersion === 1
              ? { payoutMetadata: payoutPlan.awards[0] }
              : {}),
          });
        } else if (tournament.seedId && tournament.seed) {
          // Lobby snapshot wins. NULL is the deliberate legacy fallback for a
          // featured bracket minted before the snapshot migration.
          const rawPrizeAmount =
            tournament.championPrizeCoinsSnapshot ??
            tournament.seed.championPrizeCoins ??
            0;
          payoutPlan = buildPayoutPlan({
            payoutRoundingVersion: tournament.payoutRoundingVersion,
            awards: [{ recipientId: championUserId, placement: 1, rawAwardCoins: rawPrizeAmount }],
          });
          prizeAmount = payoutPlan.totals.awardCoins;
          await mintChampionPrize({
            awardCoinsFn,
            userId: championUserId,
            tournamentId,
            amount: prizeAmount,
            ...(tournament.payoutRoundingVersion === 1
              ? { payoutMetadata: payoutPlan.awards[0] }
              : {}),
          });
        } else if (tournament.fundedPrize === true) {
          const prizeStamp = resolveTournamentPrizeStamp(tournament);
          const rawPrizeAmount = computePrizePool({
            playerCount: allParticipants.length,
            durationDays: tournamentDurationDays(tournament),
            max: prizeStamp.tournamentChampionMaxCoins,
            unit: prizeStamp.prizeCoinUnit,
          });
          payoutPlan = buildPayoutPlan({
            payoutRoundingVersion: tournament.payoutRoundingVersion,
            awards: [{ recipientId: championUserId, placement: 1, rawAwardCoins: rawPrizeAmount }],
          });
          prizeAmount = payoutPlan.totals.awardCoins;
          await mintTournamentPrizePool({
            awardCoinsFn,
            userId: championUserId,
            tournamentId,
            amount: prizeAmount,
            ...(tournament.payoutRoundingVersion === 1
              ? { payoutMetadata: payoutPlan.awards[0] }
              : {}),
          });
          // Stamp the settled pool (and mirror it into potCoins so a frozen build
          // renders the real prize) inside the same transaction as the crowning.
          await tx.tournament.update({
            where: { id: tournamentId },
            data: {
              prizePoolCoins: prizeAmount,
              potCoins: prizeAmount,
              ...(tournament.payoutRoundingVersion === 1
                ? { payoutRoundingMetadata: payoutRoundingMetadata(payoutPlan) }
                : {}),
            },
          });
        }
        if (
          tournament.fundedPrize !== true &&
          tournament.payoutRoundingVersion === 1 &&
          payoutPlan
        ) {
          await tx.tournament.update({
            where: { id: tournamentId },
            data: { payoutRoundingMetadata: payoutRoundingMetadata(payoutPlan) },
          });
        }

        deferred.push({
          type: "TOURNAMENT_CHAMPION",
          tournamentId,
          tournamentName: tournament.name,
          userId: championUserId,
          prizeCoins: prizeAmount,
        });

        // 2026-07-25 §1 (D1): the TOURNAMENT_COMPLETED fan-out to every
        // non-champion is GONE. Everyone eliminated in an EARLIER round already
        // received exactly one TOURNAMENT_ELIMINATED at their own knockout, so
        // the fan-out was a second, later push about a bracket they were already
        // out of.
        //
        // D1-followup (owner-confirmed 2026-07-25): the RUNNER-UP is the one
        // exception, and killing the fan-out alone would have left them with NO
        // end-of-run push at all. TOURNAMENT_ELIMINATED is only emitted on the
        // round r -> r+1 transition below, and the final has no next round — so
        // the losing finalist never got one. Emit it here for them explicitly.
        // Result: every player gets exactly ONE end-of-run push — the champion's
        // TOURNAMENT_CHAMPION above, or their own TOURNAMENT_ELIMINATED.
        const runnerUpUserId = losers[0];
        if (runnerUpUserId) {
          deferred.push({
            type: "TOURNAMENT_ELIMINATED",
            tournamentId,
            tournamentName: tournament.name,
            userId: runnerUpUserId,
            label,
            opponentName: nameByUser.get(championUserId) || "your opponent",
          });
        }
        //
        // The events.on("TOURNAMENT_COMPLETED") handler is deliberately LEFT in
        // place: nothing emits it now, so it is inert, and removing it would be
        // a behaviour change for any future emitter. Old clients simply receive
        // one fewer push; their `tournament_completed` route case goes unused.
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
