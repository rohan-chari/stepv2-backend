// Daily reward box roller. Same mechanics as the in-race mystery box roller
// (utils/powerupOdds.js): linearly interpolated rarity odds, then a pick within
// the tier — but the interpolation axis is the user's consecutive-day login
// streak instead of race position.
//
// MECHANICS ONLY. The streak cap, the odds rows, the coin ranges, the rare
// coins share and the accessory weighting mode all come from
// `services/balanceConfig`. Do not add a table here.

const { balanceConfig } = require("./balanceConfig");
const { RARITIES } = require("./balanceConfig.defaults");

const RARITY_ORDER = RARITIES;

function dailyConfig(config) {
  return (config || balanceConfig.getConfigSync()).dailyBox;
}

function streakProgress(streak, config) {
  const cap = dailyConfig(config).streakCap;
  const s = Math.max(1, Math.floor(streak || 1));
  return Math.max(0, Math.min(1, (s - 1) / (cap - 1)));
}

function interpolateDailyBoxOdds(streak, config) {
  const { odds } = dailyConfig(config);
  const t = streakProgress(streak, config);
  return [0, 1, 2].map((i) => odds.first[i] + t * (odds.last[i] - odds.first[i]));
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
function dailyBoxOddsForPool(streak, accessoryPoolSize, powerupPoolSize = 0, config) {
  const [common, uncommon, rare] = interpolateDailyBoxOdds(streak, config);
  if (accessoryPoolSize > 0 || powerupPoolSize > 0) {
    return [common, uncommon, rare];
  }
  return [common, 1 - common, 0];
}

function rollDailyBoxRarity(
  streak,
  rng = Math.random,
  accessoryPoolSize = Infinity,
  powerupPoolSize = 0,
  config
) {
  const [commonOdds, uncommonOdds] = dailyBoxOddsForPool(
    streak,
    accessoryPoolSize,
    powerupPoolSize,
    config
  );
  const roll = rng();
  if (roll < commonOdds) return "COMMON";
  if (roll < commonOdds + uncommonOdds) return "UNCOMMON";
  return "RARE";
}

// Share of RARE hits that pay coins instead of a powerup. Authoritative source
// is the balance config (admin-editable, versioned).
//
// DAILY_SPIN_RARE_COINS_SHARE is still honoured IF SET, purely so an env value
// an operator set by hand before this build cannot be silently zeroed by the
// config default. It is a deprecated escape hatch: once prod is confirmed to
// have it unset, delete this branch — config should be the only authority.
function rareCoinsShare(config) {
  const raw = parseFloat(process.env.DAILY_SPIN_RARE_COINS_SHARE);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(1, raw));
  const fromConfig = dailyConfig(config).rareCoinsShare;
  if (!Number.isFinite(fromConfig)) return 0;
  return Math.max(0, Math.min(1, fromConfig));
}

