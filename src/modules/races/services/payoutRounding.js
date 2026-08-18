// Canonical payout-rounding contract (feature batch 2026-08-17 §4.15).
//
// Callers must first produce the historical, whole-coin split. This module then
// transforms each recipient independently. Keeping raw and final values in one
// immutable plan prevents a serializer, a ledger writer, and an ad offer from
// each applying a subtly different rounding rule.

const PAYOUT_ROUNDING_LEGACY = 0;
const PAYOUT_ROUNDING_V1 = 1;

function normalizeVersion(value) {
  return value === PAYOUT_ROUNDING_V1
    ? PAYOUT_ROUNDING_V1
    : PAYOUT_ROUNDING_LEGACY;
}

function nonNegativeWhole(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function roundUpToFive(amount) {
  const whole = nonNegativeWhole(amount);
  if (whole === 0) return 0;
  return Math.max(5, Math.ceil(whole / 5) * 5);
}

function buildPayoutPlan({ payoutRoundingVersion, awards = [] } = {}) {
  const version = normalizeVersion(payoutRoundingVersion);
  const normalizedAwards = (Array.isArray(awards) ? awards : []).map((row) => {
    const rawAwardCoins = nonNegativeWhole(row?.rawAwardCoins);
    const awardCoins = version === PAYOUT_ROUNDING_V1
      ? roundUpToFive(rawAwardCoins)
      : rawAwardCoins;
    return {
      recipientId: row?.recipientId,
      placement: row?.placement,
      rawAwardCoins,
      awardCoins,
      roundingSubsidyCoins: awardCoins - rawAwardCoins,
    };
  });
  const totals = normalizedAwards.reduce((summary, award) => ({
    rawAwardCoins: summary.rawAwardCoins + award.rawAwardCoins,
    awardCoins: summary.awardCoins + award.awardCoins,
    roundingSubsidyCoins: summary.roundingSubsidyCoins + award.roundingSubsidyCoins,
    recipientCount: summary.recipientCount + (award.awardCoins > 0 ? 1 : 0),
    smallAwardRecipientCount: summary.smallAwardRecipientCount +
      (award.rawAwardCoins > 0 && award.rawAwardCoins < 5 ? 1 : 0),
  }), {
    rawAwardCoins: 0,
    awardCoins: 0,
    roundingSubsidyCoins: 0,
    recipientCount: 0,
    smallAwardRecipientCount: 0,
  });
  return { payoutRoundingVersion: version, awards: normalizedAwards, totals };
}

function payoutRoundingMetadata(plan) {
  if (!plan || typeof plan !== "object") return null;
  const totals = plan.totals || {};
  return {
    payoutRoundingVersion: normalizeVersion(plan.payoutRoundingVersion),
    rawAwardCoins: nonNegativeWhole(totals.rawAwardCoins),
    roundedAwardCoins: nonNegativeWhole(totals.awardCoins),
    roundingSubsidyCoins: nonNegativeWhole(totals.roundingSubsidyCoins),
    recipientCount: nonNegativeWhole(totals.recipientCount),
    smallAwardRecipientCount: nonNegativeWhole(totals.smallAwardRecipientCount),
  };
}

module.exports = {
  PAYOUT_ROUNDING_LEGACY,
  PAYOUT_ROUNDING_V1,
  buildPayoutPlan,
  normalizeVersion,
  payoutRoundingMetadata,
  roundUpToFive,
};
