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
const { payoutRaceCoins } = require("../services/raceBuyIns");
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

  return async function completeRace({ raceId, winnerUserId, participantUserIds }) {
    const result = await raceModel.updateIfActive(raceId, {
      status: "COMPLETED",
      completedAt: now(),
      winnerUserId,
    });

    if (result.count === 0) {
      return null;
    }

    // Expire all remaining active effects and held powerups
    await effectModel.expireAllForRace(raceId);
    await powerupModel.expireAllForRace(raceId);

    const race = await raceModel.findById(raceId);
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
        eligible.length
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
