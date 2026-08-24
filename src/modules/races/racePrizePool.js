const {
  computePrizePool,
  buildPrizePoolPayload,
} = require("../../shared/economy/prizePool");
const {
  computeRacePayouts,
  computeFundedPayouts,
  computeGradedPayouts,
} = require("./racePayoutPresets");
const { buildPayoutPlan } = require("./services/payoutRounding");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("./constants/raceFinishReward");
const { raceTeamPoolMultBps } = require("./teamPoolMultiplier");
const { resolveRacePrizeStamp } = require("./services/fundedExposure");

// One place that decides what a race's money looks like, for every read path AND
// for settlement. Two mutually exclusive models, discriminated by the row's
// `fundedPrize` column (never the feature flag — see completeRace):
//
//   fundedPrize = false  ->  the legacy buy-in pot, byte-for-byte as before.
//   fundedPrize = true   ->  entry is free and the app mints
//                            players × durationPoints(days) × PRIZE_COIN_UNIT.
//
// Projection vs settlement use DIFFERENT player counts on purpose (spec §4.1):
// the projection counts every ACCEPTED runner (so the pool visibly grows on each
// join), settlement counts only runners who actually walked (so no-shows and alt
// accounts can't mint coins). Every pre-settlement figure is therefore labelled
// projected.

// The race's duration in days, matching how startRace derives endsAt.
function raceDurationDays(race) {
  return race?.maxDurationDays || 7;
}

// Settlement field: ACCEPTED, ranked, and actually walked. Exactly the `eligible`
// filter completeRace has always used for the minted seeded reward.
function settlementPlayerCount(participants) {
  return (participants || []).filter(
    (p) =>
      p.status === "ACCEPTED" &&
      p.placement != null &&
      (p.totalSteps || 0) > 0
  ).length;
}

function quickSettlementParticipants(race, participants) {
  if (
    race?.creationSource !== "QUICK_CREATE" ||
    race?.startPolicy !== "ON_MINIMUM_PARTICIPANTS"
  ) {
    return null;
  }
  return (participants || []).filter(
    (p) =>
      p.status === "ACCEPTED" &&
      p.placement != null &&
      typeof p.rawSteps === "number" &&
      p.rawSteps >= 2000
  );
}

// Team settlement runs placement assignment INSIDE completeRace, so the loaded
// participant rows still have placement === null there. Count walkers instead —
// the same "no-shows don't mint" rule without depending on write ordering.
function teamSettlementPlayerCount(participants) {
  return (participants || []).filter(
    (p) => p.status === "ACCEPTED" && (p.totalSteps || 0) > 0
  ).length;
}

// An ACTIVE forfeiter with a positive frozen total remains an entrant in the
// projected funded pool. A zero-step forfeiter is a no-show immediately, so
// their amount is removed before settlement as well as by settlementPlayerCount.
function activeFundedProjectionPlayerCount(participants, acceptedCount) {
  const rows = participants || [];
  if (rows.length === 0) return acceptedCount;
  return rows.filter(
    (p) =>
      p.status === "ACCEPTED" &&
      !(p.forfeitedAt != null && (p.totalSteps || 0) <= 0)
  ).length;
}

// The pool a funded race mints at settlement.
function computeSettledRacePool({ race, participants, isTeamRace = false }) {
  if (race?.fundedPrize !== true) return 0;
  const quick = quickSettlementParticipants(race, participants);
  const playerCount = quick
    ? quick.length >= 2
      ? quick.length
      : 0
    : isTeamRace
      ? teamSettlementPlayerCount(participants)
      : settlementPlayerCount(participants);
  const prizeStamp = resolveRacePrizeStamp(race);
  return computePrizePool({
    playerCount,
    durationDays: raceDurationDays(race),
    unit: prizeStamp.prizeCoinUnit,
    max: prizeStamp.prizePoolMaxCoins,
    // Item 5: the team payout buff, from the ROW's stamp — never from env here,
    // so settlement can only ever pay what the projection advertised.
    multBps: raceTeamPoolMultBps(race),
  });
}

