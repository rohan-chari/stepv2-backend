const {
  RACE_PAYOUT_PRESETS,
  isRacePayoutPreset,
} = require("../racePayoutPresets");
const {
  buildAtomicHoldFn,
  creditBuyIn,
  ensureUserCanAfford,
  holdBuyIn,
} = require("../../../shared/economy/buyIns");

function normalizeBuyInAmount(buyInAmount) {
  if (buyInAmount == null || buyInAmount === 0) {
    return 0;
  }

  if (!Number.isInteger(buyInAmount)) {
    return NaN;
  }

  return buyInAmount;
}

function validateRaceBuyInConfig({ buyInAmount, payoutPreset, ErrorClass }) {
  const normalizedBuyInAmount = normalizeBuyInAmount(buyInAmount);
  const normalizedPayoutPreset =
    payoutPreset || RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL;

  if (Number.isNaN(normalizedBuyInAmount) || normalizedBuyInAmount < 0) {
    throw new ErrorClass("Buy-in amount must be 0 or greater", 400);
  }

  if (normalizedBuyInAmount > 0 && normalizedBuyInAmount < 10) {
    throw new ErrorClass("Buy-in amount must be at least 10 coins", 400);
  }

  if (normalizedBuyInAmount > 200) {
    throw new ErrorClass("Buy-in amount cannot exceed 200 coins", 400);
  }

  if (!isRacePayoutPreset(normalizedPayoutPreset)) {
    throw new ErrorClass("Invalid payout preset", 400);
  }

  return {
    buyInAmount: normalizedBuyInAmount,
    payoutPreset: normalizedPayoutPreset,
  };
}

// Race buy-in ledger: thin wrappers over shared/economy/buyIns supplying the
// race reason strings + refId templates. Race refIds are UNVERSIONED
// (raceId:userId) — a re-hold after leave→rejoin replays idempotently against
// the old row (see the Phase 4 notes in AUDIT.md); payout dedups per placement
// (raceId:placement), not per user.

async function reserveRaceBuyIn({ awardCoinsFn, userId, raceId, amount }) {
  return holdBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "race_buy_in_hold",
    refId: `${raceId}:${userId}`,
  });
}

async function refundRaceBuyIn({ awardCoinsFn, userId, raceId, amount }) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "race_buy_in_refund",
    refId: `${raceId}:${userId}`,
  });
}

async function payoutRaceCoins({
  awardCoinsFn,
  userId,
  raceId,
  placement,
  amount,
}) {
  return creditBuyIn({
    awardCoinsFn,
    userId,
    amount,
    reason: "race_buy_in_payout",
    refId: `${raceId}:${placement}`,
  });
}

module.exports = {
  buildAtomicHoldFn,
  ensureUserCanAfford,
  payoutRaceCoins,
  refundRaceBuyIn,
  reserveRaceBuyIn,
  validateRaceBuyInConfig,
};
