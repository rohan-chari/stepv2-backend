const crypto = require("node:crypto");
const { hashAppleSub } = require("../../users/appleSubHash");

const CAPABILITY = "race_payout_double";
// New clients advertise this token so an old backend worker rejects the
// request instead of claiming a flat-mode offer with legacy math.
const FLAT_CAPABILITY = "race_payout_flat_50";
const LEGACY_REWARD_MODE = "legacy_double";
const FLAT_50_REWARD_MODE = "flat_50";
const FLAT_50_COINS_PER_RACE = 50;
const MAX_ROLLOUT = 100;
// Product-level issuance ceiling. Environment configuration may tune the bonus
// downward, but no offer or claim path may raise it above 100 coins.
const HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS = 100;

function providerSubHash(user) {
  return hashAppleSub(user?.appleId || user?.googleSub || null);
}

function cohortBucket(hash) {
  if (typeof hash !== "string" || hash.length === 0) return null;
  const digest = crypto
    .createHash("sha256")
    .update(`race_payout_double:v1:${hash}`, "utf8")
    .digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) + BigInt(digest[index]);
  }
  return Number(value % 100n);
}

function boundedRolloutPercent(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ROLLOUT
    ? value
    : 0;
}

function boundedRacePayoutDoubleMaxBonus(value) {
  return Number.isInteger(value) &&
    value >= 1 &&
    value <= HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS
    ? value
    : HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS;
}

function nonNegativeWhole(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function computeRacePayoutDoubleBonus({
  baseCoins,
  configuredMaxBonusCoins,
  rolling24hRemaining,
}) {
  return Math.min(
    nonNegativeWhole(baseCoins),
    boundedRacePayoutDoubleMaxBonus(configuredMaxBonusCoins),
    nonNegativeWhole(rolling24hRemaining),
    HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS,
  );
}

function normalizedRacePayoutDoubleAmounts(offer, {
  configuredMaxBonusCoins = offer?.maxBonusCoins,
  rolling24hRemaining = offer?.rolling24hRemainingBeforeClaim,
} = {}) {
  // Amounts on a persisted offer are an immutable economic snapshot. In
  // particular, a legacy pending offer must not be rewritten from baseCoins,
  // a later runtime cap, or rolling usage. The optional allowance arguments
  // remain accepted for callers compiled against the old policy.
  if (offer?.rewardMode === LEGACY_REWARD_MODE) {
    return {
      baseCoins: offer?.baseCoins,
      bonusCoins: offer?.bonusCoins,
      maxBonusCoins: offer?.maxBonusCoins,
      rolling24hRemainingBeforeClaim: offer?.rolling24hRemainingBeforeClaim,
      rewardMode: LEGACY_REWARD_MODE,
    };
  }
  if (offer?.rewardMode === FLAT_50_REWARD_MODE) {
    return {
      baseCoins: nonNegativeWhole(offer?.baseCoins),
      bonusCoins: nonNegativeWhole(offer?.bonusCoins),
      // Numeric compatibility fields mirror the batch total so frozen
      // clients' legacy `bonusCoins <= maxBonusCoins` parser accepts it.
      maxBonusCoins: nonNegativeWhole(offer?.bonusCoins),
      rolling24hRemainingBeforeClaim: nonNegativeWhole(offer?.bonusCoins),
      rewardMode: FLAT_50_REWARD_MODE,
    };
  }
  const maxBonusCoins = boundedRacePayoutDoubleMaxBonus(
    configuredMaxBonusCoins,
  );
  const rolling24hRemainingBeforeClaim = Math.min(
    maxBonusCoins,
    nonNegativeWhole(rolling24hRemaining),
  );
  const baseCoins = nonNegativeWhole(offer?.baseCoins);
  const bonusCoins = computeRacePayoutDoubleBonus({
    baseCoins: Math.min(baseCoins, nonNegativeWhole(offer?.bonusCoins)),
    configuredMaxBonusCoins: maxBonusCoins,
    rolling24hRemaining: rolling24hRemainingBeforeClaim,
  });
  return {
    baseCoins,
    bonusCoins,
    maxBonusCoins,
    rolling24hRemainingBeforeClaim,
  };
}

function canonicalUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function safeStructuredEvent(logger, event) {
  try {
    const fn = logger?.info || logger?.log;
    if (typeof fn !== "function") return;
    const result = fn.call(logger, JSON.stringify(event));
    // Observability is deliberately fire-and-forget. Attach a rejection
    // handler without awaiting so async transports cannot create an unhandled
    // rejection or alter the economic request's status/latency.
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {}
}

module.exports = {
  CAPABILITY,
  FLAT_CAPABILITY,
  LEGACY_REWARD_MODE,
  FLAT_50_REWARD_MODE,
  FLAT_50_COINS_PER_RACE,
  HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS,
  providerSubHash,
  cohortBucket,
  boundedRolloutPercent,
  boundedRacePayoutDoubleMaxBonus,
  computeRacePayoutDoubleBonus,
  normalizedRacePayoutDoubleAmounts,
  canonicalUuid,
  safeStructuredEvent,
};
