const { validateRaceBuyInConfig } = require("./raceBuyIns");
const { censor } = require("../lib/profanity");

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

function validatePowerupConfig({ powerupsEnabled, powerupStepInterval, ErrorClass }) {
  if (powerupsEnabled) {
    if (
      !powerupStepInterval ||
      powerupStepInterval < 2000 ||
      powerupStepInterval > 50000
    ) {
      throw new ErrorClass(
        "Powerup step interval must be between 2,000 and 50,000",
        400
      );
    }
  }
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
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
  TEAM_NAME_MAX_LENGTH,
  validateTeamName,
  validateTeamSize,
  assertTeamNamesDiffer,
  validateTeamSide,
};
