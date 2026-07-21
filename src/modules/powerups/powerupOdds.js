// Mystery-box roller. This module holds MECHANICS ONLY — every number it uses
// (which types exist per tier, the position-odds curve, per-type weights) comes
// from `modules/economy/balanceConfig`. Do not add a table here; a structural guard
// test will fail if you do. See balanceConfig.defaults.js for why.
//
// NOTE: CAMPFIRE_REST and TRAIL_MAGNET are intentionally NOT generated anymore
// (1.1.7). Their enum values and effect-resolution code are kept (old apps +
// in-flight effects still resolve them), but they are absent from the config's
// dropPool, so they never roll into a new mystery box.
const { balanceConfig } = require("../economy/balanceConfig");
const { RARITIES } = require("../economy/balanceConfig.defaults");

const RARITY_ORDER = RARITIES;

function resolveConfig(config) {
  return config || balanceConfig.getConfigSync();
}

function coerceMinRarity(rarity, minRarity) {
  if (!minRarity) return rarity;
  const rarityIndex = RARITY_ORDER.indexOf(rarity);
  const minIndex = RARITY_ORDER.indexOf(minRarity);
  if (rarityIndex === -1 || minIndex === -1) return rarity;
  return RARITY_ORDER[Math.max(rarityIndex, minIndex)];
}

// normalizedPosition: 0 = leader, 1 = last place. Everything between is a
// straight linear interpolation of the two configured rows.
function interpolateOdds(normalizedPosition, config) {
  const { positionOdds } = resolveConfig(config);
  const t = Math.max(0, Math.min(1, normalizedPosition));
  return [0, 1, 2].map(
    (i) => positionOdds.first[i] + t * (positionOdds.last[i] - positionOdds.first[i])
  );
}

function normalizePosition(position, totalParticipants) {
  return totalParticipants <= 1 ? 0.5 : (position - 1) / (totalParticipants - 1);
}

// Full [COMMON, UNCOMMON, RARE] distribution for a race slot — the same numbers
// the roll below actually uses. Exposed so the player-facing odds display and
// the roller can never drift apart.
function rarityOddsForPosition(position, totalParticipants, config) {
  return interpolateOdds(normalizePosition(position, totalParticipants), config);
}

function weightForType(type, config) {
  const weight = resolveConfig(config).typeWeights?.[type];
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 0
    ? weight
    : 1;
}

// Weighted pick within an already-chosen tier.
//
// This replaces an older "roll uniformly, then re-roll RED_CARD 50% of the
// time" hack with a straight weighted draw, which expresses the same intent
// (RED_CARD half as likely as a uniform rare, the freed mass spread over the
// rest of the tier) declaratively and generalises to any future per-type weight.
function pickTypeFromPool(pool, rng, config) {
  if (!pool || pool.length === 0) return null;
  const weights = pool.map((type) => weightForType(type, config));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return pool[Math.floor(rng() * pool.length)];
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// Probability of each individual TYPE for a given race slot: P(tier) times the
// type's weighted share within that tier. Used by the player-facing odds sheet,
// so what a player is shown is derived from the same tables the roll uses.
function typeOddsForPosition(position, totalParticipants, config) {
  const cfg = resolveConfig(config);
  const rarityOdds = rarityOddsForPosition(position, totalParticipants, cfg);
  const out = {};
  RARITY_ORDER.forEach((rarity, tierIndex) => {
    const pool = cfg.dropPool[rarity] || [];
    const weights = pool.map((type) => weightForType(type, cfg));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    pool.forEach((type, i) => {
      out[type] = (out[type] || 0) + rarityOdds[tierIndex] * (weights[i] / total);
    });
  });
  return out;
}

function rollPowerup(position, totalParticipants, rng = Math.random, options = {}) {
  const config = resolveConfig(options.config);
  const [commonOdds, uncommonOdds] = interpolateOdds(
    normalizePosition(position, totalParticipants),
    config
  );

  const roll = rng();
  let rarity;
  if (roll < commonOdds) {
    rarity = "COMMON";
  } else if (roll < commonOdds + uncommonOdds) {
    rarity = "UNCOMMON";
  } else {
    rarity = "RARE";
  }

  rarity = coerceMinRarity(rarity, options.minRarity);

  const type = pickTypeFromPool(config.dropPool[rarity], rng, config);
  return { type, rarity };
}

module.exports = {
  rollPowerup,
  interpolateOdds,
  rarityOddsForPosition,
  typeOddsForPosition,
  pickTypeFromPool,
  normalizePosition,
  coerceMinRarity,
  RARITY_ORDER,
  // Legacy named exports, kept so existing callers and tests keep working. They
  // are live VIEWS onto the active config, not tables — reading one is exactly
  // equivalent to reading getConfigSync().
  get RARITY_TIERS() {
    return balanceConfig.getConfigSync().dropPool;
  },
  get ODDS_TABLE() {
    return balanceConfig.getConfigSync().positionOdds;
  },
};
