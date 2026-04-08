const {
  RACE_PAYOUT_PRESETS,
  isRacePayoutPreset,
} = require("../utils/racePayoutPresets");

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

  if (!isRacePayoutPreset(normalizedPayoutPreset)) {
    throw new ErrorClass("Invalid payout preset", 400);
  }

  return {
    buyInAmount: normalizedBuyInAmount,
    payoutPreset: normalizedPayoutPreset,
  };
}

async function ensureUserCanAfford({ userModel, userId, amount, ErrorClass }) {
  if (!amount) return;

  const user = await userModel.findById(userId);
  if (!user || user.coins < amount) {
    throw new ErrorClass("You do not have enough coins for this buy-in", 400);
  }
}

async function reserveRaceBuyIn({ awardCoinsFn, userId, raceId, amount }) {
  if (!amount) return null;

  return awardCoinsFn({
    userId,
    amount: -amount,
    reason: "race_buy_in_hold",
    refId: `${raceId}:${userId}`,
  });
}

async function refundRaceBuyIn({ awardCoinsFn, userId, raceId, amount }) {
  if (!amount) return null;

  return awardCoinsFn({
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
  if (!amount) return null;

  return awardCoinsFn({
    userId,
    amount,
    reason: "race_buy_in_payout",
    refId: `${raceId}:${placement}`,
  });
}

module.exports = {
  ensureUserCanAfford,
  payoutRaceCoins,
  refundRaceBuyIn,
  reserveRaceBuyIn,
  validateRaceBuyInConfig,
};
