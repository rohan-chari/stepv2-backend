const MAX_CASH_MINOR = 2147483647;
const MAX_COIN_PRIZE = 1000000;

function isPrizeInteger(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function isCashMinor(value) {
  return isPrizeInteger(value, MAX_CASH_MINOR);
}

function isCoinPrize(value) {
  return isPrizeInteger(value, MAX_COIN_PRIZE);
}

function hasEnabledPrize(contest) {
  return isCashMinor(contest?.cashMinor) && isCoinPrize(contest?.coinPrize) &&
    (contest.cashMinor > 0 || contest.coinPrize > 0);
}

function formatUsd(cashMinor) {
  const dollars = Math.floor(cashMinor / 100);
  const cents = cashMinor % 100;
  return `US$${dollars.toLocaleString("en-US")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

function formatCoins(coinPrize, { bara = true } = {}) {
  return `${coinPrize.toLocaleString("en-US")} ${bara ? "Bara " : ""}coins`;
}

function formatPrizeSummary(contest, { joiner = " + ", bara = true } = {}) {
  const parts = [];
  if (contest.cashMinor > 0) parts.push(formatUsd(contest.cashMinor));
  if (contest.coinPrize > 0) parts.push(formatCoins(contest.coinPrize, { bara }));
  return parts.join(joiner);
}

module.exports = {
  MAX_CASH_MINOR,
  MAX_COIN_PRIZE,
  formatCoins,
  formatPrizeSummary,
  formatUsd,
  hasEnabledPrize,
  isCashMinor,
  isCoinPrize,
};
