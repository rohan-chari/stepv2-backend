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
//
// EXCEPTION — the two hard CCs (batch 2026-08-09 item 1, owner decision). A
// 4-hour Leg Cramp / Wrong Turn is oppressive: it takes a player out of the
// race for a whole evening. Each upgrade level now adds 15 MINUTES instead of
// an hour → 1h / 1h15m / 1h30m / 1h45m. The BASE is unchanged, so an
// unupgraded cast is exactly as strong as it has always been and only the
// upgrade ladder is nerfed. Forward-only like every other value here: the
// duration is stamped into the effect row at use time, so in-flight effects
// keep the window they were created with and every app version picks the new
// numbers up on deploy with no release.
//
// The matching cost reprice lives in balanceConfig.defaults `upgradeCosts.byType`
// (arithmetic cost for arithmetic duration) — see the comment there for why it
// is not optional.
const QUARTER_HOUR = 15 * 60 * 1000;
const DURATIONS_MS = {
  LEG_CRAMP:         [1 * HOUR, 1 * HOUR + QUARTER_HOUR, 1 * HOUR + 2 * QUARTER_HOUR, 1 * HOUR + 3 * QUARTER_HOUR],
  RUNNERS_HIGH:      [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  // Stealth adopts the standard 1/2/3/4h ladder (supersedes the 2026-07-24
  // 60/75/90/120 nerf). Server-computed → hits every app version on deploy.
  STEALTH_MODE:      [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR],
  WRONG_TURN:        [1 * HOUR, 1 * HOUR + QUARTER_HOUR, 1 * HOUR + 2 * QUARTER_HOUR, 1 * HOUR + 3 * QUARTER_HOUR],
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

// THE duration string. One function, shared by every surface that tells a
// player how long an effect lasts (batch 2026-08-09 item 1).
//
// This exists because the 15-minute ladder broke three independent formatters
// in three different ways: usePowerup's `hoursText` divided by an hour and
// would have printed "1.25 hours" in the race feed; the push handler's
// `attackWindowText` had a non-integer fallback that printed "75 minutes"; and
// the two would then describe the SAME cast differently in the feed and the
// notification. Fixing each site separately would have left the next
// non-integer duration to rediscover the same bug, so both now delegate here.
//
// Format:
//   whole hours  -> "1 hour" / "4 hours"
//   mixed        -> "1h 15m"   (the target format for the new ladder)
//   under an hour-> "30 minutes" / "1 minute"
// Never emits a decimal.
function formatDuration(durationMs) {
  const totalMinutes = Math.round(durationMs / (60 * 1000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (minutes === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours}h ${minutes}m`;
}

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
  formatDuration,
  isUpgradeable,
  isValidLevel,
  upgradeCost,
  upgradedDuration,
  upgradedMagnitude,
};
