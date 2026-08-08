const { prisma } = require("../../../db");
const {
  EXTRA_SPIN_REWARD_KIND,
  COIN_REWARD_KIND,
  POWERUP_UNLOCK_REWARD_KIND,
  SHOP_UNLOCK_REWARD_KIND,
  BOX_REROLL_REWARD_KIND,
} = require("../adRewards");

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// custom_data for coin-reward watches: "coins:<local date>". Bare dates are
// the shipped extra-spin format and must keep minting extra_daily_spin.
const COIN_CUSTOM_DATA_RE = /^coins:(\d{4}-\d{2}-\d{2})$/;
// Item 10 — custom_data for a powerup-unlock watch: "powerup_unlock:<userId>:<sku>".
// The sku (a `POWERUP_<TYPE>` string) is stored on the grant's shopItemId so the
// unlock endpoint can count verified watches for this user+sku.
const POWERUP_UNLOCK_CUSTOM_DATA_RE = /^powerup_unlock:([^:]+):(.+)$/;
// 2026-07-25 §7 — the cosmetic sibling: "shop_unlock:<userId>:<sku>". Distinct
// prefix and distinct rewardKind so the two unlock endpoints can never consume
// each other's watches, while the shared daily cap counts both.
const SHOP_UNLOCK_CUSTOM_DATA_RE = /^shop_unlock:([^:]+):(.+)$/;
// Batch 2026-08-08 item 11 — "box_reroll:<userId>:<localDate>". Mirrors the two
// unlock prefixes above, with one difference that matters: the trailing group
// is a DATE, not a sku, so it feeds `grantedDate` (which the reroll consume
// filter matches on) and never `shopItemId`.
//
// Without this branch a reroll watch would fall through to the `rewardKind`
// default (extra_daily_spin) and the two features would eat each other's
// credits — the whole reason the kind is derived from the prefix.
const BOX_REROLL_CUSTOM_DATA_RE = /^box_reroll:([^:]+):(.+)$/;

// Mint an AdRewardGrant from a *verified* AdMob SSV callback (the route owns
// signature verification; this command owns the ledger). Idempotent on
// transactionId — Google retries callbacks, and a replayed/forwarded callback
// must never mint twice. Mirrors grantReferralReward's insert-ledger-first
// pattern; the grant is later consumed by claimExtraDailyRewardBox.
function buildGrantAdReward(dependencies = {}) {
  const db = dependencies.prisma || prisma;

  return async function grantAdReward({
    userId,
    transactionId,
    adUnit = null,
    customData = null,
    rewardKind = EXTRA_SPIN_REWARD_KIND,
    serverDate,
  }) {
    if (!userId || !transactionId) {
      return { granted: false, reason: "invalid" };
    }

    // SSV's user_id comes from the client's ServerSideVerificationOptions, so
    // an attacker-controlled value is possible — it can only ever point a
    // grant at an existing account, and only that account can redeem it.
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return { granted: false, reason: "unknown_user" };

    // custom_data carries the watcher's local date (matches the localDate the
    // claim will send) and, for coin-reward watches, a "coins:" prefix that
    // selects the reward kind. Anything unrecognized falls back to the
    // default kind and the server's date.
    const coinMatch =
      typeof customData === "string"
        ? customData.match(COIN_CUSTOM_DATA_RE)
        : null;
    const unlockMatch =
      typeof customData === "string"
        ? customData.match(POWERUP_UNLOCK_CUSTOM_DATA_RE)
        : null;
    const shopUnlockMatch =
      typeof customData === "string"
        ? customData.match(SHOP_UNLOCK_CUSTOM_DATA_RE)
        : null;
    const rerollMatch =
      typeof customData === "string"
        ? customData.match(BOX_REROLL_CUSTOM_DATA_RE)
        : null;
    // The reroll prefix carries the watcher's LOCAL date in group 2; anything
    // malformed there falls back to the server's date rather than poisoning the
    // column with a non-date string.
    const rerollDate =
      rerollMatch && LOCAL_DATE_RE.test(rerollMatch[2]) ? rerollMatch[2] : null;
    const grantedDate = coinMatch
      ? coinMatch[1]
      : rerollDate
        ? rerollDate
        : typeof customData === "string" && LOCAL_DATE_RE.test(customData)
          ? customData
          : serverDate;
    const kind = unlockMatch
      ? POWERUP_UNLOCK_REWARD_KIND
      : shopUnlockMatch
        ? SHOP_UNLOCK_REWARD_KIND
        : rerollMatch
          ? BOX_REROLL_REWARD_KIND
          : coinMatch
            ? COIN_REWARD_KIND
            : rewardKind;
    // For an unlock watch (either kind), remember which sku it was attributed to.
    const shopItemId = unlockMatch
      ? unlockMatch[2]
      : shopUnlockMatch
        ? shopUnlockMatch[2]
        : null;

    try {
      await db.adRewardGrant.create({
        data: { userId, transactionId, adUnit, rewardKind: kind, grantedDate, shopItemId },
      });
    } catch (error) {
      if (error && error.code === "P2002") {
        return { granted: false, reason: "duplicate" };
      }
      throw error;
    }
    return { granted: true };
  };
}

const grantAdReward = buildGrantAdReward();

module.exports = { buildGrantAdReward, grantAdReward };
