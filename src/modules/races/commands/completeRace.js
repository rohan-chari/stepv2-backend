const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerup } = require("../../powerups/models/racePowerup");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const {
  grantReferralRewardsForRace,
} = require("../../social/commands/grantReferralReward");
const {
  createReferralQualificationIntents,
} = require("../../social/commands/processReferralQualificationIntents");
const {
  acquireReferralQualificationFence,
  isReferralQualifyingRace,
} = require("../../social/services/referralQualification");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const {
  computeRacePayouts,
  computeFundedPayouts,
  computeGradedPayouts,
} = require("../racePayoutPresets");
const {
  payoutRaceCoins,
  refundRaceBuyIn,
  payoutRacePrizePool,
} = require("../services/raceBuyIns");
const {
  computeSettledRacePool,
  settlementPlayerCount,
  quickSettlementParticipants,
} = require("../racePrizePool");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../constants/raceFinishReward");
const { prisma: defaultPrisma } = require("../../../db");
const { resolveMatchupWinner } = require("../../tournaments/constants/tournaments");
const {
  advanceTournament: defaultAdvanceTournament,
} = require("../../tournaments/commands/advanceTournament");
const { createReviewOpportunity: defaultCreateReviewOpportunity } = require("../services/reviewPrompt");
const {
  buildPayoutPlan,
  payoutRoundingMetadata,
} = require("../services/payoutRounding");
const {
  buildTeamPayoutPlan,
  teamPayoutRecipients,
} = require("../services/teamPayoutPlan");
const {
  lockFundedExposureUsers,
} = require("../services/fundedExposure");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const {
  resolveFixedTeamPayoutStamp,
} = require("../services/teamWinnerReward");

function buildCompleteRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const grantReferralRewards =
    dependencies.grantReferralRewardsForRace || grantReferralRewardsForRace;
  const compatibilityEvents = dependencies.eventBus || null;
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const now = dependencies.now || (() => new Date());
  const db = dependencies.prisma || defaultPrisma;
  const usesDefaultPersistence = !dependencies.Race && !dependencies.prisma;
  const advanceTournamentFn =
    dependencies.advanceTournament || defaultAdvanceTournament;
  const createReviewOpportunity =
    dependencies.createReviewOpportunity || defaultCreateReviewOpportunity;
  const touchCompletedResult = dependencies.touchCompletedResult ||
    ((usesDefaultPersistence || dependencies.prisma) &&
     typeof db?.$executeRaw === "function"
      ? async (raceId) => db.$executeRaw`
          UPDATE races
          SET updated_at = GREATEST(
            CURRENT_TIMESTAMP,
            updated_at + INTERVAL '1 millisecond'
          )
          WHERE id = ${raceId}
        `
      : typeof raceModel.update === "function"
        ? async (raceId) => raceModel.update(raceId, { updatedAt: now() })
        : async () => null);

  // A race status is a settlement *claim*, not a durable proof that each
  // idempotent ledger credit made it into its result row.  This reconciler is
  // deliberately fed only from the immutable v1 ledger artifacts, never from a
  // recalculated pool, so a retry after a process crash cannot mint a second
  // rounding subsidy or drift the displayed total.
  async function reconcileDurablePayoutArtifact(race) {
    const fixedTeamStamp = resolveFixedTeamPayoutStamp(race);
    if (
      !race ||
      (race.payoutRoundingVersion !== 1 && fixedTeamStamp == null) ||
      !db?.coinTransaction
    ) {
      return null;
    }
    const credits = await db.coinTransaction.findMany({
      where: {
        refId: { startsWith: `${race.id}:` },
        reason: {
          in: [
            "race_prize_pool_payout",
            "race_buy_in_payout",
            "race_finish_reward",
          ],
        },
      },
      select: { userId: true, amount: true, payoutMetadata: true },
    });
    const awards = credits
      .map((credit) => ({
        ...(credit.payoutMetadata && typeof credit.payoutMetadata === "object"
          ? credit.payoutMetadata
          : {}),
        recipientId: credit.payoutMetadata?.recipientId || credit.userId,
        rawAwardCoins: credit.payoutMetadata?.rawAwardCoins ?? credit.amount,
        awardCoins: credit.amount,
        roundingSubsidyCoins:
          credit.payoutMetadata?.roundingSubsidyCoins ?? 0,
      }))
      .filter((award) => award.awardCoins > 0);
    if (awards.length === 0) return null;

    const paidByUser = new Map();
    for (const credit of credits) {
      paidByUser.set(
        credit.userId,
        (paidByUser.get(credit.userId) || 0) + Math.max(0, credit.amount || 0)
      );
    }
    for (const participant of race.participants || []) {
      const payoutCoins = paidByUser.get(participant.userId) || 0;
      await db.raceParticipant.updateMany({
          where: { id: participant.id },
          data: { payoutCoins },
      });
    }

    const totals = awards.reduce(
      (summary, award) => ({
        rawAwardCoins: summary.rawAwardCoins + Math.max(0, award.rawAwardCoins || 0),
        awardCoins: summary.awardCoins + Math.max(0, award.awardCoins || 0),
        roundingSubsidyCoins:
          summary.roundingSubsidyCoins + Math.max(0, award.roundingSubsidyCoins || 0),
        recipientCount: summary.recipientCount + 1,
        smallAwardRecipientCount:
          summary.smallAwardRecipientCount +
          (award.rawAwardCoins > 0 && award.rawAwardCoins < 5 ? 1 : 0),
      }),
      {
        rawAwardCoins: 0,
        awardCoins: 0,
        roundingSubsidyCoins: 0,
        recipientCount: 0,
        smallAwardRecipientCount: 0,
      }
    );
    const payoutMetadata = {
        payoutRoundingVersion: 1,
        rawAwardCoins: totals.rawAwardCoins,
        roundedAwardCoins: totals.awardCoins,
        roundingSubsidyCoins: totals.roundingSubsidyCoins,
        recipientCount: totals.recipientCount,
        smallAwardRecipientCount: totals.smallAwardRecipientCount,
    };
    const data = race.payoutRoundingVersion === 1
      ? { payoutRoundingMetadata: payoutMetadata }
      : {};
    if (race.fundedPrize === true) {
      data.prizePoolCoins = totals.awardCoins;
      data.potCoins = totals.awardCoins;
    }
    await db.race.update({ where: { id: race.id }, data });
    return data.payoutRoundingMetadata || null;
  }

  // Team races (TR-400s/500s): callers pass `winnerTeam` (TEAM_A|TEAM_B) or
  // `tie: true` instead of winnerUserId — winnerUserId stays NULL for team
  // races (TR-402). Individual races are untouched: they never pass either.
  return async function completeRace({
    raceId,
    winnerUserId,
    participantUserIds,
    winnerTeam = null,
    tie = false,
  }) {
    const isTeamSettlement = Boolean(winnerTeam) || tie === true;
    const completionData = {
      status: "COMPLETED",
      completedAt: now(),
      winnerUserId: isTeamSettlement ? null : winnerUserId,
      ...(isTeamSettlement ? { winnerTeam: winnerTeam || null } : {}),
    };
    const result = usesDefaultPersistence
      ? await db.$transaction(async (tx) => {
          await acquireRaceWriteFence(tx, raceId);
          const exposureRace = await tx.race.findUnique({
            where: { id: raceId },
            select: { fundedPrize: true, seedId: true, tournamentId: true },
          });
          if (exposureRace?.fundedPrize === true) {
            const accepted = await tx.raceParticipant.findMany({
              where: { raceId, status: "ACCEPTED" },
              select: { userId: true },
            });
            // The locked membership snapshot, not the worker's optimistic
            // pre-fence list, is authoritative for funded settlement.
            participantUserIds = accepted.map((participant) => participant.userId);
            await lockFundedExposureUsers(
              tx,
              accepted.map((participant) => participant.userId),
            );
          }
          await tx.$queryRaw`
            SELECT id FROM races WHERE id = ${raceId} FOR UPDATE
          `;
          const lockedRace = await tx.race.findUnique({
            where: { id: raceId },
            select: {
              status: true, name: true, teamAName: true, teamBName: true,
            },
          });
          if (!lockedRace || lockedRace.status !== "ACTIVE") {
            return { count: 0 };
          }
          const updated = await tx.race.updateMany({
            where: { id: raceId, status: "ACTIVE" },
            data: completionData,
          });
          if (updated.count === 1) {
            if (!exposureRace?.tournamentId) {
              const completionParticipants = await tx.raceParticipant.findMany({
                where: { raceId, status: "ACCEPTED" },
                select: { userId: true, team: true },
              });
              await appendDomainEvent(tx, {
                eventKey: `RACE_COMPLETED_V1:${raceId}`,
                eventType: "RACE_COMPLETED_V1", schemaVersion: 1,
                aggregateType: "RACE", aggregateId: raceId,
                occurredAt: completionData.completedAt,
                payload: {
                  raceId, completionId: raceId,
                  winnerUserId: completionData.winnerUserId,
                  winnerTeam: winnerTeam || null, tie: tie === true,
                  winnerTeamName: tie ? null : winnerTeam === "TEAM_A" ? lockedRace.teamAName : lockedRace.teamBName,
                  loserTeamName: tie ? null : winnerTeam === "TEAM_A" ? lockedRace.teamBName : lockedRace.teamAName,
                },
                audience: completionParticipants.map((row) => ({
                  recipientId: row.userId, facts: { memberTeam: row.team },
                })),
              });
            }
            const walkers = await tx.raceParticipant.findMany({
              where: {
                raceId,
                status: "ACCEPTED",
                rawSteps: { gte: 2000 },
                userId: { in: participantUserIds || [] },
              },
              select: { userId: true },
            });
            const qualificationProjection = {
              seedId: exposureRace?.seedId,
              tournamentId: exposureRace?.tournamentId,
              participants: walkers.map((row) => ({ status: "ACCEPTED", rawSteps: 2000 })),
            };
            if (isReferralQualifyingRace(qualificationProjection)) {
              await acquireReferralQualificationFence(tx);
              await createReferralQualificationIntents({
                tx,
                raceId,
                qualifiedAt: completionData.completedAt,
                participantUserIds: walkers.map((row) => row.userId),
                seedId: exposureRace.seedId,
                tournamentId: exposureRace.tournamentId,
              });
            }
          }
          return updated;
        })
      : await raceModel.updateIfActive(raceId, completionData);

    // A payout-artifact retry must resume after the active->completed fence: a previous
    // process may have committed a ledger row just before dying.  Legacy rows
    // preserve their long-standing early-return behavior byte-for-byte.
    let isRecovery = false;
    if (result.count === 0) {
      const completedRace = await raceModel.findById(raceId);
      if (
        !completedRace ||
        completedRace.status !== "COMPLETED" ||
        completedRace.payoutRoundingVersion !== 1 &&
          resolveFixedTeamPayoutStamp(completedRace) == null
      ) {
        return null;
      }
      isRecovery = true;
    }

    // Expire all remaining active effects and held powerups
    await effectModel.expireAllForRace(raceId);
    await powerupModel.expireAllForRace(raceId);

    const race = await raceModel.findById(raceId);

    // ── Tournament matchup settlement ────────────────────────────────────────
    // A matchup race is an ordinary WINNER_TAKES_ALL race but the tournament
    // owns the money and advancement. Decide the winner with the D3 tiebreak
    // (earlier TournamentParticipant.joinedAt on an exact tie — NOT the generic
    // userId sort), stamp the loser's eliminatedInRound immediately (D12) so the
    // featured-join guard frees them the moment their matchup settles, and skip
    // the pot payout, minted finish reward, referral rewards, and RACE_COMPLETED
    // push (the tournament pushes replace it). Then drive advancement.
    if (race?.tournamentId) {
      const accepted = (race.participants || []).filter(
        (p) => p.status === "ACCEPTED"
      );
      const tps = await db.tournamentParticipant.findMany({
        where: {
          tournamentId: race.tournamentId,
          userId: { in: accepted.map((p) => p.userId) },
        },
        select: { id: true, userId: true, joinedAt: true, eliminatedInRound: true },
      });
      const tpByUser = new Map(tps.map((t) => [t.userId, t]));

      const players = accepted.map((p) => ({
        userId: p.userId,
        totalSteps: Math.max(0, Number(p.totalSteps) || 0),
        forfeited: p.forfeitedAt != null,
        tournamentJoinedAt: tpByUser.get(p.userId)?.joinedAt || p.joinedAt,
      }));

      let winnerUserId = null;
      let loserUserId = null;
      if (players.length === 2) {
        ({ winnerUserId, loserUserId } = resolveMatchupWinner(
          players[0],
          players[1]
        ));
      } else if (players.length === 1) {
        winnerUserId = players[0].userId;
      }

      // The flip set winnerUserId to the caller's provisional guess; correct it
      // to the tournament-tiebreak result.
      if (winnerUserId && race.winnerUserId !== winnerUserId) {
        await raceModel.update(raceId, { winnerUserId });
      }
      for (const p of accepted) {
        await participantModel.setPlacement(
          p.id,
          p.userId === winnerUserId ? 1 : 2
        );
      }

      // D12: free the loser immediately (only if not already eliminated).
      if (loserUserId) {
        const loserTp = tpByUser.get(loserUserId);
        if (loserTp && loserTp.eliminatedInRound == null) {
          if (usesDefaultPersistence) {
            await db.$transaction(async (tx) => {
              const tournament = await tx.tournament.findUnique({
                where: { id: race.tournamentId },
                select: { fundedPrize: true },
              });
              if (tournament?.fundedPrize === true) {
                await lockFundedExposureUsers(tx, [loserUserId]);
              }
              await tx.$queryRaw`
                SELECT id FROM tournaments
                WHERE id = ${race.tournamentId}
                FOR UPDATE
              `;
              await tx.tournamentParticipant.update({
                where: { id: loserTp.id },
                data: { eliminatedInRound: race.tournamentRound },
              });
            });
          } else {
            await db.tournamentParticipant.update({
              where: { id: loserTp.id },
              data: { eliminatedInRound: race.tournamentRound },
            });
          }
        }
      }

      // No pot/finish/referral, no RACE_COMPLETED emit. Drive advancement.
      await advanceTournamentFn({ tournamentId: race.tournamentId });
      await touchCompletedResult(raceId);
      return race;
    }

    if (race?.isTeamRace) {
      // ── Team settlement (one code path for deadline expiry, collapse, tie) ──
      const accepted = (race.participants || []).filter(
        (p) => p.status === "ACCEPTED"
      );

      // TR-403/404: placements are BY TEAM — every winner 1, every loser 2
      // (forfeiters keep their team's placement for history); a tie makes
      // everyone 1.
      for (const participant of accepted) {
        const placement = tie
          ? 1
          : participant.team === winnerTeam
            ? 1
            : 2;
        await participantModel.setPlacement(participant.id, placement);
      }

      // The shared planner owns recipient ordering, even splitting, remainder
      // assignment, and payout-v1 rounding for both projection and settlement.
      const fixedTeamStamp = resolveFixedTeamPayoutStamp(race);
      const payTeamPayout = async (
        recipients,
        prize,
        payFn,
        { tieAward = false } = {},
      ) => {
        if (
          recipients.length === 0 ||
          (fixedTeamStamp == null && prize <= 0)
        ) return;
        const plan = buildTeamPayoutPlan({
          recipients,
          prizeCoins: prize,
          payoutRoundingVersion: race.payoutRoundingVersion,
          fixedWinnerRewardCoins:
            fixedTeamStamp?.teamWinnerRewardCoins ?? null,
          tie: tieAward,
        });
        for (let index = 0; index < recipients.length; index++) {
          const award = plan.awards[index];
          const amount = award.awardCoins;
          if (amount <= 0) continue;
          const credit = await payFn({
            awardCoinsFn,
            userId: recipients[index].userId,
            raceId,
            placement: 1,
            amount,
            ...(race.payoutRoundingVersion === 1 ? { payoutMetadata: award } : {}),
          });
          if (credit?.awarded !== false) {
            await participantModel.incrementPayoutCoins(
              recipients[index].id,
              amount
            );
          }
        }
        return plan;
      };

      if (tie) {
        // TR-404: every PAID buy-in is refunded in full, forfeiters included,
        // via the existing REFUNDED status.
        for (const participant of accepted) {
          const paid =
            (participant.buyInAmount || 0) > 0 &&
            ["HELD", "COMMITTED"].includes(participant.buyInStatus);
          if (!paid) continue;
          await refundRaceBuyIn({
            awardCoinsFn,
            userId: participant.userId,
            raceId,
            amount: participant.buyInAmount,
          });
          await participantModel.update(participant.id, {
            buyInStatus: "REFUNDED",
          });
        }
        if (race.potCoins > 0) {
          await raceModel.update(raceId, { potCoins: 0 });
        }

        // Item 5 (2026-08-08, Rohan): a FUNDED tie mints the pool anyway and
        // splits it evenly across the non-forfeited members of BOTH teams —
        // everyone walked the whole race, so nobody should walk away with 0.
        // Buy-in (non-funded) ties are unchanged: their pot is committed coins,
        // already refunded above, and minting on top would double-pay.
        //
        // This also fixes a latent bug: the tie branch never stamped
        // prizePoolCoins, so a completed funded tie read as pool 0 on every
        // read path (buildRaceMoneyView reads the stamp once COMPLETED).
        if (race.fundedPrize === true) {
          const prize = fixedTeamStamp
            ? 0
            : computeSettledRacePool({
                race,
                participants: accepted,
                isTeamRace: true,
              });
          const sharers = teamPayoutRecipients({
            participants: accepted,
            tie: true,
          });
          const plan = await payTeamPayout(
            sharers,
            prize,
            payoutRacePrizePool,
            { tieAward: true },
          );
          await raceModel.update(raceId, {
            prizePoolCoins: plan?.totals.awardCoins ?? prize,
            potCoins: plan?.totals.awardCoins ?? prize,
            ...(race.payoutRoundingVersion === 1
              ? { payoutRoundingMetadata: payoutRoundingMetadata(plan) }
              : {}),
          });
        }
      } else if (race.fundedPrize === true || race.potCoins > 0) {
        // TR-502/503/504: the winning team's NON-FORFEITED members split the
        // entire prize evenly — floor(pot / winners) each, remainder to the
        // team's top stepper (tiebreak: earliest joinedAt). Forfeiters stay in
        // placement history but get payoutCoins 0; their buy-in stays in the
        // pot. Deterministic: same inputs, same payout rows. TR-507 guarantees
        // winners >= 1 (a full-team forfeit collapses in the OTHER team's
        // favor before any settlement can crown this one).
        const winners = teamPayoutRecipients({
          participants: accepted,
          winnerTeam,
        });

        // Funded team race: the prize is MINTED from the settled field instead of
        // being a committed pot. Mutually exclusive with the pot — fundedPrize on
        // the row is the only authority (never the feature flag), so a mid-race
        // flip can neither strand nor duplicate a prize.
        const funded = race.fundedPrize === true;
        const prize = funded
          ? fixedTeamStamp
            ? 0
            : computeSettledRacePool({
                race,
                participants: accepted,
                isTeamRace: true,
              })
          : race.potCoins;

        const plan = await payTeamPayout(
          winners,
          prize,
          funded ? payoutRacePrizePool : payoutRaceCoins
        );

        if (funded) {
          // Stamp the settled pool so results/history freeze forever, and mirror
          // it into potCoins so a frozen build's "POT" reads the real prize.
          await raceModel.update(raceId, {
            prizePoolCoins: plan?.totals.awardCoins ?? prize,
            potCoins: plan?.totals.awardCoins ?? prize,
            ...(race.payoutRoundingVersion === 1
              ? { payoutRoundingMetadata: payoutRoundingMetadata(plan) }
              : {}),
          });
        }
      }

      // Referral rewards behave exactly as for individual races. A recovery
      // replays ledger/result work only, never a second visible completion.
      const teamReferralEvents = isRecovery ? [] : await grantReferralRewards({ race });

      if (!isRecovery && !usesDefaultPersistence) {
        compatibilityEvents?.emit("RACE_COMPLETED", {
          raceId,
          winnerUserId: null,
          winnerTeam: winnerTeam || null,
          tie: tie === true,
          participantUserIds,
          // TR-684: team-framed completion copy needs names + each recipient's
          // side (win vs loss framing).
          winnerTeamName: tie
            ? null
            : winnerTeam === "TEAM_A"
              ? race.teamAName
              : race.teamBName,
          loserTeamName: tie
            ? null
            : winnerTeam === "TEAM_A"
              ? race.teamBName
              : race.teamAName,
          memberTeams: Object.fromEntries(
            accepted.map((p) => [p.userId, p.team])
          ),
        });
      }

      for (const payload of teamReferralEvents) compatibilityEvents?.emit("REFERRAL_REWARDED", payload);

      await reconcileDurablePayoutArtifact(race);
      await touchCompletedResult(raceId);

      return race;
    }

    // ── Prize: EXACTLY ONE of the two money models ───────────────────────────
    // `fundedPrize` on the row is the only authority (never
    // fundedPrizePoolsEnabled), so an in-flight buy-in race settles under the old
    // rules forever and a funded race under the new ones — and no race can ever
    // pay under both. A funded race's pool is computed from the SETTLED field
    // (accepted + ranked + actually walked), so no-shows and alt accounts mint
    // nothing, then stamped so the numbers freeze.
    const isFundedRace = race?.fundedPrize === true;
    if (isFundedRace) {
      const quickQualifiers = quickSettlementParticipants(race, race.participants);
      const rankedParticipants = (quickQualifiers || race.participants || [])
        // A frozen forfeiter remains in the settled funded-player count when
        // they walked, but can never receive a tier. The payout array stays
        // sized by that full pool; assigning tiers to this filtered sequence
        // deterministically redistributes every coin to eligible finishers.
        .filter(
          (participant) =>
            participant.placement != null && participant.forfeitedAt == null
        )
        .sort((a, b) => a.placement - b.placement);
      const eligibleRecipients = (quickQualifiers || race.participants || [])
        .filter(
          (participant) =>
            participant.placement != null &&
            participant.forfeitedAt == null &&
            (quickQualifiers || (participant.totalSteps || 0) > 0)
        )
        .sort((a, b) => a.placement - b.placement);
      const pool = computeSettledRacePool({
        race,
        participants: race.participants,
      });
      // Preserve the legacy field sizing. The new exit-policy compaction below
      // is an explicit second input, never a reinterpretation of this count.
      const settledFieldSize = quickQualifiers
        ? quickQualifiers.length >= 2
          ? quickQualifiers.length
          : 0
        : settlementPlayerCount(race.participants);
      const payouts = computeFundedPayouts({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        poolCoins: pool,
        // The pool count intentionally includes positive-step forfeits, but
        // paid places are recalculated over only eligible finishers so no tier
        // is stranded. computeFundedPayouts always sums to pool for this field.
        participantCount: settledFieldSize,
        eligibleRecipientCount:
          race.exitActionsEnabled === true && race.isTeamRace !== true
            ? eligibleRecipients.length
            : null,
        // Stamped at creation; the row is the authority here exactly as
        // fundedPrize is, so the curve a race advertised is the curve it pays.
        curve: race.payoutCurve ?? null,
      });

      const fundedAwards = [];
      for (let index = 0; index < payouts.length; index++) {
        const placement = index + 1;
        const amount = payouts[index] || 0;
        if (amount <= 0) continue;
        const recipient = rankedParticipants[index];
        if (!recipient) continue;
        fundedAwards.push({ recipient, placement, rawAwardCoins: amount });
      }
      // Quick-race settlement shares the C0 global participant-write order.
      // Legacy settlement retains its historical placement order.
      if (quickQualifiers) {
        fundedAwards.sort((a, b) =>
          String(a.recipient.userId).localeCompare(String(b.recipient.userId))
        );
      }
      const plan = buildPayoutPlan({
        payoutRoundingVersion: race.payoutRoundingVersion,
        awards: fundedAwards.map((award) => ({
          recipientId: award.recipient.id,
          placement: award.placement,
          rawAwardCoins: award.rawAwardCoins,
        })),
      });
      for (let index = 0; index < fundedAwards.length; index++) {
        const { recipient, placement } = fundedAwards[index];
        const award = plan.awards[index];
        const amount = award.awardCoins;
        const credit = await payoutRacePrizePool({
          awardCoinsFn,
          userId: recipient.userId,
          raceId,
          placement,
          amount,
          ...(race.payoutRoundingVersion === 1 ? { payoutMetadata: award } : {}),
        });
        if (credit?.awarded !== false) {
          await participantModel.incrementPayoutCoins(recipient.id, amount);
        }
      }

      await raceModel.update(raceId, {
        prizePoolCoins: plan.totals.awardCoins,
        potCoins: plan.totals.awardCoins,
        ...(race.payoutRoundingVersion === 1
          ? { payoutRoundingMetadata: payoutRoundingMetadata(plan) }
          : {}),
      });
    } else if (race?.potCoins > 0) {
      // Pay the buy-in pot out by finishing place. The number of paid places is
      // fixed for winner-takes-all/top-3 but scales with the field for the
      // field-scaled presets (top half, everyone but last), so drive the loop off
      // the computed payout array (index 0 = 1st) rather than a hard-coded
      // [1,2,3]. `participantCount` is the ranked field size — for the deadline
      // settlement path the whole accepted field is ranked, which is exactly what
      // those presets need.
      const rankedParticipants = race.participants
        .filter(
          (participant) =>
            participant.placement != null && participant.forfeitedAt == null
        )
        .sort((a, b) => a.placement - b.placement);
      const payouts = computeRacePayouts({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        potCoins: race.potCoins,
        participantCount: rankedParticipants.length,
        eligibleRecipientCount:
          race.exitActionsEnabled === true && race.isTeamRace !== true
            ? rankedParticipants.length
            : null,
      });

      const plan = buildPayoutPlan({
        payoutRoundingVersion: race.payoutRoundingVersion,
        awards: payouts.map((rawAwardCoins, index) => ({
          recipientId: `placement:${index + 1}`,
          placement: index + 1,
          rawAwardCoins,
        })),
      });
      for (let index = 0; index < payouts.length; index++) {
        const placement = index + 1;
        const award = plan.awards[index];
        const amount = award.awardCoins;
        if (amount <= 0) continue;

        const recipient =
          rankedParticipants[index] ||
          (placement === 1
            ? race.participants.find((participant) => participant.userId === winnerUserId)
            : null);

        if (!recipient) continue;

        const credit = await payoutRaceCoins({
          awardCoinsFn,
          userId: recipient.userId,
          raceId,
          placement,
          amount,
          ...(race.payoutRoundingVersion === 1 ? { payoutMetadata: award } : {}),
        });
        if (credit?.awarded !== false) {
          await participantModel.incrementPayoutCoins(recipient.id, amount);
        }
      }
    }

    // System-funded graded reward for seeded races (the daily/weekly
    // challenges, which have no buy-in pot). A minted pool is split across a
    // concentrated set of top finishers, higher placers earning more. Both the
    // pool size and the number of paid places scale with the field (see
    // src/constants/raceFinishReward.js) so a big challenge mints a bigger prize
    // and still pays only a handful of meaningful places. This is independent of
    // the buy-in pot path above — a race could in principle have both — and uses
    // its own reason/refId so the two never collide. It runs at most once per
    // race: completeRace early-returns above once the race is COMPLETED, and
    // awardCoins dedups on (reason, refId) for retries.
    //
    // RETIRED for funded races (spec §4.3): a funded seeded challenge's prize IS
    // the app-minted pool above, so this must not fire on top of it. It stays
    // reachable for fundedPrize=false races only — otherwise every seeded Daily/
    // Weekly already in flight at deploy time (and, with the kill switch off, all
    // of them) would silently pay nothing.
    if (!isFundedRace && Array.isArray(race?.participants)) {
      // Only people who actually walked are eligible; rank by the placement set
      // at race resolution (raceExpiry assigns 1..N before completing).
      const eligible = race.participants
        .filter(
          (participant) =>
            participant.status === "ACCEPTED" &&
            participant.placement != null &&
            (participant.totalSteps || 0) > 0
        )
        .sort((a, b) => a.placement - b.placement);

      // Pool + paid places are derived from the actual finisher count, not the
      // accepted count — no-shows neither mint coins nor claim a place.
      const finishRewardPool = computeFinishRewardPool(
        race?.seedId,
        eligible.length
      );
      const rewardSlots = computeFinishRewardPlaces(
        race?.seedId,
        eligible.length,
        finishRewardPool
      );
      const rewards = computeGradedPayouts({
        pool: finishRewardPool,
        count: rewardSlots,
      });

      const plan = buildPayoutPlan({
        payoutRoundingVersion: race.payoutRoundingVersion,
        awards: rewards.map((rawAwardCoins, index) => ({
          recipientId: eligible[index]?.id,
          placement: eligible[index]?.placement ?? index + 1,
          rawAwardCoins,
        })),
      });
      for (let index = 0; index < rewardSlots; index++) {
        const recipient = eligible[index];
        const award = plan.awards[index];
        const amount = award.awardCoins;
        if (!recipient || amount <= 0) continue;

        const credit = await awardCoinsFn({
          userId: recipient.userId,
          amount,
          reason: "race_finish_reward",
          refId: `${raceId}:rank:${recipient.placement}`,
          ...(race.payoutRoundingVersion === 1 ? { payoutMetadata: award } : {}),
        });
        if (credit?.awarded !== false) {
          await participantModel.incrementPayoutCoins(recipient.id, amount);
        }
      }
      // Legacy model fakes — and, more importantly, legacy rows — retain the
      // pre-v1 behavior. There is no metadata to persist when rounding is off.
      if (race.payoutRoundingVersion === 1) {
        await raceModel.update(raceId, {
          payoutRoundingMetadata: payoutRoundingMetadata(plan),
        });
      }
    }

    // Referral rewards (M2): when a referred user finishes their FIRST
    // *qualifying* race, pay the referrer and (double-sided) the referee. The
    // service is best-effort and never throws — it runs AFTER the buy-in/finish
    // payouts so a referral hiccup can't block settlement coins. It returns the
    // REFERRAL_REWARDED payloads to emit once the grant has committed (mirrors
    // joinRaceCore's deferred-emit-after-commit).
    // Reconciliation performs no second notification/referral fan-out.  Coin
    // mutations themselves retain their deterministic ledger refs.
    const referralEvents = isRecovery ? [] : await grantReferralRewards({ race });

    // The only v1 review trigger is a completed first-place finish. Teams and
    // ties have no individual winnerUserId; forfeiters never receive one.
    const winningParticipant = race?.participants?.find(
      (participant) => participant.userId === winnerUserId && participant.forfeitedAt == null
    );
    if (!isRecovery && !isTeamSettlement && winningParticipant && winnerUserId) {
      try {
        await createReviewOpportunity({ prisma: db, userId: winnerUserId, raceId, now: now() });
      } catch (error) {
        // A review opportunity is optional product UX, never a reason to roll
        // back a frozen result/payout.
        console.error("Create review opportunity error:", error);
      }
    }

    if (!isRecovery && !usesDefaultPersistence) {
      compatibilityEvents?.emit("RACE_COMPLETED", {
        raceId,
        winnerUserId,
        participantUserIds,
      });
    }

    for (const payload of referralEvents) compatibilityEvents?.emit("REFERRAL_REWARDED", payload);

    await reconcileDurablePayoutArtifact(race);
    await touchCompletedResult(raceId);

    return race;
  };
}

const completeRace = buildCompleteRace();

module.exports = { buildCompleteRace, completeRace };
