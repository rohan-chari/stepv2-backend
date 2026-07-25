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

// Item 10 (2026-07-24): "watch ads to afford a powerup". Grants minted by this
// unit carry SSV custom_data "powerup_unlock:<userId>:<sku>"; the backend stamps
// rewardKind = POWERUP_UNLOCK_REWARD_KIND and shopItemId = <sku> so the unlock
// endpoint can count verified, still-unconsumed watches for this user+sku.
const POWERUP_UNLOCK_REWARD_KIND = "powerup_unlock";

// 2026-07-25 §7 — the cosmetic sibling of the above. Grants minted by the
// accessory/character unlock unit carry SSV custom_data
// "shop_unlock:<userId>:<sku>" and are stamped with this kind. Deliberately a
// DISTINCT kind from powerup_unlock (different item, grant and idempotency
// tables), but the two share one daily cap — see POWERUP_UNLOCK_DAILY_CAP.
const SHOP_UNLOCK_REWARD_KIND = "shop_unlock";

// Both ad-unlock kinds, for the shared daily-cap count (D4: ONE ad unlock per
// local day TOTAL, not one powerup + one cosmetic).
const AD_UNLOCK_REWARD_KINDS = [
  POWERUP_UNLOCK_REWARD_KIND,
  SHOP_UNLOCK_REWARD_KIND,
];

const POWERUP_UNLOCK_COINS_PER_AD = 50;
const POWERUP_UNLOCK_MAX_ADS = 3;

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

// ── Ad-unlock tunables (2026-07-25 §7) ──────────────────────────────────────
// Read at CALL TIME, not module load, so both are true kill switches: a prod
// .env edit + restart changes them for every app version at once, and an
// integration test can exercise both sides. Same positiveIntEnv guard as the
// coin cap — a malformed override must fall back to the default, never read as
// "no limit".
//
// Server is the authority on shortfall + ad count (never client-attested): a
// user within maxShortfall coins of an item may unlock it by watching
// ceil(shortfall/50) ads (capped at 3); beyond it the client routes to the
// +coins hub. Dropped 150 -> 20 on 2026-07-25 (D5): with COINS_PER_AD = 50,
// adsNeededFor(<=20) is always 1, so the flow collapses to the single-ad
// top-up it was always meant to be. Frozen clients hardcode 150 and will offer
// ads they can't spend — see the SHORTFALL_TOO_LARGE copy, which is the only
// thing those users see.
const POWERUP_UNLOCK_MAX_SHORTFALL_DEFAULT = 20;
function powerupUnlockMaxShortfall() {
  return positiveIntEnv(
    process.env.POWERUP_UNLOCK_MAX_SHORTFALL,
    POWERUP_UNLOCK_MAX_SHORTFALL_DEFAULT
  );
}

// One ad unlock per user-local day, TOTAL across powerups and cosmetics (D4).
// Raise it to disable the cap. Enforced INSIDE the unlock transaction.
const POWERUP_UNLOCK_DAILY_CAP_DEFAULT = 1;
function powerupUnlockDailyCap() {
  return positiveIntEnv(
    process.env.POWERUP_UNLOCK_DAILY_CAP,
    POWERUP_UNLOCK_DAILY_CAP_DEFAULT
  );
}

module.exports = {
  SHOP_UNLOCK_REWARD_KIND,
  AD_UNLOCK_REWARD_KINDS,
  POWERUP_UNLOCK_MAX_SHORTFALL_DEFAULT,
  POWERUP_UNLOCK_DAILY_CAP_DEFAULT,
  powerupUnlockMaxShortfall,
  powerupUnlockDailyCap,
  positiveIntEnv,
  ADS_EXTRA_SPIN_ENABLED,
  ADMOB_SSV_SKIP_VERIFY,
  EXTRA_SPIN_REWARD_KIND,
  ADS_COIN_REWARD_ENABLED,
  COIN_REWARD_KIND,
  AD_COIN_REWARD_AMOUNT,
  AD_COIN_REWARD_DAILY_CAP,
  POWERUP_UNLOCK_REWARD_KIND,
  POWERUP_UNLOCK_COINS_PER_AD,
  POWERUP_UNLOCK_MAX_ADS,
};