// The money block every race read path serializes. `acceptedCount` is the
// caller's already-computed ACCEPTED count (all four read paths derive it for
// other fields too).
function buildRaceMoneyView({ race, participants, acceptedCount }) {
  const rows = participants || race?.participants || [];
  const funded = race?.fundedPrize === true;
  const completed = race?.status === "COMPLETED";
  const compactForExitPolicy =
    race?.exitActionsEnabled === true && race?.isTeamRace !== true;
  const completedQuick = completed
    ? quickSettlementParticipants(race, rows)
    : null;
  const payoutVersion = race?.payoutRoundingVersion ?? 0;
  const withholdTeamProjection =
    payoutVersion === 1 && race?.isTeamRace === true && !completed;
  const finalAwards = (rawPayouts) => buildPayoutPlan({
    payoutRoundingVersion: payoutVersion,
    awards: (rawPayouts || []).map((rawAwardCoins, index) => ({
      recipientId: `placement:${index + 1}`,
      placement: index + 1,
      rawAwardCoins,
    })),
  });
  // Match completeRace exactly: for quick races only qualifying walkers rank;
  // otherwise every placed participant ranks, while a forfeiter never gets a
  // payout tier. This compacting is exclusive to the stamped new protocol.
  const exitEligibleRecipientCount = !compactForExitPolicy
    ? null
    : completed
      ? (completedQuick || rows).filter(
          (p) =>
            p.placement != null &&
            p.forfeitedAt == null &&
            (completedQuick || (p.totalSteps || 0) > 0)
        ).length
      : race?.status === "ACTIVE"
        ? rows.filter(
            (p) => p.status === "ACCEPTED" && p.forfeitedAt == null
          ).length
        : null;

  if (!funded) {
    const heldPotCoins = rows.reduce(
      (sum, p) => (p.buyInStatus === "HELD" ? sum + (p.buyInAmount || 0) : sum),
      0
    );
    const projectedPotCoins = (race?.potCoins || 0) + heldPotCoins;
    const rawPayouts = computeRacePayouts({
      preset: race?.payoutPreset,
      potCoins: projectedPotCoins,
      participantCount: acceptedCount,
      eligibleRecipientCount: exitEligibleRecipientCount,
    });
    // Legacy seeded races keep minting their graded finish reward until they
    // settle — retiring it unconditionally would silently zero out every
    // in-flight Daily/Weekly the moment this deploys (and, with the kill switch
    // off, would zero them permanently).
    const payoutPlan = finalAwards(rawPayouts);
    const finishRewardPool = computeFinishRewardPool(race?.seedId, acceptedCount);
    const finishRewardPlaces = computeFinishRewardPlaces(
      race?.seedId,
      acceptedCount,
      finishRewardPool
    );
    return {
      prizePool: null,
      buyInAmount: race?.buyInAmount || 0,
      potCoins: race?.potCoins || 0,
      heldPotCoins,
      projectedPotCoins,
      payouts: payoutPlan.awards.map((award) => award.awardCoins),
      finishReward:
        finishRewardPool > 0
          ? (() => {
              const rewards = computeGradedPayouts({
                pool: finishRewardPool,
                count: finishRewardPlaces,
              });
              const rewardPlan = finalAwards(rewards);
              return {
                pool: rewardPlan.totals.awardCoins,
                paidPlaces: finishRewardPlaces,
              };
            })()
          : null,
    };
  }

  // Funded: nothing is ever held, and a completed race reads its STAMPED pool so
  // its numbers can never drift as the field changes afterwards.
  const playerCount = completed
    ? completedQuick
      ? completedQuick.length >= 2
        ? completedQuick.length
        : 0
      : race?.isTeamRace
        ? teamSettlementPlayerCount(rows)
        : settlementPlayerCount(rows)
    : race?.status === "ACTIVE" &&
        race?.exitActionsEnabled === true &&
        race?.isTeamRace !== true
      ? activeFundedProjectionPlayerCount(rows, acceptedCount)
      : acceptedCount;
  // A positive-step forfeiter keeps the pool size but is never eligible for a
  // tier. Project the tier table over eligible finishers so the UI matches the
  // deterministic full redistribution that completeRace will perform.
  // Item 5: the same stamped team multiplier settlement uses, so every read path
  // (list, detail, featured, public, share preview) projects the buffed pool.
  const multBps = raceTeamPoolMultBps(race);
  const prizeStamp = resolveRacePrizeStamp(race);
  const coins = completed
    ? race?.prizePoolCoins || 0
    : computePrizePool({
        playerCount,
        durationDays: raceDurationDays(race),
        multBps,
        unit: prizeStamp.prizeCoinUnit,
        max: prizeStamp.prizePoolMaxCoins,
      });

  const rawPayouts = computeFundedPayouts({
    preset: race?.payoutPreset,
    poolCoins: coins,
    participantCount: playerCount,
    eligibleRecipientCount: exitEligibleRecipientCount,
    curve: race?.payoutCurve ?? null,
  });
  const payoutPlan = finalAwards(rawPayouts);
  const completedV1Payouts = payoutVersion === 1 && completed
    ? rows
      .filter((p) => p.placement != null && (p.payoutCoins || 0) > 0)
      .sort((a, b) => a.placement - b.placement)
      .map((p) => p.payoutCoins)
    : null;
  const visiblePayouts = completedV1Payouts || payoutPlan.awards.map((award) => award.awardCoins);
  const visibleTotal = visiblePayouts.reduce((sum, amount) => sum + amount, 0);
  if (withholdTeamProjection) {
    return {
      prizePool: null,
      buyInAmount: 0,
      potCoins: 0,
      heldPotCoins: 0,
      projectedPotCoins: undefined,
      payouts: [],
      finishReward: null,
    };
  }
  return {
    prizePool: buildPrizePoolPayload({
      funded: true,
      playerCount,
      durationDays: raceDurationDays(race),
      projected: !completed,
      coins: payoutVersion === 1 ? visibleTotal : coins,
      multBps,
      unit: prizeStamp.prizeCoinUnit,
      max: prizeStamp.prizePoolMaxCoins,
    }),
    // Frozen builds gate their charge + confirm sheets on buyInAmount, and render
    // projectedPotCoins as POT — so a funded race reports 0 and the pool there,
    // and an un-updated binary shows the right prize while charging nothing.
    buyInAmount: 0,
    potCoins: completed ? (payoutVersion === 1 ? visibleTotal : coins) : 0,
    heldPotCoins: 0,
    projectedPotCoins: payoutVersion === 1 ? visibleTotal : coins,
    payouts: visiblePayouts,
    // Retired as a pool source for funded races (spec §4.3). No client reads it.
    finishReward: null,
  };
}

// The legacy {first,second,third} + payoutTiers[] pair every read path emits.
function serializePayouts(payouts) {
  return {
    payouts: {
      first: payouts[0] || 0,
      second: payouts[1] || 0,
      third: payouts[2] || 0,
    },
    payoutTiers: payouts.map((amount, index) => ({
      placement: index + 1,
      amount,
    })),
  };
}

module.exports = {
  raceDurationDays,
  settlementPlayerCount,
  quickSettlementParticipants,
  teamSettlementPlayerCount,
  activeFundedProjectionPlayerCount,
  computeSettledRacePool,
  buildRaceMoneyView,
  serializePayouts,
};
