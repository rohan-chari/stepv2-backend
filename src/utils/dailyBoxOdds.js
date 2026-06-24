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

function rollDailyBoxRarity(streak, rng = Math.random) {
  const [commonOdds, uncommonOdds] = interpolateDailyBoxOdds(streak);
  const roll = rng();
  if (roll < commonOdds) return "COMMON";
  if (roll < commonOdds + uncommonOdds) return "UNCOMMON";
  return "RARE";
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

// Weighted pick of an unowned accessory: weight grows with priceCoins, and a
// longer streak sharpens the bias toward pricier (better) items.
function pickAccessory(pool, streak, rng = Math.random) {
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

module.exports = {
  RARITY_ORDER,
  DAILY_BOX_STREAK_CAP,
  DAILY_BOX_ODDS_TABLE,
  DAILY_BOX_COIN_RANGES,
  streakProgress,
  interpolateDailyBoxOdds,
  rollDailyBoxRarity,
  coinAmountForTier,
  pickAccessory,
};
