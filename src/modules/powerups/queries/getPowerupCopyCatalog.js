const { PowerupCopy } = require("../models/powerupCopy");
const { POWERUP_COPY_TYPES } = require("../constants/powerupCopySeed");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

const CATALOG_TTL_SECONDS = 60;

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

  async function assemble(has) {
    const rows = (await powerupCopyModel.findAll()) || [];

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
        // NOTE: stealth copy is deliberately NOT capability-versioned anymore.
        // The `stealth_runner_duration` override used to swap in the 2026-07-24
        // nerf ladder (60/75/90/120 min), but the §3.4 standardization
        // (2026-07-25) made the duration server-computed and uniform — the
        // leftover override then served dead labels to exactly the newest
        // builds ("Hide 90m" for a use that ran 3h, prod bug 2026-07-29). The
        // DB row is the single source of stealth label truth for every client.
        const hitchhikeEffective = row.powerupType === "HITCHHIKE" && has("hitchhike_effective_steps");
        return {
        type: row.powerupType,
        name: row.name,
        description: hitchhikeEffective
          ? "Copy the target's effective steps; their boosts and reversals carry over."
          : row.description,
        // Explicit null (never "") so the client omits the effect-rail subtitle
        // rather than rendering a blank line or truncating the description.
        shortDescription: row.shortDescription ?? null,
        upgradeTierLabels: Array.isArray(row.upgradeTierLabels) ? row.upgradeTierLabels : [],
      };
      }),
    };
  }

  // C1 (spec §5 Phase B). The whole assembled payload is cached because it is
  // fully determined by (rows, capability tokens) — there is nothing per-user in
  // it (the endpoint is unauthenticated). Two capability tokens shape the
  // output, so the key carries both; a single shared key would serve QUICKSAND
  // copy to a frozen binary that treats it as an unknown enum.
  return async function getPowerupCopyCatalog(clientFeatures = new Set()) {
    const has = (token) =>
      clientFeatures && typeof clientFeatures.has === "function"
        ? clientFeatures.has(token)
        : Array.isArray(clientFeatures) && clientFeatures.includes(token);

    let enabled = false;
    try {
      const { appSettings } = require("../../../shared/config/appSettings");
      enabled =
        (await appSettings.getFlag("redisCacheCatalogsEnabled")) === true;
    } catch {
      enabled = false;
    }

    return derivedCache.cachedRead({
      key: cacheKeys.powerupCatalog({
        powerups4: has("powerups4"),
        hitchhikeEffectiveSteps: has("hitchhike_effective_steps"),
      }),
      prefix: cacheKeys.PREFIX.POWERUP_CATALOG,
      ttlSeconds: CATALOG_TTL_SECONDS,
      enabled,
      load: () => assemble(has),
    });
  };
}

const getPowerupCopyCatalog = buildGetPowerupCopyCatalog();

module.exports = { buildGetPowerupCopyCatalog, getPowerupCopyCatalog };
