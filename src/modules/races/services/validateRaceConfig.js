const { validateRaceBuyInConfig } = require("./raceBuyIns");
const { censor } = require("../../../shared/lib/profanity");
const {
  FIXED_POWERUP_STEP_INTERVAL,
} = require("../constants/powerupInterval");

/**
 * Shared validators for race configuration fields. Each helper throws via the
 * caller-provided ErrorClass(message, statusCode) so each command can map to
 * its own error type.
 */

function validateRaceName(name, ErrorClass) {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new ErrorClass("Race name is required", 400);
  }
  if (name.trim().length > 50) {
    throw new ErrorClass("Race name must be 50 characters or less", 400);
  }
  const trimmed = name.trim();
  // Reject-on-write like display names (displayNameValidator.js) — race names
  // are surfaced everywhere (lists, invites, chat payloads), so don't store
  // profanity and rely on display-time masking.
  if (censor(trimmed) !== trimmed) {
    throw new ErrorClass("Race name contains inappropriate language", 400);
  }
  return trimmed;
}

function validateDuration(maxDurationDays, ErrorClass) {
  if (
    !Number.isInteger(maxDurationDays) ||
    maxDurationDays < 1 ||
    maxDurationDays > 30
  ) {
    throw new ErrorClass("Duration must be between 1 and 30 days", 400);
  }
  return maxDurationDays;
}

// ── Custom race windows (docs/race-timeline-options-requirements.md §5.2/5.6) ─

const DAY_MS = 24 * 60 * 60 * 1000;

// The floor on a custom window. Custom buys an EXACT END INSTANT, not a shorter
// race: every race that has ever run is >= 1 day, and five systems assume it
// (calendar-day step bucketing, the hasSampleData start-day buff zeroing, the
// 2,000-step box cadence, the >2h final-stretch nudge guard, and the 5-minute
// settlement cron). A 24h floor keeps every custom race inside territory prod
// already exercises. ONE named constant on purpose (spec §5.6): relaxing it
// later is a one-line change plus that section's risk list.
const MIN_RACE_WINDOW_MS = 24 * 60 * 60 * 1000;

// The ceiling is the SAME bound validateDuration already enforces (30 days), so
// a window can never express a race the duration field couldn't.
const MAX_RACE_WINDOW_MS = 30 * DAY_MS;

// Parse an optional scheduledEndAt. Returns a Date, or null when absent/empty/
// UNPARSEABLE. Unparseable is deliberately treated as "not provided" rather than
// a 400 — the exact forgiving rule createRace's validateScheduledStartAt uses,
// so a quirky or older client can never have a race rejected for sending junk
// in a field the server owns anyway.
function parseScheduledEndAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

// Validate a resolved (start, end) pair. `effectiveStart` is scheduledStartAt
// when set, else now — so a manual-start custom race's window is measured from
// the moment of the request. Callers MUST pass the MERGED pair on edit (spec
// §5.2): a PATCH that moves only one end still has to leave a legal window
// against the STORED other end.
//
// All four failures are 400 with an additive machine-readable `code`; old
// clients read `error` alone and are unaffected.
function validateRaceWindow({
  effectiveStart,
  scheduledEndAt,
  now = new Date(),
  ErrorClass,
}) {
  if (!scheduledEndAt) return null;
  const startMs = new Date(effectiveStart).getTime();
  const endMs = new Date(scheduledEndAt).getTime();
  const throwWith = (message, code) => {
    const err = new ErrorClass(message, 400);
    err.code = code;
    throw err;
  };
  if (!(endMs > startMs)) {
    throwWith("The race has to end after it starts", "RACE_WINDOW_INVALID");
  }
  if (endMs <= now.getTime()) {
    throwWith("The race end time must be in the future", "RACE_WINDOW_INVALID");
  }
  const windowMs = endMs - startMs;
  if (windowMs < MIN_RACE_WINDOW_MS) {
    throwWith("A race has to run at least 1 day", "RACE_WINDOW_TOO_SHORT");
  }
  if (windowMs > MAX_RACE_WINDOW_MS) {
    throwWith("A race can run at most 30 days", "RACE_WINDOW_TOO_LONG");
  }
  return scheduledEndAt;
}

