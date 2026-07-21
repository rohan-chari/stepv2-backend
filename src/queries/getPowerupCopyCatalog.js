const { PowerupCopy } = require("../models/powerupCopy");
const { POWERUP_COPY_TYPES } = require("../constants/powerupCopySeed");

// Stable serialization order: the canonical seed order, then anything unknown
// (a row added ahead of a code deploy) appended alphabetically. Clients key by
// `type`, so order is cosmetic — but a stable order keeps responses diffable.
const ORDER_INDEX = new Map(
  POWERUP_COPY_TYPES.map((type, index) => [type, index])
);

function compareRows(a, b) {
  const ai = ORDER_INDEX.has(a.powerupType)
    ? ORDER_INDEX.get(a.powerupType)
    : Number.MAX_SAFE_INTEGER;
  const bi = ORDER_INDEX.has(b.powerupType)
    ? ORDER_INDEX.get(b.powerupType)
    : Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;
  return String(a.powerupType).localeCompare(String(b.powerupType));
}

// GET /powerups/catalog (§9.5.3) — every user-renderable powerup's copy.
//
// Deliberately unauthenticated-safe and client-feature-INDEPENDENT: copy is not
// a capability. Acquisition gating happens at the shop / roll layer, so
// receiving copy for a type a client cannot obtain is harmless — and withholding
// it would strand a client that legitimately owns a banked powerup.
//
// The response is ADDITIVE-ONLY: future fields append and no client may require
// them. `version` is the maximum row updatedAt as an ISO-8601 string, so a client
// can identify its last-known-good snapshot deterministically.
function buildGetPowerupCopyCatalog(deps = {}) {
  const powerupCopyModel = deps.PowerupCopy || PowerupCopy;

  return async function getPowerupCopyCatalog() {
    const rows = (await powerupCopyModel.findAll()) || [];

    let newest = null;
    for (const row of rows) {
      const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
      if (!updatedAt || Number.isNaN(updatedAt.getTime())) continue;
      if (!newest || updatedAt > newest) newest = updatedAt;
    }

    return {
      version: newest ? newest.toISOString() : null,
      powerups: [...rows].sort(compareRows).map((row) => ({
        type: row.powerupType,
        name: row.name,
        description: row.description,
        // Explicit null (never "") so the client omits the effect-rail subtitle
        // rather than rendering a blank line or truncating the description.
        shortDescription: row.shortDescription ?? null,
        upgradeTierLabels: Array.isArray(row.upgradeTierLabels)
          ? row.upgradeTierLabels
          : [],
      })),
    };
  };
}

const getPowerupCopyCatalog = buildGetPowerupCopyCatalog();

module.exports = { buildGetPowerupCopyCatalog, getPowerupCopyCatalog };
