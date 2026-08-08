const { prisma: defaultPrisma } = require("../../../db");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");

// Coins paid for discarding a HELD in-race powerup (batch 2026-08-08 item 1).
//
// Two numbers decide an award: the RARITY PRICE (balance config, admin-tunable)
// and what is left of the user's DAILY CAP (env-tunable). The cap is per user
// per LOCAL calendar day.

const DEFAULT_DAILY_CAP = 40;
const DISCARD_REASON = "powerup_discard";
// The zone used when a user has never had one recorded, matching
// extractTimezone's default and the reminder schedulers'.
const DEFAULT_ZONE = "America/New_York";

// A malformed override must NEVER read as "no cap": Number("abc") is NaN, and
// `consumed >= NaN` is false, which would silently switch the faucet to
// unlimited. Same guard as AD_COIN_REWARD_DAILY_CAP (adRewards.js).
function positiveIntEnv(raw, fallback) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Read at CALL time, not module load, so an ops change takes effect on restart
// of the process rather than being frozen into the module at require time (and
// so tests can exercise it).
function discardDailyCap() {
  return positiveIntEnv(
    process.env.POWERUP_DISCARD_DAILY_COIN_CAP,
    DEFAULT_DAILY_CAP
  );
}

// Price for a rolled rarity. Default-safe on every axis:
//   * an UNOPENED MYSTERY_BOX is 0 — a RULE, not a knob. Paying for unopened
//     boxes makes never-opening strictly dominant (exploit S4).
//   * a NULL rarity (stash-redeemed powerups carry none) floors to COMMON.
//   * a config with no discardPrices block, or a missing rarity inside it,
//     also floors to COMMON — mergeOverDefaults normally supplies the code
//     defaults, but this must not throw if it somehow doesn't.
function priceFor({ status, rarity, config }) {
  if (status === "MYSTERY_BOX") return 0;
  const prices = (config && config.discardPrices) || {};
  const floor = Number.isInteger(prices.COMMON) ? prices.COMMON : 0;
  if (!rarity) return floor;
  const price = prices[rarity];
  return Number.isInteger(price) && price >= 0 ? price : floor;
}

// Coins already awarded to this user for discards on their CURRENT local day.
//
// Computed in pure SQL. Prod datetimes are `timestamp without time zone` and
// node-pg shifts them on the way out, so deriving the day boundary in JS is how
// this silently drifts by a day. `created_at AT TIME ZONE 'UTC'` re-labels the
// naive timestamp as UTC, the second AT TIME ZONE converts it into the user's
// zone, and both sides are then compared as dates in that same zone.
//
// Backed by coin_transactions(user_id, reason, created_at) — without that index
// this sums a heavy user's entire ledger on every discard.
async function consumedToday({ prisma, userId, timezone }) {
  const zone = timezone || DEFAULT_ZONE;
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(amount), 0)::bigint AS consumed
    FROM coin_transactions
    WHERE user_id = ${userId}
      AND reason = ${DISCARD_REASON}
      AND (created_at AT TIME ZONE 'UTC' AT TIME ZONE ${zone})::date
        = (now() AT TIME ZONE ${zone})::date`;
  return Number(rows?.[0]?.consumed ?? 0);
}

function buildDiscardRewards(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const balance = dependencies.balanceConfig || defaultBalanceConfig;

  // What this discard is worth right now, and what the cap looks like after it.
  //
  // PARTIAL AWARD (spec, architect-required): at 38/40 a RARE pays
  // min(price, capRemaining) = 2, not 10 and not 0. `coinsAwarded` in the
  // response is always the ACTUAL award.
  //
  // Deliberately NOT atomic: two concurrent discards can both read the same
  // `consumed` and overshoot the cap by at most one price. Accepted in the spec
  // — worst case is a single extra sub-10-coin award, and the alternative is
  // holding a lock across a coin write on a button users can spam.
  return async function computeDiscardAward({ userId, status, rarity, timezone }) {
    const cap = discardDailyCap();
    let config = null;
    try {
      config = (await balance.getSnapshot()).config;
    } catch {
      // getSnapshot degrades to code defaults on its own; a null config here
      // just means we fall through to the COMMON floor rather than failing a
      // discard because the config table was unreadable.
    }

    const price = priceFor({ status, rarity, config });
    if (price <= 0) {
      const consumed = await consumedToday({ prisma, userId, timezone });
      return { price, coinsAwarded: 0, capRemaining: Math.max(0, cap - consumed) };
    }

    const consumed = await consumedToday({ prisma, userId, timezone });
    const remainingBefore = Math.max(0, cap - consumed);
    const coinsAwarded = Math.min(price, remainingBefore);
    return {
      price,
      coinsAwarded,
      capRemaining: Math.max(0, remainingBefore - coinsAwarded),
    };
  };
}

const computeDiscardAward = buildDiscardRewards();

module.exports = {
  buildDiscardRewards,
  computeDiscardAward,
  priceFor,
  discardDailyCap,
  DISCARD_REASON,
  DEFAULT_DAILY_CAP,
};
