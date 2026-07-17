// Daily reward box roller. Same mechanics as the in-race mystery box roller
// (utils/powerupOdds.js): linearly interpolated rarity odds, then a pick
// within the tier — but the interpolation axis is the user's consecutive-day
// login streak instead of race position.

const RARITY_ORDER = ["COMMON", "UNCOMMON", "RARE"];

// Streak length at which odds stop improving.
const DAILY_BOX_STREAK_CAP = 30;

// [COMMON%, UNCOMMON%, RARE%] — same gradient shape as the race ODDS_TABLE.
// Row "first" = a 1-day streak, row "last" = streak at/above the cap.
const DAILY_BOX_ODDS_TABLE = {
  first: [0.70, 0.25, 0.05],
  last:  [0.20, 0.35, 0.45],
};

// Coin payouts per rarity, [min, max] interpolated by streak progress.
// RARE pays an unowned accessory; the range below is the fallback when the
// user already owns every active accessory.
const DAILY_BOX_COIN_RANGES = {
  COMMON: [10, 30],
  UNCOMMON: [40, 80],
  RARE_FALLBACK: [100, 200],
};

function streakProgress(streak) {
  const s = Math.max(1, Math.floor(streak || 1));
  return Math.max(0, Math.min(1, (s - 1) / (DAILY_BOX_STREAK_CAP - 1)));
}

function interpolateDailyBoxOdds(streak) {
  const t = streakProgress(streak);
  return [
    DAILY_BOX_ODDS_TABLE.first[0] + t * (DAILY_BOX_ODDS_TABLE.last[0] - DAILY_BOX_ODDS_TABLE.first[0]),
    DAILY_BOX_ODDS_TABLE.first[1] + t * (DAILY_BOX_ODDS_TABLE.last[1] - DAILY_BOX_ODDS_TABLE.first[1]),
    DAILY_BOX_ODDS_TABLE.first[2] + t * (DAILY_BOX_ODDS_TABLE.last[2] - DAILY_BOX_ODDS_TABLE.first[2]),
  ];
}

// Odds actually served/rolled, given what RARE can still pay out. RARE pays a
// prize (an unowned accessory or — for spinpowerups-capable clients — a shop
// powerup); when NEITHER pool has anything to give, RARE can't pay what it
// advertises, so fold its share into UNCOMMON and send RARE: 0. Shipped app
// builds render the reel and the odds dialog straight from these numbers, so
// this is the only way to keep an all-accessories-owned user from seeing the
// "???" mystery-accessory placeholder tile on binaries already in the field.
// UNCOMMON is computed as 1 - COMMON (not uncommon + rare) so the two tiers
// sum to exactly 1 and the client's cumulative roll can never fall past them.
//
// `powerupPoolSize` defaults to 0 so legacy callers passing only
// (streak, accessoryPoolSize) get the exact historical behavior: RARE folds to
// 0 the moment the accessory pool empties. Spinpowerups-capable callers pass a
// non-zero powerup pool, which keeps RARE alive (paying a powerup) even when
// the user owns every accessory — fixing the dead-RARE UX for those clients.
function dailyBoxOddsForPool(streak, accessoryPoolSize, powerupPoolSize = 0) {
  const [common, uncommon, rare] = interpolateDailyBoxOdds(streak);
  if (accessoryPoolSize > 0 || powerupPoolSize > 0) {
    return [common, uncommon, rare];
  }
  return [common, 1 - common, 0];
}

function rollDailyBoxRarity(
  streak,
  rng = Math.random,
  accessoryPoolSize = Infinity,
  powerupPoolSize = 0
) {
  const [commonOdds, uncommonOdds] = dailyBoxOddsForPool(
    streak,
    accessoryPoolSize,
    powerupPoolSize
  );
  const roll = rng();
  if (roll < commonOdds) return "COMMON";
  if (roll < commonOdds + uncommonOdds) return "UNCOMMON";
  return "RARE";
}

