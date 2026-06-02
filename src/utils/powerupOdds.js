// NOTE: CAMPFIRE_REST is intentionally NOT generated anymore (1.1.7). Its enum
// value and effect-resolution code are kept (old apps + in-flight effects still
// resolve it), but it is no longer rolled into new mystery boxes.
const RARITY_TIERS = {
  COMMON: ["PROTEIN_SHAKE", "SHORTCUT", "TRAIL_MIX", "DETOUR_SIGN"],
  UNCOMMON: ["RUNNERS_HIGH", "LEG_CRAMP", "STEALTH_MODE", "WRONG_TURN", "PINECONE_TOSS", "CLEANSE"],
  RARE: ["RED_CARD", "SECOND_WIND", "COMPRESSION_SOCKS", "FANNY_PACK", "LUCKY_HORSESHOE", "POCKET_WATCH", "TRAIL_MINE", "SNEAKY_SWAP", "MIRROR"],
};

const RARITY_ORDER = ["COMMON", "UNCOMMON", "RARE"];

function coerceMinRarity(rarity, minRarity) {
  if (!minRarity) return rarity;
  const rarityIndex = RARITY_ORDER.indexOf(rarity);
  const minIndex = RARITY_ORDER.indexOf(minRarity);
  if (rarityIndex === -1 || minIndex === -1) return rarity;
  return RARITY_ORDER[Math.max(rarityIndex, minIndex)];
}

// Position-based odds: [COMMON%, UNCOMMON%, RARE%]
// Row 0 = leader (1st place), Row 1 = last place
const ODDS_TABLE = {
  first: [0.70, 0.25, 0.05],
  last:  [0.20, 0.35, 0.45],
};

function interpolateOdds(normalizedPosition) {
  // normalizedPosition: 0 = leader, 1 = last place
  const t = Math.max(0, Math.min(1, normalizedPosition));
  return [
    ODDS_TABLE.first[0] + t * (ODDS_TABLE.last[0] - ODDS_TABLE.first[0]),
    ODDS_TABLE.first[1] + t * (ODDS_TABLE.last[1] - ODDS_TABLE.first[1]),
    ODDS_TABLE.first[2] + t * (ODDS_TABLE.last[2] - ODDS_TABLE.first[2]),
  ];
}

function rollPowerup(position, totalParticipants, rng = Math.random, options = {}) {
  // position is 1-based rank (1 = leader)
  const normalizedPosition = totalParticipants <= 1
    ? 0.5
    : (position - 1) / (totalParticipants - 1);

  const [commonOdds, uncommonOdds] = interpolateOdds(normalizedPosition);

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

  const tierPowerups = RARITY_TIERS[rarity];
  const typeIndex = Math.floor(rng() * tierPowerups.length);
  const type = tierPowerups[typeIndex];

  return { type, rarity };
}

module.exports = { rollPowerup, interpolateOdds, RARITY_TIERS, ODDS_TABLE, RARITY_ORDER };
