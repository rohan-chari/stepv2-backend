// Rewarded-ad value is permanently available to capable clients behind the
// single OPS_AD_VALUE_ISSUANCE_DISABLED emergency brake. Provider validation,
// allowlists, idempotency, and per-user caps remain mandatory.
const { adValueEnabled } = require("../../shared/config/operationalControls");

const ADS_EXTRA_SPIN_ENABLED = adValueEnabled("extraSpin");

// Local/staging escape hatch ONLY: accept SSV callbacks without a signature
// check (AdMob test ads sign with test keys, but local curl testing can't).
// Never set in prod — an unsigned callback mints real coins.
const ADMOB_SSV_SKIP_VERIFY = process.env.ADMOB_SSV_SKIP_VERIFY === "true";

// rewardKind stamped on grants minted by the extra-daily-spin ad unit.
const EXTRA_SPIN_REWARD_KIND = "extra_daily_spin";

// Watch-ad-for-coins (Get Coins hub). Same kill-switch semantics as the extra
// spin: per-request `ads` client-feature gate plus this env switch.
const ADS_COIN_REWARD_ENABLED = adValueEnabled("coinReward");

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

// Batch 2026-08-08 item 11 — rewarded-ad mystery-box reroll. Grants minted by
// the reroll unit carry SSV custom_data "box_reroll:<userId>:<localDate>" and
// are stamped with this kind. A DISTINCT kind is load-bearing, not cosmetic:
// grantAdReward falls back to EXTRA_SPIN_REWARD_KIND for anything it doesn't
// recognise, so a reroll watch with unchanged custom_data would mint extra-spin
// credits and the two features would silently consume each other's grants.
const BOX_REROLL_REWARD_KIND = "box_reroll";

// Race-results payout double is permanently available at 100%; the global
// ad-value brake independently stops every value-issuing ad path.
const RACE_PAYOUT_DOUBLE_REWARD_KIND = "race_payout_double";

function adsRacePayoutDoublePrepareEnabled() {
  return adValueEnabled("payoutPrepare");
}

function adsRacePayoutDoubleClaimEnabled() {
  return adValueEnabled("payoutClaim");
}

// AdMob ad unit IDs have one canonical representation: a 16-digit publisher
// ID followed by a 10-digit unit ID. Treat the allowlist as one configuration
// value rather than independently salvaging valid members: a typo in either
// platform's unit must keep the whole variable dark.
const ADMOB_AD_UNIT_ID_PATTERN = /^ca-app-pub-\d{16}\/\d{10}$/;

function racePayoutDoubleAdUnitIds() {
  const raw = process.env.ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !ADMOB_AD_UNIT_ID_PATTERN.test(value))) return [];
  return [...new Set(values)];
}

// AdMob's SSV callback's `ad_unit` query param is the bare numeric unit ID
// (e.g. "6376353967"), never the "ca-app-pub-<publisher>/<unit>" form stored
// in the env allowlist above — confirmed against real callbacks in the nginx
// access log. Comparing the raw callback value against the full-string
// allowlist never matches, so every claim silently dead-ends as
// "unit_rejected". Derive the bare suffixes at call time, like the allowlist
// above, for that comparison.
function racePayoutDoubleAdUnitSuffixes() {
  return racePayoutDoubleAdUnitIds().map((value) => value.split("/")[1]);
}

// Callback/stored values may be the bare suffix (the normal case) or, if a
// mediation adapter or an older stored grant ever used the full string, that
// form too — accept either rather than failing the whole match on shape.
function normalizeAdUnit(value) {
  return typeof value === "string" ? value.split("/").pop() : null;
}

function racePayoutDoubleMaxBonusCoins() {
  const parsed = Number(process.env.RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS);
  // This deploy-time knob may reduce the product limit, never increase it.
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 100;
}

// Kill switch for the reroll endpoint AND for advertising `boxReroll` in
// getRaceProgress. Deliberately NOT the `!== "false"` idiom the older switches
// use: this one must default OFF so the backend can ship dark ahead of the App
// Store build that carries the button and the ad unit. Read at CALL TIME (a
// function, not a const) so a prod .env edit + restart flips it for every app
// version at once, and so an integration test can exercise both sides.
function adsBoxRerollEnabled() {
  return adValueEnabled("boxReroll");
}

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
  BOX_REROLL_REWARD_KIND,
  adsBoxRerollEnabled,
  RACE_PAYOUT_DOUBLE_REWARD_KIND,
  adsRacePayoutDoublePrepareEnabled,
  adsRacePayoutDoubleClaimEnabled,
  racePayoutDoubleAdUnitIds,
  racePayoutDoubleAdUnitSuffixes,
  normalizeAdUnit,
  racePayoutDoubleMaxBonusCoins,
};
