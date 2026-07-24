const { balanceConfig } = require("../economy/balanceConfig");

const HOUR = 60 * 60 * 1000;

const MAX_UPGRADE_LEVEL = 3;

// Rarity, the upgradeable set, and the cost ladders all live in the balance
// config now — they used to be duplicated here AND in powerupOdds.js, and the
// two disagreed (SHORTCUT was COMMON here and RARE there, so a Shortcut dropped
// as a rare but upgraded at common prices). Conflicts resolved toward the drop
// table. Do not reintroduce a table in this file; a structural guard test fails
// if you do.
//
// DURATIONS_MS and MAGNITUDES below are NOT balance config in this build: they
// are per-type effect mechanics rather than the rarity/price/odds surface the
// admin editor exposes. They stay here deliberately, and are explicitly allowed
// by the structural guard.

function config() {
  return balanceConfig.getConfigSync();
}

function rarityForType(type) {
  return config().rarityByType[type];
}

// Duration in ms for timed effects, indexed by level.
//
// Duration standardization (2026-07-25, owner-approved §3.4): every windowed,
// upgradeable powerup runs 1h base and +1h per upgrade level → 1/2/3/4h. Only
// NEW uses get the new window (durations are stamped into the effect row at use
// time), so running effects are untouched — forward-only. The strong-short
// exceptions (GHOST_PEPPER 30m, CAMPFIRE_REST) and the long passives
// (COMPRESSION_SOCKS shield) keep their historical durations.
const DURATIONS_MS = {
  LEG_CRAMP:         [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  RUNNERS_HIGH:      [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  // Stealth adopts the standard 1/2/3/4h ladder (supersedes the 2026-07-24
  // 60/75/90/120 nerf). Server-computed → hits every app version on deploy.
  STEALTH_MODE:      [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  WRONG_TURN:        [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  DETOUR_SIGN:       [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  COMPRESSION_SOCKS: [24 * HOUR, 30 * HOUR, 36 * HOUR, 48 * HOUR],
  CAMPFIRE_REST:     [45 * 60 * 1000, 60 * 60 * 1000, 75 * 60 * 1000, 90 * 60 * 1000],
  POCKET_WATCH:      [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
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
  return upgradeableTypes().has(type);
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
  const { byRarity, byType } = config().upgradeCosts;
  if (byType && byType[type]) return byType[type][level];
  const rarity = rarityForType(type);
  return byRarity[rarity][level];
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

// Live views onto the active config, kept under their historical names so
// existing callers and tests keep working. Reading one is equivalent to reading
// getConfigSync().
function upgradeableTypes() {
  return new Set(config().upgradeableTypes);
}

module.exports = {
  MAX_UPGRADE_LEVEL,
  get UPGRADEABLE_TYPES() {
    return upgradeableTypes();
  },
  get COSTS_BY_RARITY() {
    return config().upgradeCosts.byRarity;
  },
  get COSTS_BY_TYPE() {
    return config().upgradeCosts.byType;
  },
  get RARITY_BY_TYPE() {
    return config().rarityByType;
  },
  rarityForType,
  DURATIONS_MS,
  MAGNITUDES,
  isUpgradeable,
  isValidLevel,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
};
