// Character powers (§3.6) — pure, DB-free helpers shared by the live display
// (getRaceProgress) and settlement (raceExpiry) so the two score identically.
//
//   * Bara herd bonus: a capybara participant earns 100 × (capybara count in the
//     race, incl. self, capped at 10) bonus steps per race-local calendar day,
//     capped at 1,000/day. Part of the existing bonusSteps term — NEVER minted as
//     rows and NEVER folded into box progress.
//   * Corgi zoomies: two secret 10-minute 3x windows per user-local day, folded
//     into scoring as a +multiplier self-buff via the shared effectMultiplier math.
//
// Everything here is behind the CHARACTER_POWERS_ENABLED env gate at the call
// sites; these helpers are pure and always safe to call.

const {
  getTimeZoneParts,
  formatDateString,
  parseDateString,
} = require("../../../shared/time/week");
const { balanceConfig } = require("../../economy/balanceConfig");

// ── Env gates (§7) ──────────────────────────────────────────────────────────
// Default OFF. Read at call time so a prod .env flip takes effect on the next
// request/cron tick without a redeploy.
function characterPowersEnabled() {
  return process.env.CHARACTER_POWERS_ENABLED === "true";
}
function zoomiesPushDisabled() {
  return process.env.ZOOMIES_PUSH_DISABLED === "true";
}
// Turtle-only kill switch (spec §9). Flipping this leaves the cosmetic
// purchasable and every other character power untouched. Read at call time.
function turtleShellDisabled() {
  return process.env.TURTLE_SHELL_DISABLED === "true";
}

// ── Gameplay character detection ────────────────────────────────────────────
// The CHARACTER-slot assetKey drives gameplay, INCLUDING testOnly items (a
// testOnly corgi still gets zoomies for its equipper). This is deliberately NOT
// cosmetics.equippedAnimal, which strips testOnly for OTHER-user presentation.
function characterAnimal(user) {
  const character = (user?.equippedAccessories || []).find(
    (a) => a.shopItem?.slot === "CHARACTER"
  );
  return character ? character.shopItem.assetKey : null;
}

// Default (no CHARACTER cosmetic) counts as capybara (owner-confirmed 2026-07-24),
// as does any explicitly capybara-keyed item.
function isCapybara(user) {
  const animal = characterAnimal(user);
  if (!animal) return true;
  return String(animal).toLowerCase().startsWith("capybara");
}

function isCorgi(user) {
  const animal = characterAnimal(user);
  return typeof animal === "string" && animal.toLowerCase().startsWith("corgi");
}

function isTurtle(user) {
  const animal = characterAnimal(user);
  return typeof animal === "string" && animal.toLowerCase().startsWith("turtle");
}

// ── Turtle "Shell" block (spec §5.1/§5.2) ───────────────────────────────────
// A turtle-equipped defender bounces 30% of incoming attacks whose TYPE is
// obtainable from an in-race mystery-box roll. Per-TYPE, never per-instance
// (D3): a Leg Cramp bought for coins, won on the daily spin, stolen, or dropped
// from a box are all identical to the Shell — the coin shop sells the
// race-rollable attack types too, so a per-instance test would let most real
// attacks straight through.
const SHELL_BLOCK_CHANCE = 0.3;

// The in-race mystery-box drop pool is THE authority — read from balance config
// at call time, never a second hardcoded list (the exact class of drift D13
// removed). Reads defensively: a missing/broken config means "not blockable",
// which is the safe direction (the Shell simply doesn't fire).
function isRaceRolledType(type, config = null) {
  if (!type) return false;
  let resolved = config;
  if (!resolved) {
    try {
      resolved = balanceConfig.getConfigSync ? balanceConfig.getConfigSync() : null;
    } catch {
      resolved = null;
    }
  }
  const pool = (resolved && resolved.dropPool) || {};
  return ["COMMON", "UNCOMMON", "RARE"].some((tier) =>
    (pool[tier] || []).includes(type)
  );
}

// Pure, DB-free. `random` is injected exactly like the `random` threaded through
// usePowerup so tests are deterministic. Both env gates are read at call time.
function shellBlocksAttack({
  targetUser,
  powerupType,
  random = Math.random,
  config = null,
} = {}) {
  if (!characterPowersEnabled()) return false;
  if (turtleShellDisabled()) return false;
  if (!isTurtle(targetUser)) return false;
  if (!isRaceRolledType(powerupType, config)) return false;
  return random() < SHELL_BLOCK_CHANCE;
}

// ── Herd bonus ──────────────────────────────────────────────────────────────
const HERD_BONUS_PER_CAPY = 100;
const HERD_MAX_CAPY = 10; // caps per-day bonus at 1,000
const HERD_DAILY_CAP = HERD_BONUS_PER_CAPY * HERD_MAX_CAPY; // 1000

// Count capybara participants among the accepted set (live equip at read time).
function countCapybaras(acceptedParticipants) {
  return (acceptedParticipants || []).filter((p) => isCapybara(p.user)).length;
}

// Per-day herd bonus for a race with `capyCount` capybaras: 100 × min(count,10),
// capped at 1,000. Non-capybaras earn 0 (checked by the caller).
function herdPerDay(capyCount) {
  const capped = Math.min(Math.max(0, capyCount || 0), HERD_MAX_CAPY);
  return capped * HERD_BONUS_PER_CAPY;
}

