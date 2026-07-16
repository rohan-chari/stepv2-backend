// Ad-reward feature switches. The rewarded-ad extra daily spin is additionally
// gated per-request on `ads` in X-Client-Features (only builds that can show a
// rewarded ad ever see it), so these are the server-side kill switches: flip
// the env var and restart to turn the feature off for every app version
// without an App Store cycle. See AD_REWARD_DESIGN.md (frontend repo).
const ADS_EXTRA_SPIN_ENABLED = process.env.ADS_EXTRA_SPIN_ENABLED !== "false";

// Local/staging escape hatch ONLY: accept SSV callbacks without a signature
// check (AdMob test ads sign with test keys, but local curl testing can't).
// Never set in prod — an unsigned callback mints real coins.
const ADMOB_SSV_SKIP_VERIFY = process.env.ADMOB_SSV_SKIP_VERIFY === "true";

// rewardKind stamped on grants minted by the extra-daily-spin ad unit.
const EXTRA_SPIN_REWARD_KIND = "extra_daily_spin";

// Watch-ad-for-coins (Get Coins hub). Same kill-switch semantics as the extra
// spin: per-request `ads` client-feature gate plus this env switch.
const ADS_COIN_REWARD_ENABLED = process.env.ADS_COIN_REWARD_ENABLED !== "false";

// rewardKind for coin-reward grants (SSV custom_data "coins:<YYYY-MM-DD>").
const COIN_REWARD_KIND = "coin_reward";

// Flat coins per verified watch, and max redeemed watches per local day. Both
// are env-overridable so the coin economy can be tuned without an App Store
// cycle — the client renders whatever the status block reports rather than its
// own constants (see queries/getAdCoinRewardStatus).
//
// Leave the cap at 3 until app 1.6.1 has rolled out: builds before it hardcode
// "of 3 left today" in the Get Coins hub while reading remainingToday from the
// server, so a raise makes those frozen binaries render "10 of 3 left today".
//
// A malformed override must never read as "no cap" (Number("x") is NaN, and
// `consumed >= NaN` is false — the cap would silently stop applying), so fall
// back to the default unless the value parses as a positive integer.
function positiveIntEnv(raw, fallback) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const AD_COIN_REWARD_AMOUNT = positiveIntEnv(
  process.env.AD_COIN_REWARD_AMOUNT,
  25
);
const AD_COIN_REWARD_DAILY_CAP = positiveIntEnv(
  process.env.AD_COIN_REWARD_DAILY_CAP,
  3
);

module.exports = {
  ADS_EXTRA_SPIN_ENABLED,
  ADMOB_SSV_SKIP_VERIFY,
  EXTRA_SPIN_REWARD_KIND,
  ADS_COIN_REWARD_ENABLED,
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
};
