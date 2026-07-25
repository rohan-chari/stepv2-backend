// Shared policy for the two "watch ads to afford it" flows (2026-07-25 §7):
// POST /shop/powerups/unlock-with-ads (powerups) and POST /shop/:sku/unlock-with-ads
// (accessories + characters).
//
// Deliberately a POLICY module, not a generalized command. The two flows read
// different item tables, grant into different tables and dedupe against
// different idempotency tables; folding them into one polymorphic command would
// put a coin-zeroing debit behind a type switch. What they genuinely SHARE is
// exactly what lives here: the ad math, the localDate resolution, and the
// single daily cap that spans both (D4).
const {
  AD_UNLOCK_REWARD_KINDS,
  POWERUP_UNLOCK_COINS_PER_AD,
  POWERUP_UNLOCK_MAX_ADS,
  powerupUnlockMaxShortfall,
  powerupUnlockDailyCap,
} = require("../adRewards");
// LAZY require, deliberately. claimDailyReward pulls in the cosmetics module,
// which now pulls in unlockShopItemWithAds, which pulls in THIS module — a
// require cycle that leaves these two undefined at load time. Resolving them at
// call time keeps the single source of truth for local-date validation (shared
// with claimAdCoinReward) without duplicating the rules here.
function localDateRules() {
  const {
    isValidLocalDate,
    withinOneDayOfServer,
  } = require("../commands/claimDailyReward");
  return { isValidLocalDate, withinOneDayOfServer };
}

function adsNeededFor(shortfall) {
  return Math.min(
    POWERUP_UNLOCK_MAX_ADS,
    Math.ceil(shortfall / POWERUP_UNLOCK_COINS_PER_AD)
  );
}

function serverLocalDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// ── The #1 old-client rule (CLAUDE.md) lives here ──────────────────────────
// `localDate` is OPTIONAL. Every currently-shipped binary (<= 2.0.0) calls the
// powerup unlock endpoint with NO localDate at all, so an absent value MUST
// fall back to the server's date rather than 400 — otherwise this deploy breaks
// the unlock button on every frozen client at once. Present-and-malformed, or
// present-and-more-than-a-day-off, is a 400 exactly like claimAdCoinReward:
// those can only come from a client that chose to send the field.
//
// Returns the effective local date. `makeError(message, status, code)` lets each
// caller throw its own error class.
function resolveLocalDate(localDate, makeError, now = new Date()) {
  if (localDate === undefined || localDate === null || localDate === "") {
    return serverLocalDate(now);
  }
  const { isValidLocalDate, withinOneDayOfServer } = localDateRules();
  if (!isValidLocalDate(localDate)) {
    throw makeError("Invalid localDate (expected YYYY-MM-DD)", 400, "INVALID_LOCAL_DATE");
  }
  if (!withinOneDayOfServer(localDate)) {
    throw makeError("localDate is too far from server time", 400, "INVALID_LOCAL_DATE");
  }
  return localDate;
}

// Consumed ad-unlock grants for this user on this local day, across BOTH flows
// (D4: one total, not one of each). Counted inside the caller's transaction so
// two concurrent unlocks can't both pass the cap.
//
// The day a grant belongs to is its `grantedDate`. Ad-unlock watches are minted
// with no client date in their SSV custom_data, so they arrive stamped with the
// SERVER date; the consuming command restamps grantedDate to the resolved local
// date as it consumes, which is what makes this count mean "unlocks the user
// performed on their day".
async function consumedUnlocksToday(tx, userId, localDate) {
  return tx.adRewardGrant.count({
    where: {
      userId,
      rewardKind: { in: AD_UNLOCK_REWARD_KINDS },
      grantedDate: localDate,
      consumedAt: { not: null },
    },
  });
}

// Throws when the shared daily cap is already spent. Call INSIDE the unlock
// transaction and BEFORE anything is consumed or debited, so the 409 is free
// (no coins lost, no ad grant burned).
async function assertUnderDailyCap(tx, userId, localDate, makeError) {
  const cap = powerupUnlockDailyCap();
  const used = await consumedUnlocksToday(tx, userId, localDate);
  if (used >= cap) {
    throw makeError(
      "You've already used your daily ad unlock — come back tomorrow.",
      409,
      "DAILY_CAP_REACHED"
    );
  }
  return { cap, used };
}

// The additive `adUnlock` catalog block (contract §4.3). New clients render
// ENTIRELY from this and must not fall back to a compiled-in constant when it
// is present; clients that don't understand it ignore it and keep their 150.
async function buildAdUnlockBlock(db, userId, { localDate } = {}) {
  const cap = powerupUnlockDailyCap();
  const { isValidLocalDate, withinOneDayOfServer } = localDateRules();
  const day =
    localDate && isValidLocalDate(localDate) && withinOneDayOfServer(localDate)
      ? localDate
      : serverLocalDate();
  let used = 0;
  try {
    used = await consumedUnlocksToday(db, userId, day);
  } catch {
    // Never break a catalog request over the cap counter; the client just sees
    // a full allowance and the server still enforces the cap on the unlock.
    used = 0;
  }
  return {
    maxShortfall: powerupUnlockMaxShortfall(),
    coinsPerAd: POWERUP_UNLOCK_COINS_PER_AD,
    maxAds: POWERUP_UNLOCK_MAX_ADS,
    dailyCap: cap,
    remainingToday: Math.max(0, cap - used),
  };
}

// The message a stranded old client renders VERBATIM after sitting through ads
// it thought it needed (its compiled-in threshold is 150). It is the only thing
// those users see, so it explains the change instead of reading as a bug.
const SHORTFALL_TOO_LARGE_MESSAGE = (max = powerupUnlockMaxShortfall()) =>
  `Ad unlocks now only cover the last ${max} coins. Update the app for the latest rules.`;

module.exports = {
  adsNeededFor,
  serverLocalDate,
  resolveLocalDate,
  consumedUnlocksToday,
  assertUnderDailyCap,
  buildAdUnlockBlock,
  SHORTFALL_TOO_LARGE_MESSAGE,
};