// Env-tunable share of RARE hits that pay coins instead of a powerup (Item 10).
// Default 0 keeps the exact legacy behavior (no coins slice) — set
// DAILY_SPIN_RARE_COINS_SHARE (e.g. 0.35–0.40) in the env to revive coin flow
// for high-streak / all-accessory users without a deploy. Clamped to [0,1].
function rareCoinsShare() {
  const raw = parseFloat(process.env.DAILY_SPIN_RARE_COINS_SHARE);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
}

// Sub-roll for a RARE hit: does it pay an ACCESSORY, a POWERUP, or COINS? The
// coins slice (Item 10) DISPLACES only the powerup portion so accessory rewards
// are never capped away:
//   * both pools stocked   -> ~50% ACCESSORY, then the powerup half splits into
//                             COINS (with prob = coinsShare) vs POWERUP,
//   * powerup pool only     -> COINS (coinsShare) vs POWERUP,
//   * accessory pool only   -> always ACCESSORY (unchanged),
//   * neither pool          -> null (the caller then falls back to bonus coins).
// With coinsShare = 0 (the default) this is byte-for-byte the historical
// accessory/powerup 50-50 roll. `coinsShare` may be injected for tests; it
// defaults to the env-tunable share.
function rollRarePrizeKind(
  accessoryPoolSize,
  powerupPoolSize,
  rng = Math.random,
  { coinsShare } = {}
) {
  const share =
    coinsShare != null ? Math.max(0, Math.min(1, coinsShare)) : rareCoinsShare();
  const hasAccessory = accessoryPoolSize > 0;
  const hasPowerup = powerupPoolSize > 0;
  if (hasAccessory && hasPowerup) {
    if (rng() < 0.5) return "ACCESSORY";
    return rng() < share ? "COINS" : "POWERUP";
  }
  if (hasPowerup) return rng() < share ? "COINS" : "POWERUP";
  if (hasAccessory) return "ACCESSORY";
  return null;
}

// Coin amount within a tier scales with streak progress so a longer streak
// pays more even when the rarity roll comes up the same. Snapped to the
// nearest multiple of 5 so payouts read as round numbers (10, 15, 20, …)
// instead of 11/17 — range bounds are already multiples of 5, so the min/max
// endpoints stay exact and rounding never escapes the range.
function coinAmountForTier(rangeKey, streak) {
  const range = DAILY_BOX_COIN_RANGES[rangeKey];
  if (!range) return 0;
  const t = streakProgress(streak);
  const raw = range[0] + t * (range[1] - range[0]);
  return Math.round(raw / 5) * 5;
}

// Weighted pick from a priced pool: weight grows with priceCoins, and a longer
// streak sharpens the bias toward pricier (better) items.
function pickWeightedByPrice(pool, streak, rng = Math.random) {
  if (!pool || pool.length === 0) return null;
  const t = streakProgress(streak);
  const exponent = 1 + t;
  const weights = pool.map((item) =>
    Math.pow(Math.max(1, item.priceCoins || 1), exponent)
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// Weighted pick of an unowned accessory (see pickWeightedByPrice).
function pickAccessory(pool, streak, rng = Math.random) {
  return pickWeightedByPrice(pool, streak, rng);
}

// Weighted pick of a shop powerup — same price-weighted logic as accessories,
// so pricier powerups are (slightly) rarer and a longer streak biases toward
// them. Powerups are all one price today, so this is effectively uniform now
// but stays sensible if prices ever diverge.
function pickPowerup(pool, streak, rng = Math.random) {
  return pickWeightedByPrice(pool, streak, rng);
}

module.exports = {
  RARITY_ORDER,
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_ODDS_TABLE,
  DAILY_BOX_COIN_RANGES,
  streakProgress,
  interpolateDailyBoxOdds,
  dailyBoxOddsForPool,
  rollDailyBoxRarity,
  rollRarePrizeKind,
  rareCoinsShare,
  coinAmountForTier,
  pickWeightedByPrice,
  pickAccessory,
  pickPowerup,
};
