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
// Unauthenticated-safe but request-capability-aware. Numeric Stealth copy must
// agree with the behavior selected for that binary, and Quicksand is an unknown
// enum to frozen clients, so it is withheld unless the request advertises p4.
//
// The response is ADDITIVE-ONLY: future fields append and no client may require
// them. `version` is the maximum row updatedAt as an ISO-8601 string, so a client
// can identify its last-known-good snapshot deterministically.
function buildGetPowerupCopyCatalog(deps = {}) {
  const powerupCopyModel = deps.PowerupCopy || PowerupCopy;

  return async function getPowerupCopyCatalog(clientFeatures = new Set()) {
    const rows = (await powerupCopyModel.findAll()) || [];
    const has = (token) =>
      clientFeatures && typeof clientFeatures.has === "function"
        ? clientFeatures.has(token)
        : Array.isArray(clientFeatures) && clientFeatures.includes(token);

    let newest = null;
    for (const row of rows) {
      const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
      if (!updatedAt || Number.isNaN(updatedAt.getTime())) continue;
      if (!newest || updatedAt > newest) newest = updatedAt;
    }

    return {
      version: newest ? newest.toISOString() : null,
      powerups: [...rows]
        .filter((row) => row.powerupType !== "QUICKSAND" || has("powerups4"))
        .sort(compareRows).map((row) => {
        const stealthRunner = row.powerupType === "STEALTH_MODE" && has("stealth_runner_duration");
        const hitchhikeEffective = row.powerupType === "HITCHHIKE" && has("hitchhike_effective_steps");
        return {
        type: row.powerupType,
        name: row.name,
        description: stealthRunner
          ? "Hide your name, steps, and track position for 3 hours."
          : hitchhikeEffective
            ? "Copy the target's effective steps; their boosts and reversals carry over."
            : row.description,
        // Explicit null (never "") so the client omits the effect-rail subtitle
        // rather than rendering a blank line or truncating the description.
        shortDescription: row.shortDescription ?? null,
        upgradeTierLabels: stealthRunner
          ? ["Hide 3h", "Hide 4h", "Hide 5h", "Hide 7h"]
          : Array.isArray(row.upgradeTierLabels) ? row.upgradeTierLabels : [],
      };
      }),
    };
  };
}

const getPowerupCopyCatalog = buildGetPowerupCopyCatalog();

module.exports = { buildGetPowerupCopyCatalog, getPowerupCopyCatalog };
