const RARITY_TIERS = {
  COMMON: ["PROTEIN_SHAKE", "BANANA_PEEL"],
  UNCOMMON: ["RUNNERS_HIGH", "LEG_CRAMP", "STEALTH_MODE"],
  RARE: ["RED_CARD", "SECOND_WIND", "COMPRESSION_SOCKS"],
};

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

function rollPowerup(position, totalParticipants, rng = Math.random) {
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

  const tierPowerups = RARITY_TIERS[rarity];
  const typeIndex = Math.floor(rng() * tierPowerups.length);
  const type = tierPowerups[typeIndex];

  return { type, rarity };
}

module.exports = { rollPowerup, interpolateOdds, RARITY_TIERS, ODDS_TABLE };
