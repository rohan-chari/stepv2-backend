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

module.exports = {
  ADS_EXTRA_SPIN_ENABLED,
  ADMOB_SSV_SKIP_VERIFY,
  EXTRA_SPIN_REWARD_KIND,
};