// The priced duration implied by a window: FLOOR of whole elapsed days, clamped
// to the legal 1..30 band.
//
// FLOOR, never ceil or round (game-analyst R1 — the ceil draft was rated
// UNSOUND). The metric that governs an app-funded pool is coins minted per
// walker per ELAPSED day, and floor is the only rounding that holds it at
// today's ceiling of 20: with ceil, a 24h+1min window prices at the 2-day band
// and DOUBLES the mint rate of the most-used duration in prod, in a number the
// create screen shows the creator. floor also keeps durationPoints monotonic
// non-decreasing over the whole range, so prizePool.js's invariant — a shorter
// competition can never pay more than a longer one — survives.
function durationDaysFromWindow(startAt, endAt) {
  const startMs = new Date(startAt).getTime();
  const endMs = new Date(endAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const days = Math.floor((endMs - startMs) / DAY_MS);
  return Math.min(30, Math.max(1, days));
}

// Returns the interval to persist: the fixed 2,000 when powerups are on, else
// null. The caller's powerupStepInterval is read ONLY by old clients that still
// send one, and is deliberately DISCARDED — accepted and ignored, never a 400
// (same shape as the app-funded buy-in coercion in createRace.js). The legacy
// "must be between 2,000 and 50,000" error is retired: there is nothing left to
// validate once the value is thrown away, and a 400 would only punish a frozen
// binary for a number we ignore.
//
// This returns the value (rather than validating in place) on purpose: a call
// site that forgets to use the return stores `undefined` and fails loudly,
// instead of silently persisting the client's number.
function normalizePowerupConfig({ powerupsEnabled }) {
  return powerupsEnabled ? FIXED_POWERUP_STEP_INTERVAL : null;
}

function validateMaxParticipants(maxParticipants, ErrorClass) {
  // null/undefined => unlimited (no participant cap). Stored as NULL.
  if (maxParticipants === null || maxParticipants === undefined) {
    return null;
  }
  if (
    !Number.isInteger(maxParticipants) ||
    maxParticipants < 2 ||
    maxParticipants > 100
  ) {
    throw new ErrorClass("Max participants must be between 2 and 100", 400);
  }
  return maxParticipants;
}

// ── Team races (TR-100s) ────────────────────────────────────────────────────

const TEAM_NAME_MAX_LENGTH = 24;

// TR-103: a creator-supplied team name override. Same sanitization as race
// names (trim + profanity reject-on-write), but capped at 24 chars. Returns the
// trimmed name. `label` names the side in error copy ("Team A name…").
function validateTeamName(name, ErrorClass, label = "Team name") {
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new ErrorClass(`${label} is required`, 400);
  }
  const trimmed = name.trim();
  if (trimmed.length > TEAM_NAME_MAX_LENGTH) {
    throw new ErrorClass(
      `${label} must be ${TEAM_NAME_MAX_LENGTH} characters or less`,
      400
    );
  }
  if (censor(trimmed) !== trimmed) {
    throw new ErrorClass(`${label} contains inappropriate language`, 400);
  }
  return trimmed;
}

// TR-106: team size must be an integer 1..5.
function validateTeamSize(teamSize, ErrorClass) {
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 5) {
    throw new ErrorClass("Team size must be between 1 and 5", 400);
  }
  return teamSize;
}

// TR-103: the two side names must differ case-insensitively.
function assertTeamNamesDiffer(teamAName, teamBName, ErrorClass) {
  if (
    typeof teamAName === "string" &&
    typeof teamBName === "string" &&
    teamAName.trim().toLowerCase() === teamBName.trim().toLowerCase()
  ) {
    const err = new ErrorClass("Team names must be different", 400);
    err.code = "TEAM_NAMES_IDENTICAL";
    throw err;
  }
}

// TR-104 / TR-201: normalize a side value. Required (throws) when `required`,
// else defaults to TEAM_A. Accepts only TEAM_A|TEAM_B.
function validateTeamSide(team, ErrorClass, { required = false } = {}) {
  if (team === null || team === undefined || team === "") {
    if (required) {
      throw new ErrorClass("A team side (TEAM_A or TEAM_B) is required", 400);
    }
    return "TEAM_A";
  }
  if (team !== "TEAM_A" && team !== "TEAM_B") {
    throw new ErrorClass("Team must be TEAM_A or TEAM_B", 400);
  }
  return team;
}

module.exports = {
  validateRaceName,
  validateDuration,
  MIN_RACE_WINDOW_MS,
  MAX_RACE_WINDOW_MS,
  parseScheduledEndAt,
  validateRaceWindow,
  durationDaysFromWindow,
  normalizePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
  TEAM_NAME_MAX_LENGTH,
  validateTeamName,
  validateTeamSize,
  assertTeamNamesDiffer,
  validateTeamSide,
};
