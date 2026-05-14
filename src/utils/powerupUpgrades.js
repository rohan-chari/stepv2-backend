const HOUR = 60 * 60 * 1000;

const MAX_UPGRADE_LEVEL = 3;

const UPGRADEABLE_TYPES = new Set([
  "PROTEIN_SHAKE",
  "SHORTCUT",
  "DETOUR_SIGN",
  "TRAIL_MIX",
  "RUNNERS_HIGH",
  "LEG_CRAMP",
  "STEALTH_MODE",
  "WRONG_TURN",
  "COMPRESSION_SOCKS",
  "LUCKY_HORSESHOE",
  "CAMPFIRE_REST",
  "TRAIL_MAGNET",
  "POCKET_WATCH",
  "TRAIL_MINE",
  "PINECONE_TOSS",
]);

// Cost by [rarity][level], where index 0 is base (free).
const COSTS_BY_RARITY = {
  COMMON:   [0, 25,  75, 225],
  UNCOMMON: [0, 45, 135, 400],
  RARE:     [0, 50, 150, 450],
};

const COSTS_BY_TYPE = {
  LUCKY_HORSESHOE: [0, 250, 600, 1200],
};

const RARITY_BY_TYPE = {
  PROTEIN_SHAKE:     "COMMON",
  SHORTCUT:          "COMMON",
  DETOUR_SIGN:       "COMMON",
  TRAIL_MIX:         "COMMON",
  RUNNERS_HIGH:      "UNCOMMON",
  LEG_CRAMP:         "UNCOMMON",
  STEALTH_MODE:      "UNCOMMON",
  WRONG_TURN:        "UNCOMMON",
  COMPRESSION_SOCKS: "RARE",
  LUCKY_HORSESHOE:   "RARE",
  CAMPFIRE_REST:     "UNCOMMON",
  TRAIL_MAGNET:      "COMMON",
  POCKET_WATCH:      "RARE",
  TRAIL_MINE:        "RARE",
  PINECONE_TOSS:     "UNCOMMON",
  SNEAKY_SWAP:       "RARE",
};

// Duration in ms for timed effects, indexed by level.
const DURATIONS_MS = {
  LEG_CRAMP:         [2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR],
  RUNNERS_HIGH:      [3 * HOUR, 4 * HOUR, 5 * HOUR, 7 * HOUR],
  STEALTH_MODE:      [4 * HOUR, 5 * HOUR, 6.5 * HOUR, 8 * HOUR],
  WRONG_TURN:        [1 * HOUR, 1.5 * HOUR, 2 * HOUR, 3 * HOUR],
  DETOUR_SIGN:       [3 * HOUR, 4 * HOUR, 5 * HOUR, 7 * HOUR],
  COMPRESSION_SOCKS: [24 * HOUR, 30 * HOUR, 36 * HOUR, 48 * HOUR],
  CAMPFIRE_REST:     [45 * 60 * 1000, 60 * 60 * 1000, 75 * 60 * 1000, 90 * 60 * 1000],
  POCKET_WATCH:      [1 * HOUR, 1.5 * HOUR, 2 * HOUR, 3 * HOUR],
};

// Magnitude (steps) for instant-bonus / steal-cap powerups, indexed by level.
// For TRAIL_MIX, the magnitude is the per-unique-type bonus (final reward = magnitude * uniqueTypes).
const MAGNITUDES = {
  PROTEIN_SHAKE: [1500, 2250, 3000, 4500],
  SHORTCUT:      [1000, 1500, 2000, 3000],
  TRAIL_MIX:     [100,  150,  200,  300],
  TRAIL_MAGNET:  [1000, 1500, 2000, 3000],
  TRAIL_MINE:    [0.03, 0.05, 0.08, 0.12],
  PINECONE_TOSS: [750, 1000, 1500, 2250],
  CAMPFIRE_REST: [2.25, 2.5, 2.75, 3],
};

function isUpgradeable(type) {
  return UPGRADEABLE_TYPES.has(type);
}

function isValidLevel(level) {
  return Number.isInteger(level) && level >= 0 && level <= MAX_UPGRADE_LEVEL;
}

function upgradeCost(type, level) {
  if (!isValidLevel(level)) {
    throw new Error(`Invalid upgrade level: ${level}`);
  }
  if (level === 0) return 0;
  if (!isUpgradeable(type)) {
    throw new Error(`${type} is not upgradeable`);
  }
  if (COSTS_BY_TYPE[type]) return COSTS_BY_TYPE[type][level];
  const rarity = RARITY_BY_TYPE[type];
  return COSTS_BY_RARITY[rarity][level];
}

function upgradedDuration(type, level) {
  if (!isValidLevel(level)) {
    throw new Error(`Invalid upgrade level: ${level}`);
  }
  if (!DURATIONS_MS[type]) {
    throw new Error(`${type} has no duration knob (or is not upgradeable)`);
  }
  return DURATIONS_MS[type][level];
}

function upgradedMagnitude(type, level) {
  if (!isValidLevel(level)) {
    throw new Error(`Invalid upgrade level: ${level}`);
  }
  if (!MAGNITUDES[type]) {
    throw new Error(`${type} has no magnitude knob`);
  }
  return MAGNITUDES[type][level];
}

module.exports = {
  MAX_UPGRADE_LEVEL,
  UPGRADEABLE_TYPES,
  COSTS_BY_RARITY,
  COSTS_BY_TYPE,
  RARITY_BY_TYPE,
  DURATIONS_MS,
  MAGNITUDES,
  isUpgradeable,
  isValidLevel,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
};
