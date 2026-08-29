const { PowerupCopy } = require("../models/powerupCopy");
const { PowerupShopItem } = require("../models/powerupShopItem");
const { POWERUP_COPY_TYPES } = require("../constants/powerupCopySeed");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { isPowerupVisibleToClient } = require("../constants/powerupGating");
const { balanceConfig: defaultBalanceConfig } = require("../../economy/balanceConfig");
const {
  canonicalRollAvailabilityForClient: defaultCanonicalRollAvailabilityForClient,
} = require("../powerupOdds");
const {
  STACKING_VERSION,
  POWERUP_STACKING_GUIDE,
  validatePowerupStackingGuide,
} = require("../constants/powerupStackingGuide");

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
  const powerupShopItemModel = deps.PowerupShopItem || PowerupShopItem;
  const powerupBalanceConfig = deps.powerupBalanceConfig || defaultBalanceConfig;
  const canonicalRollAvailabilityForClient =
    deps.canonicalRollAvailabilityForClient ||
    defaultCanonicalRollAvailabilityForClient;
  validatePowerupStackingGuide(POWERUP_COPY_TYPES);

  async function assemble(has, { filterByCapabilities, channel }) {
    const rows = (await powerupCopyModel.findAll()) || [];
    let availabilityKnown = false;
    let shopTypes = new Set();
    let rollTypes = new Set();
    const clientCapabilities = {
      supportsJammer: has("jammer"),
      supportsPowerups2: has("powerups2"),
      supportsPowerups3: has("powerups3"),
      supportsPowerups4: has("powerups4"),
      supportsPowerups5: has("powerups5"),
    };
    if (filterByCapabilities) {
      try {
        const [activeShopRows, balanceSnapshot] = await Promise.all([
          powerupShopItemModel.findActive({ channel }),
          powerupBalanceConfig.getAvailabilitySnapshot(),
        ]);
        if (
          balanceSnapshot?.authoritative !== true ||
          !balanceSnapshot.config ||
          typeof balanceSnapshot.config !== "object"
        ) {
          throw new Error("Powerup balance availability is not authoritative");
        }
        shopTypes = new Set(
          (activeShopRows || []).map((row) => row.powerupType)
        );
        rollTypes = canonicalRollAvailabilityForClient({
          config: balanceSnapshot.config,
          clientCapabilities,
        });
        availabilityKnown = true;
      } catch {
        // Fail open: copy remains complete and no availability claim is made.
      }
    }

    let newest = null;
    for (const row of rows) {
      const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
      if (!updatedAt || Number.isNaN(updatedAt.getTime())) continue;
      if (!newest || updatedAt > newest) newest = updatedAt;
    }

    return {
      version: newest ? newest.toISOString() : null,
      stackingVersion: STACKING_VERSION,
      availabilityVersion: availabilityKnown ? 2 : undefined,
      powerups: [...rows]
        .filter((row) => filterByCapabilities
          ? row.powerupType !== "IMPOSTER" &&
            isPowerupVisibleToClient(row.powerupType, clientCapabilities) &&
            (!availabilityKnown ||
              shopTypes.has(row.powerupType) ||
              rollTypes.has(row.powerupType))
          // Preserve the original direct-call contract used by older internal
          // consumers: only Quicksand was request-capability filtered.
          : row.powerupType !== "QUICKSAND" || has("powerups4"))
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
        stacking: POWERUP_STACKING_GUIDE[row.powerupType] || null,
        ...(availabilityKnown
          ? {
              availability: {
                shop: shopTypes.has(row.powerupType),
                roll: rollTypes.has(row.powerupType),
              },
            }
          : {}),
      };
      }),
    };
  }

  // C1 (spec §5 Phase B). The whole assembled payload is cached because it is
  // fully determined by (rows, release channel, capability tokens) — there is
  // nothing per-user in it (the endpoint is unauthenticated). The key carries
  // every shaping input so neither TestFlight shop rows nor newer enum copy can
  // leak to a frozen production binary.
  return async function getPowerupCopyCatalog(
    clientFeatures = null,
    releaseChannel = "prod"
  ) {
    // Direct legacy consumers historically passed no Set (or a plain options
    // object) and received the whole copy table. Preserve that internal
    // contract; real HTTP requests always provide a request-scoped Set and get
    // guide-specific capability filtering.
    const has = (token) =>
      clientFeatures && typeof clientFeatures.has === "function"
        ? clientFeatures.has(token)
        : Array.isArray(clientFeatures) && clientFeatures.includes(token);
    // The complete visibility filter belongs to the guide capability. Frozen
    // catalog consumers retain their historical shape (only Quicksand gated),
    // while the guide never receives a type the requesting binary cannot draw.
    const filterByCapabilities = has("powerup_stacking_guide_v1");

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
        channel: releaseChannel,
        signalJammer: has("jammer"),
        powerups2: has("powerups2"),
        powerups3: has("powerups3"),
        powerups4: has("powerups4"),
        powerups5: has("powerups5"),
        hitchhikeEffectiveSteps: has("hitchhike_effective_steps"),
        stackingGuide: has("powerup_stacking_guide_v1"),
      }),
      prefix: cacheKeys.PREFIX.POWERUP_CATALOG,
      ttlSeconds: CATALOG_TTL_SECONDS,
      enabled,
      load: () => assemble(has, {
        filterByCapabilities,
        channel: releaseChannel === "testflight" ? "testflight" : "prod",
      }),
    });
  };
}

const getPowerupCopyCatalog = buildGetPowerupCopyCatalog();

module.exports = { buildGetPowerupCopyCatalog, getPowerupCopyCatalog };
