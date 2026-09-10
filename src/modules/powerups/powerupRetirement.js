const RETIRED_POWERUP_TYPES = new Set(["IMPOSTER"]);

function isRetiredPowerupType(powerupType) {
  return RETIRED_POWERUP_TYPES.has(powerupType);
}

// Presentation policy only: apply after cache reads, without changing the
// canonical inventory used for slot capacity, ownership, or mutation checks.
function isVisiblePowerupInventoryRow(row) {
  return !isRetiredPowerupType(row?.type ?? row?.powerupType);
}

function isRetiredPowerupRequest({ sku, powerupType } = {}) {
  return (
    isRetiredPowerupType(powerupType) ||
    (typeof sku === "string" &&
      isRetiredPowerupType(sku.replace(/^POWERUP_/, "")))
  );
}

function retiredPowerupBody(powerupType = "IMPOSTER") {
  return {
    error: "This powerup has been retired.",
    code: "POWERUP_RETIRED",
    powerupType,
  };
}

function markRetiredPowerupError(error, powerupType = "IMPOSTER") {
  error.statusCode = 410;
  error.code = "POWERUP_RETIRED";
  error.powerupType = powerupType;
  return error;
}

module.exports = {
  RETIRED_POWERUP_TYPES,
  isRetiredPowerupType,
  isVisiblePowerupInventoryRow,
  isRetiredPowerupRequest,
  retiredPowerupBody,
  markRetiredPowerupError,
};