// Local-calendar-day ordinal for a date string (days since epoch), so a
// same-tz inclusive day span is a simple difference.
function localDateOrdinal(dateStr) {
  const { year, month, day } = parseDateString(dateStr);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

// Inclusive race-local calendar-day count from the participant's join day
// (day 1) through min(now, race end), bucketed in the race tz — the SAME
// bucketing calculateBaseAdjusted uses. Always >= 1 (join day counts fully).
function raceLocalDayCount({ effectiveStart, end, timeZone }) {
  const s = getTimeZoneParts(effectiveStart, timeZone);
  const e = getTimeZoneParts(end, timeZone);
  const startStr = formatDateString(s.year, s.month, s.day);
  const endStr = formatDateString(e.year, e.month, e.day);
  const days = localDateOrdinal(endStr) - localDateOrdinal(startStr) + 1;
  return Math.max(1, days);
}

// Herd bonus (steps) for one participant. Returns { animal, perDay, bonusSteps };
// bonusSteps is 0 (and animal null) for non-capybaras. `capyCount` is computed
// once per race by the caller and passed in (live-equip semantics).
function computeHerdBonus({ participant, capyCount, effectiveStart, end, timeZone }) {
  if (!isCapybara(participant.user)) {
    return { animal: null, perDay: 0, bonusSteps: 0, days: 0 };
  }
  const perDay = herdPerDay(capyCount);
  const days = raceLocalDayCount({ effectiveStart, end, timeZone });
  return { animal: "capybara", perDay, bonusSteps: perDay * days, days };
}

// ── Zoomies (Corgi) window draw ─────────────────────────────────────────────
const ZOOMIES_MULTIPLIER = 3;
const ZOOMIES_WINDOW_LEN_MIN = 10;
const ZOOMIES_WINDOW_MS = ZOOMIES_WINDOW_LEN_MIN * 60 * 1000;
const ZOOMIES_DAY_START_MIN = 8 * 60; //  480 (08:00 local)
const ZOOMIES_DAY_END_MIN = 22 * 60; // 1320 (22:00 local — windows must end by here)
const ZOOMIES_MIN_GAP_MIN = 2 * 60; //  120 (>= 2h apart)
const ZOOMIES_SLOTS = 2;
// Catch window for the push: fire once when a materialized window is live.
const ZOOMIES_CATCH_WINDOW_MS = 10 * 60 * 1000;

// Deterministic small integer in [0, mod) from a string seed (FNV-1a), same
// construction as the global-event draw. Seeds the per-user-day time picks so
// every scheduler tick agrees without persisting the draw.
function hashToInt(seed, mod) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % mod;
}

// Two deterministic 10-minute window START minutes (after local midnight) for
// (userId, localDayKey): both inside [08:00, 22:00) local, >= 2h apart, earlier
// first. `pickInt` is injectable for tests; production uses the FNV-1a hash.
function drawZoomiesStartMinutes(userId, localDayKey, pickInt = hashToInt) {
  const latestStart = ZOOMIES_DAY_END_MIN - ZOOMIES_WINDOW_LEN_MIN; // 1310
  // Slot 0 (earlier) must leave room for slot 1 = a + gap .. latestStart.
  const aMax = latestStart - ZOOMIES_MIN_GAP_MIN; // 1190
  const aRange = aMax - ZOOMIES_DAY_START_MIN + 1; // 711
  const a =
    ZOOMIES_DAY_START_MIN + pickInt(`${userId}:${localDayKey}:z0`, aRange);
  const bMin = a + ZOOMIES_MIN_GAP_MIN;
  const bRange = latestStart - bMin + 1;
  const b = bMin + pickInt(`${userId}:${localDayKey}:z1`, bRange);
  return [a, b];
}

// Convert materialized CharacterEffectWindow rows into pseudo-effect rows the
// shared effectMultiplier math folds in as a +multiplier self-buff.
function zoomiesWindowsToEffects(windows) {
  return (windows || []).map((w) => ({
    type: "ZOOMIES",
    startsAt: w.startsAt,
    expiresAt: w.endsAt,
    metadata: { multiplier: Number(w.multiplier) || ZOOMIES_MULTIPLIER },
  }));
}

// The window (if any) active at `nowMs` among a user's rows — for the additive
// `zoomies` progress block.
function activeZoomiesAt(windows, nowMs) {
  for (const w of windows || []) {
    const s = new Date(w.startsAt).getTime();
    const e = new Date(w.endsAt).getTime();
    if (s <= nowMs && nowMs < e) return { active: true, endsAt: w.endsAt };
  }
  return null;
}

module.exports = {
  characterPowersEnabled,
  zoomiesPushDisabled,
  turtleShellDisabled,
  characterAnimal,
  isCapybara,
  isCorgi,
  isTurtle,
  SHELL_BLOCK_CHANCE,
  isRaceRolledType,
  shellBlocksAttack,
  HERD_BONUS_PER_CAPY,
  HERD_MAX_CAPY,
  HERD_DAILY_CAP,
  countCapybaras,
  herdPerDay,
  raceLocalDayCount,
  computeHerdBonus,
  ZOOMIES_MULTIPLIER,
  ZOOMIES_WINDOW_LEN_MIN,
  ZOOMIES_WINDOW_MS,
  ZOOMIES_DAY_START_MIN,
  ZOOMIES_DAY_END_MIN,
  ZOOMIES_MIN_GAP_MIN,
  ZOOMIES_SLOTS,
  ZOOMIES_CATCH_WINDOW_MS,
  hashToInt,
  drawZoomiesStartMinutes,
  zoomiesWindowsToEffects,
  activeZoomiesAt,
};