// Sub-roll for a RARE hit: does it pay an ACCESSORY, a POWERUP, or COINS? The
// coins slice DISPLACES only the powerup portion so accessory rewards are never
// capped away:
//   * both pools stocked   -> ~50% ACCESSORY, then the powerup half splits into
//                             COINS (with prob = coinsShare) vs POWERUP,
//   * powerup pool only     -> COINS (coinsShare) vs POWERUP,
//   * accessory pool only   -> always ACCESSORY (unchanged),
//   * neither pool          -> null (the caller then falls back to bonus coins).
// With coinsShare = 0 (the default) this is byte-for-byte the historical
// accessory/powerup 50-50 roll. `coinsShare` may be injected for tests.
function rollRarePrizeKind(
  accessoryPoolSize,
  powerupPoolSize,
  rng = Math.random,
  { coinsShare, config } = {}
) {
  const share =
    coinsShare != null
      ? Math.max(0, Math.min(1, coinsShare))
      : rareCoinsShare(config);
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

// The full RARE sub-roll distribution, including the COINS slice. This is what
// the player-facing odds sheet reports (`itemOdds.rareMix`) — the older
// `rarePrizeMix` field omits COINS entirely and is therefore wrong whenever
// rareCoinsShare > 0. That field is left unchanged for frozen clients.
function rarePrizeMix(accessoryPoolSize, powerupPoolSize, config) {
  const share = rareCoinsShare(config);
  const hasAccessory = accessoryPoolSize > 0;
  const hasPowerup = powerupPoolSize > 0;
  if (hasAccessory && hasPowerup) {
    return {
      ACCESSORY: 0.5,
      POWERUP: 0.5 * (1 - share),
      COINS: 0.5 * share,
    };
  }
  if (hasPowerup) return { ACCESSORY: 0, POWERUP: 1 - share, COINS: share };
  if (hasAccessory) return { ACCESSORY: 1, POWERUP: 0, COINS: 0 };
  return { ACCESSORY: 0, POWERUP: 0, COINS: 1 };
}

// Coin amount within a tier scales with streak progress so a longer streak
// pays more even when the rarity roll comes up the same. Snapped to the
// nearest multiple of 5 so payouts read as round numbers (10, 15, 20, …)
// instead of 11/17 — range bounds are already multiples of 5, so the min/max
// endpoints stay exact and rounding never escapes the range.
function coinAmountForTier(rangeKey, streak, config) {
  const range = dailyConfig(config).coinRanges[rangeKey];
  if (!range) return 0;
  const t = streakProgress(streak, config);
  const raw = range[0] + t * (range[1] - range[0]);
  return Math.round(raw / 5) * 5;
}

// Relative weight of one priced item under the configured weighting mode.
//
//   "inverse" (shipped) — cheaper items are MORE likely, and a longer streak
//                         sharpens that. This is the correct prestige gradient:
//                         an expensive accessory should be the rare one.
//   "uniform"           — every item equally likely.
//   "legacy"            — price^(1+t): PRICIER items up to ~36x more likely.
//                         This is a prestige INVERSION and is retained only so a
//                         rollback can reproduce historical behaviour. It must
//                         never be the active value in prod. It is currently
//                         masked only because just a handful of cosmetics are
//                         purchasable — flipping the ~61 testOnly cosmetics
//                         active while this mode is live would make 1500-coin
//                         accessories the most common daily-box drop.
function itemWeight(item, exponent, mode) {
  const price = Math.max(1, item.priceCoins || 1);
  if (mode === "uniform") return 1;
  if (mode === "legacy") return Math.pow(price, exponent);
  return 1 / Math.pow(price, exponent);
}

// Weighted pick from a priced pool.
function pickWeightedByPrice(pool, streak, rng = Math.random, config) {
  if (!pool || pool.length === 0) return null;
  const mode = dailyConfig(config).accessoryWeightMode;
  const exponent = 1 + streakProgress(streak, config);
  const weights = pool.map((item) => itemWeight(item, exponent, mode));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return pool[Math.floor(rng() * pool.length)];
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// Normalised pick probability per item — what the odds sheet displays. Derived
// from the same weights the pick uses, so display and outcome cannot drift.
function pickProbabilities(pool, streak, config) {
  if (!pool || pool.length === 0) return [];
  const mode = dailyConfig(config).accessoryWeightMode;
  const exponent = 1 + streakProgress(streak, config);
  const weights = pool.map((item) => itemWeight(item, exponent, mode));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return pool.map(() => 1 / pool.length);
  return weights.map((w) => w / total);
}

// Weighted pick of an unowned accessory (see pickWeightedByPrice).
function pickAccessory(pool, streak, rng = Math.random, config) {
  return pickWeightedByPrice(pool, streak, rng, config);
}

// Weighted pick of a shop powerup — same weighting logic as accessories.
// Powerups are all one price today, so this is effectively uniform now but
// stays sensible if prices ever diverge.
function pickPowerup(pool, streak, rng = Math.random, config) {
  return pickWeightedByPrice(pool, streak, rng, config);
}

module.exports = {
  RARITY_ORDER,
  streakProgress,
  interpolateDailyBoxOdds,
  dailyBoxOddsForPool,
  rollDailyBoxRarity,
  rollRarePrizeKind,
  rarePrizeMix,
  rareCoinsShare,
  coinAmountForTier,
  pickWeightedByPrice,
  pickProbabilities,
  pickAccessory,
  pickPowerup,
  // Live views onto the active config, kept under their historical names so
  // existing callers and tests keep working.
  get DAILY_BOX_STREAK_CAP() {
    return balanceConfig.getConfigSync().dailyBox.streakCap;
  },
  get DAILY_BOX_ODDS_TABLE() {
    return balanceConfig.getConfigSync().dailyBox.odds;
  },
  get DAILY_BOX_COIN_RANGES() {
    return balanceConfig.getConfigSync().dailyBox.coinRanges;
  },
};
