const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RacePowerup } = require("../models/racePowerup");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { awardCoins } = require("./awardCoins");
const {
  grantReferralRewardsForRace,
} = require("./grantReferralReward");
const { eventBus } = require("../events/eventBus");
const {
  computeRacePayouts,
  computeGradedPayouts,
} = require("../utils/racePayoutPresets");
const { payoutRaceCoins, refundRaceBuyIn } = require("../services/raceBuyIns");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../constants/raceFinishReward");

function buildCompleteRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const grantReferralRewards =
    dependencies.grantReferralRewardsForRace || grantReferralRewardsForRace;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

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
    const result = await raceModel.updateIfActive(raceId, {
      status: "COMPLETED",
      completedAt: now(),
      winnerUserId: isTeamSettlement ? null : winnerUserId,
      ...(isTeamSettlement ? { winnerTeam: winnerTeam || null } : {}),
    });

    if (result.count === 0) {
      return null;
    }

    // Expire all remaining active effects and held powerups
    await effectModel.expireAllForRace(raceId);
    await powerupModel.expireAllForRace(raceId);

    const race = await raceModel.findById(raceId);

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

      if (tie) {
        // TR-404: every PAID buy-in is refunded in full, forfeiters included,
        // via the existing REFUNDED status. No payouts, pot zeroed.
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
      } else if (race.potCoins > 0) {
        // TR-502/503/504: the winning team's NON-FORFEITED members split the
        // entire pot evenly — floor(pot / winners) each, remainder to the
        // team's top stepper (tiebreak: earliest joinedAt). Forfeiters stay in
        // placement history but get payoutCoins 0; their buy-in stays in the
        // pot. Deterministic: same inputs, same payout rows. TR-507 guarantees
        // winners >= 1 (a full-team forfeit collapses in the OTHER team's
        // favor before any settlement can crown this one).
        const winners = accepted
          .filter((p) => p.team === winnerTeam && !p.forfeitedAt)
          .sort((a, b) => {
            const stepDiff = (b.totalSteps || 0) - (a.totalSteps || 0);
            if (stepDiff !== 0) return stepDiff;
            const joinDiff =
              new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
            if (joinDiff !== 0) return joinDiff;
            return (a.userId || "").localeCompare(b.userId || "");
          });

        if (winners.length > 0) {
          const share = Math.floor(race.potCoins / winners.length);
          const remainder = race.potCoins - share * winners.length;
          for (let index = 0; index < winners.length; index++) {
            const amount = share + (index === 0 ? remainder : 0);
            if (amount <= 0) continue;
            await payoutRaceCoins({
              awardCoinsFn,
              userId: winners[index].userId,
              raceId,
              placement: 1,
              amount,
            });
            await participantModel.incrementPayoutCoins(
              winners[index].id,
              amount
            );
          }
        }
      }

      // Referral rewards behave exactly as for individual races.
      const teamReferralEvents = await grantReferralRewards({ race });

      events.emit("RACE_COMPLETED", {
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

      for (const payload of teamReferralEvents) {
        events.emit("REFERRAL_REWARDED", payload);
      }

      return race;
    }

    if (race?.potCoins > 0) {
      // Pay the buy-in pot out by finishing place. The number of paid places is
      // fixed for winner-takes-all/top-3 but scales with the field for the
      // field-scaled presets (top half, everyone but last), so drive the loop off
      // the computed payout array (index 0 = 1st) rather than a hard-coded
      // [1,2,3]. `participantCount` is the ranked field size — for the deadline
      // settlement path the whole accepted field is ranked, which is exactly what
      // those presets need.
      const rankedParticipants = race.participants
        .filter((participant) => participant.placement != null)
        .sort((a, b) => a.placement - b.placement);
      const payouts = computeRacePayouts({
        preset: race.payoutPreset || "WINNER_TAKES_ALL",
        potCoins: race.potCoins,
        participantCount: rankedParticipants.length,
      });

      for (let index = 0; index < payouts.length; index++) {
        const placement = index + 1;
        const amount = payouts[index] || 0;
        if (amount <= 0) continue;

        const recipient =
          rankedParticipants[index] ||
          (placement === 1
            ? race.participants.find((participant) => participant.userId === winnerUserId)
            : null);

        if (!recipient) continue;

        await payoutRaceCoins({
          awardCoinsFn,
          userId: recipient.userId,
          raceId,
          placement,
          amount,
        });
        await participantModel.incrementPayoutCoins(recipient.id, amount);
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
    if (Array.isArray(race?.participants)) {
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

      for (let index = 0; index < rewardSlots; index++) {
        const recipient = eligible[index];
        const amount = rewards[index] || 0;
        if (!recipient || amount <= 0) continue;

        await awardCoinsFn({
          userId: recipient.userId,
          amount,
          reason: "race_finish_reward",
          refId: `${raceId}:rank:${recipient.placement}`,
        });
        await participantModel.incrementPayoutCoins(recipient.id, amount);
      }
    }

    // Referral rewards (M2): when a referred user finishes their FIRST
    // *qualifying* race, pay the referrer and (double-sided) the referee. The
    // service is best-effort and never throws — it runs AFTER the buy-in/finish
    // payouts so a referral hiccup can't block settlement coins. It returns the
    // REFERRAL_REWARDED payloads to emit once the grant has committed (mirrors
    // joinRaceCore's deferred-emit-after-commit).
    const referralEvents = await grantReferralRewards({ race });

    events.emit("RACE_COMPLETED", {
      raceId,
      winnerUserId,
      participantUserIds,
    });

    for (const payload of referralEvents) {
      events.emit("REFERRAL_REWARDED", payload);
    }

    return race;
  };
}

const completeRace = buildCompleteRace();

module.exports = { buildCompleteRace, completeRace };
