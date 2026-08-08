const {
  computePrizePool,
  buildPrizePoolPayload,
} = require("../../shared/economy/prizePool");
const {
  computeRacePayouts,
  computeFundedPayouts,
} = require("./racePayoutPresets");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("./constants/raceFinishReward");
const { raceTeamPoolMultBps } = require("./teamPoolMultiplier");

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

// Team settlement runs placement assignment INSIDE completeRace, so the loaded
// participant rows still have placement === null there. Count walkers instead —
// the same "no-shows don't mint" rule without depending on write ordering.
function teamSettlementPlayerCount(participants) {
  return (participants || []).filter(
    (p) => p.status === "ACCEPTED" && (p.totalSteps || 0) > 0
  ).length;
}

// The pool a funded race mints at settlement.
function computeSettledRacePool({ race, participants, isTeamRace = false }) {
  if (race?.fundedPrize !== true) return 0;
  const playerCount = isTeamRace
    ? teamSettlementPlayerCount(participants)
    : settlementPlayerCount(participants);
  return computePrizePool({
    playerCount,
    durationDays: raceDurationDays(race),
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

  if (!funded) {
    const heldPotCoins = rows.reduce(
      (sum, p) => (p.buyInStatus === "HELD" ? sum + (p.buyInAmount || 0) : sum),
      0
    );
    const projectedPotCoins = (race?.potCoins || 0) + heldPotCoins;
    const payouts = computeRacePayouts({
      preset: race?.payoutPreset,
      potCoins: projectedPotCoins,
      participantCount: acceptedCount,
    });
    // Legacy seeded races keep minting their graded finish reward until they
    // settle — retiring it unconditionally would silently zero out every
    // in-flight Daily/Weekly the moment this deploys (and, with the kill switch
    // off, would zero them permanently).
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
      payouts,
      finishReward:
        finishRewardPool > 0
          ? { pool: finishRewardPool, paidPlaces: finishRewardPlaces }
          : null,
    };
  }

  // Funded: nothing is ever held, and a completed race reads its STAMPED pool so
  // its numbers can never drift as the field changes afterwards.
  const playerCount = completed
    ? race?.isTeamRace
      ? teamSettlementPlayerCount(rows)
      : settlementPlayerCount(rows)
    : acceptedCount;
  // Item 5: the same stamped team multiplier settlement uses, so every read path
  // (list, detail, featured, public, share preview) projects the buffed pool.
  const multBps = raceTeamPoolMultBps(race);
  const coins = completed
    ? race?.prizePoolCoins || 0
    : computePrizePool({
        playerCount,
        durationDays: raceDurationDays(race),
        multBps,
      });

  return {
    prizePool: buildPrizePoolPayload({
      funded: true,
      playerCount,
      durationDays: raceDurationDays(race),
      projected: !completed,
      coins,
      multBps,
    }),
    // Frozen builds gate their charge + confirm sheets on buyInAmount, and render
    // projectedPotCoins as POT — so a funded race reports 0 and the pool there,
    // and an un-updated binary shows the right prize while charging nothing.
    buyInAmount: 0,
    potCoins: completed ? coins : 0,
    heldPotCoins: 0,
    projectedPotCoins: coins,
    payouts: computeFundedPayouts({
      preset: race?.payoutPreset,
      poolCoins: coins,
      participantCount: playerCount,
      // From the ROW, never the live flag — so the projection and the eventual
      // settlement (same function, same column) can never disagree, and a
      // historical race keeps displaying the tiers it actually paid.
      curve: race?.payoutCurve ?? null,
    }),
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
  teamSettlementPlayerCount,
  computeSettledRacePool,
  buildRaceMoneyView,
  serializePayouts,
};
