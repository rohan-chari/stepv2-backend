const { validateRaceBuyInConfig } = require("./raceBuyIns");

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
  return name.trim();
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
  if (
    !Number.isInteger(maxParticipants) ||
    maxParticipants < 2 ||
    maxParticipants > 100
  ) {
    throw new ErrorClass("Max participants must be between 2 and 100", 400);
  }
  return maxParticipants;
}

module.exports = {
  validateRaceName,
  validateDuration,
  validatePowerupConfig,
  validateMaxParticipants,
  validateRaceBuyInConfig,
};
