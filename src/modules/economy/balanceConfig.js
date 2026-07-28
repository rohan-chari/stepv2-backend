const { prisma: defaultPrisma } = require("../../db");
const {
  BALANCE_POWERUP_TYPES,
  RARITIES,
  ACCESSORY_WEIGHT_MODES,
  SCHEMA_VERSION,
  SOFT_BOUNDS,
  defaultConfig,
  deepClone,
} = require("./balanceConfig.defaults");

// Read-through cache over the active `balance_config` row.
//
// TTL is 5 SECONDS, and that number is load-bearing (D9). The backend runs under
// pm2 CLUSTER mode: every worker holds its own cache, so `bustCache()` only
// affects the process that served the admin write. The TTL is what bounds the
// window in which two workers can roll from different configs. Per-roll querying
// (zero skew) was rejected — the DB has hit max_connections before — and so was
// a LISTEN/NOTIFY listener per worker, for the same reason.
//
// What the TTL buys is a BOUND, not prevention. Odds shown at time T and a box
// opened at T+n can legitimately use different versions. That is why every roll
// is stamped with `configVersion`: you can always answer "which config produced
// this box?" after the fact. See §3.1 — auditability, not prevention.
const CACHE_TTL_MS = 5_000;

class BalanceConfigError extends Error {
  constructor(message, statusCode, payload = {}) {
    super(message);
    this.name = "BalanceConfigError";
    this.statusCode = statusCode;
    Object.assign(this, payload);
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// Merge a stored config over the code defaults. Plain objects merge recursively
// so a partial/older stored config still resolves every key; arrays are replaced
// wholesale (a drop pool is a value, not something to union).
function mergeOverDefaults(stored) {
  function merge(base, override) {
    if (!isPlainObject(override)) return override === undefined ? base : override;
    if (!isPlainObject(base)) return deepClone(override);
    const out = deepClone(base);
    for (const [key, value] of Object.entries(override)) {
      out[key] = key in base ? merge(base[key], value) : deepClone(value);
    }
    return out;
  }
  return enforceStoreOnlyExclusion(
    merge(defaultConfig(), isPlainObject(stored) ? stored : {})
  );
}

// `storeOnlyTypes` is THE drop-exclusion authority (defaults §D13), and
// validateConfig rejects any SAVE that lists a type in both it and a dropPool
// tier. But a config saved BEFORE a type became store-only keeps that type in
// its stored dropPool, and the stored row wins over the code defaults — so
// moving a powerup to store-only in code would silently do nothing in prod until
// an admin re-saved the config by hand.
//
// Resolving the exclusion here, at the one place a stored config becomes a
// runtime config, makes the deploy alone sufficient: the roller, the odds sheet,
// the docs generator and the RARITY_TIERS view all read through this. It only
// ever REMOVES a type the config itself already declares undroppable.
//
// The exclusion is applied from the stored list AND the code defaults' list.
// `config.storeOnlyTypes` itself is left exactly as stored (arrays still replace
// wholesale — that invariant is unchanged); only the drop pool is filtered.
// "This type is not obtainable from a box" is a product decision that ships with
// the binary, and a stored list written before the decision existed must not be
// able to un-make it. Filtering is always safe: making a store-only type
// droppable again requires editing dropPool AND the defaults, which is a code
// change either way.
function enforceStoreOnlyExclusion(config) {
  const storeOnly = new Set([
    ...(Array.isArray(config?.storeOnlyTypes) ? config.storeOnlyTypes : []),
    ...defaultConfig().storeOnlyTypes,
  ]);
  if (storeOnly.size === 0 || !isPlainObject(config.dropPool)) {
    return config;
  }
  for (const [rarity, pool] of Object.entries(config.dropPool)) {
    if (!Array.isArray(pool)) continue;
    const filtered = pool.filter((type) => !storeOnly.has(type));
    if (filtered.length !== pool.length) config.dropPool[rarity] = filtered;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Hard validation (§5.2) — structural. ALWAYS rejects; never overridable.
// ---------------------------------------------------------------------------

function isNonNegNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function sumsToOne(row) {
  return Math.abs(row.reduce((a, b) => a + b, 0) - 1) <= 0.001;
}

function validateOddsRow(errors, path, row) {
  if (!Array.isArray(row) || row.length !== 3) {
    errors.push({ path, message: `${path} must be 3 numbers` });
    return;
  }
  if (!row.every(isNonNegNumber)) {
    errors.push({ path, message: `${path} entries must be non-negative numbers` });
    return;
  }
  if (!sumsToOne(row)) {
    errors.push({
      path,
      message: `${path} must sum to 1.0 (± 0.001), got ${row.reduce((a, b) => a + b, 0)}`,
    });
  }
}

function validateConfig(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return [{ path: "config", message: "config must be an object" }];
  }

  if (input.schemaVersion !== SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      message: `unrecognised schemaVersion ${input.schemaVersion}; expected ${SCHEMA_VERSION}`,
    });
  }

  // rarityByType must cover every balance-carrying PowerupType.
  const rarityByType = input.rarityByType;
  if (!isPlainObject(rarityByType)) {
    errors.push({ path: "rarityByType", message: "rarityByType must be an object" });
  } else {
    for (const type of BALANCE_POWERUP_TYPES) {
      if (!rarityByType[type]) {
        errors.push({
          path: `rarityByType.${type}`,
          message: `rarityByType is missing ${type}`,
        });
      }
    }
    for (const [type, rarity] of Object.entries(rarityByType)) {
      if (!BALANCE_POWERUP_TYPES.includes(type)) {
        errors.push({
          path: `rarityByType.${type}`,
          message: `${type} is not a valid PowerupType`,
        });
      } else if (!RARITIES.includes(rarity)) {
        errors.push({
          path: `rarityByType.${type}`,
          message: `${rarity} is not a valid rarity`,
        });
      }
    }
  }

  const storeOnly = Array.isArray(input.storeOnlyTypes) ? input.storeOnlyTypes : null;
  if (!storeOnly) {
    errors.push({ path: "storeOnlyTypes", message: "storeOnlyTypes must be an array" });
  } else {
    for (const type of storeOnly) {
      if (!BALANCE_POWERUP_TYPES.includes(type)) {
        errors.push({
          path: "storeOnlyTypes",
          message: `${type} is not a valid PowerupType`,
        });
      }
    }
  }

  // teamOnlyTypes (2026-07-26): droppable, but only in a team race. OPTIONAL —
  // a config stored before this key existed simply has none and resolves to the
  // code default through mergeOverDefaults, so `undefined` must stay valid.
  //
  // The contradiction rule is the important one: store-only means "an in-race
  // box can NEVER roll this", team-only means "an in-race box CAN roll this, in
  // a team race". A type in both lists has no coherent meaning and silently
  // letting it through would make the intent of a later edit unrecoverable.
  let teamOnly = null;
  if (input.teamOnlyTypes !== undefined) {
    if (!Array.isArray(input.teamOnlyTypes)) {
      errors.push({ path: "teamOnlyTypes", message: "teamOnlyTypes must be an array" });
    } else {
      teamOnly = input.teamOnlyTypes;
      for (const type of teamOnly) {
        if (!BALANCE_POWERUP_TYPES.includes(type)) {
          errors.push({
            path: "teamOnlyTypes",
            message: `${type} is not a valid PowerupType`,
          });
        } else if (storeOnly && storeOnly.includes(type)) {
          errors.push({
            path: "teamOnlyTypes",
            message: `${type} is both team-only and store-only; a type cannot be undroppable and conditionally droppable at once`,
          });
        }
      }
    }
  }

  // `dailyBoxExcludedTypes` REMOVED 2026-07-28: the daily-spin prize pool is
  // now the shop catalog as the client sees it (see getEligiblePowerupPool),
  // so there is no spin-exclusion list to validate. A stored config that still
  // carries the key is simply ignored — nothing reads it anymore.

  // Drop pool: valid type, has a rarity, and is NOT store-only.
  if (!isPlainObject(input.dropPool)) {
    errors.push({ path: "dropPool", message: "dropPool must be an object" });
  } else {
    for (const rarity of RARITIES) {
      const pool = input.dropPool[rarity];
      if (!Array.isArray(pool)) {
        errors.push({
          path: `dropPool.${rarity}`,
          message: `dropPool.${rarity} must be an array`,
        });
        continue;
      }
      for (const type of pool) {
        if (!BALANCE_POWERUP_TYPES.includes(type)) {
          errors.push({
            path: `dropPool.${rarity}`,
            message: `${type} is not a valid PowerupType`,
          });
          continue;
        }
        if (isPlainObject(rarityByType) && !rarityByType[type]) {
          errors.push({
            path: `dropPool.${rarity}`,
            message: `${type} is in the drop pool but has no rarity`,
          });
        }
        if (storeOnly && storeOnly.includes(type)) {
          errors.push({
            path: `dropPool.${rarity}`,
            message: `${type} is store-only and must not be droppable`,
          });
        }
      }
    }
  }

  // Position odds + daily-box odds rows.
  if (!isPlainObject(input.positionOdds)) {
    errors.push({ path: "positionOdds", message: "positionOdds must be an object" });
  } else {
    validateOddsRow(errors, "positionOdds.first", input.positionOdds.first);
    validateOddsRow(errors, "positionOdds.last", input.positionOdds.last);
  }

  // typeWeights: non-negative finite numbers on valid types.
  if (input.typeWeights !== undefined) {
    if (!isPlainObject(input.typeWeights)) {
      errors.push({ path: "typeWeights", message: "typeWeights must be an object" });
    } else {
      for (const [type, weight] of Object.entries(input.typeWeights)) {
        if (!BALANCE_POWERUP_TYPES.includes(type)) {
          errors.push({
            path: `typeWeights.${type}`,
            message: `${type} is not a valid PowerupType`,
          });
        }
        if (!isNonNegNumber(weight)) {
          errors.push({
            path: `typeWeights.${type}`,
            message: `typeWeights.${type} must be a non-negative number`,
          });
        }
      }
    }
  }

  // positionRules: per-position drop filtering. Optional (a config stored before
  // the feature existed simply has none and resolves to the code default), but
  // validated strictly when present.
  //
  // The overlap rule is the important one: a type listed in more than one of the
  // four lists is a config-authoring error, not a meaningful combination. "Hard
  // exclude it AND down-weight it" has no coherent meaning, and silently letting
  // it through would make the intent of a later edit unrecoverable.
  if (input.positionRules !== undefined) {
    const rules = input.positionRules;
    if (!isPlainObject(rules)) {
      errors.push({ path: "positionRules", message: "positionRules must be an object" });
    } else {
      const seen = new Map(); // type -> list name

      const claim = (type, listName) => {
        const previous = seen.get(type);
        if (previous && previous !== listName) {
          errors.push({
            path: `positionRules.${listName}`,
            message: `${type} appears in both ${previous} and ${listName}; a type may be in at most one positionRules list`,
          });
          return;
        }
        seen.set(type, listName);
      };

      for (const listName of ["leaderExcluded", "lastPlaceExcluded"]) {
        const list = rules[listName];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          errors.push({
            path: `positionRules.${listName}`,
            message: `positionRules.${listName} must be an array`,
          });
          continue;
        }
        for (const type of list) {
          if (!BALANCE_POWERUP_TYPES.includes(type)) {
            errors.push({
              path: `positionRules.${listName}`,
              message: `${type} is not a valid PowerupType`,
            });
            continue;
          }
          claim(type, listName);
        }
      }

      for (const listName of ["leadingDownweight", "trailingDownweight"]) {
        const map = rules[listName];
        if (map === undefined) continue;
        if (!isPlainObject(map)) {
          errors.push({
            path: `positionRules.${listName}`,
            message: `positionRules.${listName} must be an object`,
          });
          continue;
        }
        for (const [type, multiplier] of Object.entries(map)) {
          if (!BALANCE_POWERUP_TYPES.includes(type)) {
            errors.push({
              path: `positionRules.${listName}`,
              message: `${type} is not a valid PowerupType`,
            });
            continue;
          }
          if (!isNonNegNumber(multiplier)) {
            errors.push({
              path: `positionRules.${listName}.${type}`,
              message: `positionRules.${listName}.${type} must be a non-negative number`,
            });
          }
          claim(type, listName);
        }
      }

      for (const key of ["leadingDownweightFrom", "trailingDownweightFrom"]) {
        const value = rules[key];
        if (value === undefined) continue;
        if (!isNonNegNumber(value) || value > 1) {
          errors.push({
            path: `positionRules.${key}`,
            message: `positionRules.${key} must be within [0,1]`,
          });
        }
      }
    }
  }

  // Upgrade ladders: exactly 4, non-negative, [0] === 0, non-decreasing.
  const byRarity = input.upgradeCosts?.byRarity;
  if (!isPlainObject(input.upgradeCosts) || !isPlainObject(byRarity)) {
    errors.push({
      path: "upgradeCosts.byRarity",
      message: "upgradeCosts.byRarity must be an object",
    });
  } else {
    for (const rarity of RARITIES) {
      const path = `upgradeCosts.byRarity.${rarity}`;
      const ladder = byRarity[rarity];
      if (!Array.isArray(ladder) || ladder.length !== 4) {
        errors.push({ path, message: `${path} must have exactly 4 entries` });
        continue;
      }
      if (!ladder.every(isNonNegNumber)) {
        errors.push({ path, message: `${path} entries must be non-negative numbers` });
        continue;
      }
      if (ladder[0] !== 0) {
        errors.push({ path, message: `${path}[0] must be 0 (the base form is free)` });
      }
      for (let i = 1; i < ladder.length; i++) {
        if (ladder[i] < ladder[i - 1]) {
          errors.push({
            path,
            message: `${path} must be monotonically non-decreasing`,
          });
          break;
        }
      }
    }
  }
  if (input.upgradeCosts?.byType !== undefined && !isPlainObject(input.upgradeCosts.byType)) {
    errors.push({
      path: "upgradeCosts.byType",
      message: "upgradeCosts.byType must be an object",
    });
  }

  // upgradeableTypes ⊆ PowerupType, and each has a rarity.
  if (!Array.isArray(input.upgradeableTypes)) {
    errors.push({ path: "upgradeableTypes", message: "upgradeableTypes must be an array" });
  } else {
    for (const type of input.upgradeableTypes) {
      if (!BALANCE_POWERUP_TYPES.includes(type)) {
        errors.push({
          path: "upgradeableTypes",
          message: `${type} is not a valid PowerupType`,
        });
      } else if (isPlainObject(rarityByType) && !rarityByType[type]) {
        errors.push({
          path: "upgradeableTypes",
          message: `${type} is upgradeable but has no rarity`,
        });
      }
    }
  }

  // Lucky Horseshoe ladder: 4 entries in [0,1], non-decreasing, last === 1.0.
  const ladder = input.luckyHorseshoe?.rareChanceByLevel;
  const lhPath = "luckyHorseshoe.rareChanceByLevel";
  if (!Array.isArray(ladder) || ladder.length !== 4) {
    errors.push({ path: lhPath, message: `${lhPath} must have exactly 4 entries` });
  } else if (!ladder.every((v) => isNonNegNumber(v) && v <= 1)) {
    errors.push({ path: lhPath, message: `${lhPath} entries must be within [0,1]` });
  } else {
    for (let i = 1; i < ladder.length; i++) {
      if (ladder[i] < ladder[i - 1]) {
        errors.push({ path: lhPath, message: `${lhPath} must be monotonically non-decreasing` });
        break;
      }
    }
    if (ladder[3] !== 1) {
      errors.push({ path: lhPath, message: `${lhPath}[3] must be exactly 1.0` });
    }
  }

  // Daily box.
  const dailyBox = input.dailyBox;
  if (!isPlainObject(dailyBox)) {
    errors.push({ path: "dailyBox", message: "dailyBox must be an object" });
  } else {
    if (!Number.isInteger(dailyBox.streakCap) || dailyBox.streakCap < 2) {
      errors.push({
        path: "dailyBox.streakCap",
        message: "dailyBox.streakCap must be an integer >= 2",
      });
    }
    if (!isPlainObject(dailyBox.odds)) {
      errors.push({ path: "dailyBox.odds", message: "dailyBox.odds must be an object" });
    } else {
      validateOddsRow(errors, "dailyBox.odds.first", dailyBox.odds.first);
      validateOddsRow(errors, "dailyBox.odds.last", dailyBox.odds.last);
    }
    if (!isPlainObject(dailyBox.coinRanges)) {
      errors.push({
        path: "dailyBox.coinRanges",
        message: "dailyBox.coinRanges must be an object",
      });
    } else {
      for (const [key, range] of Object.entries(dailyBox.coinRanges)) {
        const path = `dailyBox.coinRanges.${key}`;
        if (
          !Array.isArray(range) ||
          range.length !== 2 ||
          !range.every(isNonNegNumber) ||
          range[0] > range[1]
        ) {
          errors.push({ path, message: `${path} must be [min, max] with 0 <= min <= max` });
        }
      }
    }
    if (
      !isNonNegNumber(dailyBox.rareCoinsShare) ||
      dailyBox.rareCoinsShare > 1
    ) {
      errors.push({
        path: "dailyBox.rareCoinsShare",
        message: "dailyBox.rareCoinsShare must be within [0,1]",
      });
    }
    if (!ACCESSORY_WEIGHT_MODES.includes(dailyBox.accessoryWeightMode)) {
      errors.push({
        path: "dailyBox.accessoryWeightMode",
        message: `dailyBox.accessoryWeightMode must be one of ${ACCESSORY_WEIGHT_MODES.join(", ")}`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Soft bounds (D11) — warn + explicit override.
// ---------------------------------------------------------------------------

// Resolve a bound path (with at most one `*` wildcard segment) to concrete
// [path, value] pairs found in the config.
function resolveBoundPaths(config, path) {
  let hits = [{ path: "", value: config }];
  for (const segment of path.split(".")) {
    const next = [];
    for (const hit of hits) {
      if (hit.value == null) continue;
      if (segment === "*") {
        if (Array.isArray(hit.value)) {
          hit.value.forEach((value, i) =>
            next.push({ path: hit.path ? `${hit.path}.${i}` : String(i), value })
          );
        } else if (isPlainObject(hit.value)) {
          for (const [key, value] of Object.entries(hit.value)) {
            next.push({ path: hit.path ? `${hit.path}.${key}` : key, value });
          }
        }
        continue;
      }
      // Odds rows are stored as arrays but named by rarity in the bounds table
      // (e.g. positionOdds.*.RARE), so map a rarity name onto its index.
      const rarityIndex = RARITIES.indexOf(segment);
      if (Array.isArray(hit.value) && rarityIndex !== -1) {
        if (hit.value[rarityIndex] !== undefined) {
          next.push({
            path: hit.path ? `${hit.path}.${segment}` : segment,
            value: hit.value[rarityIndex],
          });
        }
        continue;
      }
      const value = hit.value[segment];
      if (value === undefined) continue;
      next.push({ path: hit.path ? `${hit.path}.${segment}` : segment, value });
    }
    hits = next;
  }
  return hits;
}

function checkSoftBounds(config) {
  const warnings = [];
  for (const bound of SOFT_BOUNDS) {
    for (const hit of resolveBoundPaths(config, bound.path)) {
      const values = Array.isArray(hit.value) ? hit.value : [hit.value];
      const numeric = values.filter((v) => typeof v === "number" && Number.isFinite(v));
      if (numeric.length === 0) continue;
      const outOfRange = numeric.some((v) => v < bound.min || v > bound.max);
      if (!outOfRange) continue;
      warnings.push({
        path: hit.path,
        value: hit.value,
        bound: [bound.min, bound.max],
        message: `${hit.path} is outside the sane range ${bound.min}–${bound.max} (${bound.rationale})`,
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function buildBalanceConfig(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const cacheTtlMs = dependencies.cacheTtlMs ?? CACHE_TTL_MS;

  // Seeded with code defaults so a synchronous consumer is never empty-handed,
  // even before the first successful read.
  let snapshot = { version: null, config: defaultConfig() };
  let cachedAt = 0;

  function bustCache() {
    // Best-effort, LOCAL PROCESS ONLY. Under pm2 cluster mode the other workers
    // keep serving their own cache until their TTL lapses. That is by design and
    // bounded by cacheTtlMs — see the note at the top of this file.
    cachedAt = 0;
  }

  // Never throws (D4). A DB blip must not break box rolls mid-race, so any
  // failure keeps serving the last good snapshot (or code defaults).
  async function getSnapshot() {
    const now = Date.now();
    if (cachedAt && now - cachedAt < cacheTtlMs) return snapshot;
    try {
      const row = await prisma.balanceConfig.findFirst({
        where: { active: true },
        orderBy: { version: "desc" },
      });
      snapshot = row
        ? { version: row.version, config: mergeOverDefaults(row.config) }
        : { version: null, config: defaultConfig() };
      cachedAt = now;
    } catch (error) {
      // Deliberately swallowed. Log once per attempt so an outage is visible in
      // the logs without taking the game down with it.
      console.warn("balanceConfig: falling back to code defaults:", error.message);
      cachedAt = now;
    }
    return snapshot;
  }

  async function getConfig() {
    return (await getSnapshot()).config;
  }

  // Synchronous access to the last-loaded snapshot, for the many hot callers
  // (rollPowerup, upgradeCost, …) whose signatures are synchronous and are
  // called from frozen client paths. Returns code defaults until the first
  // successful async read populates the cache.
  function getSnapshotSync() {
    // If the snapshot is stale, kick off a refresh but do NOT wait for it: this
    // path must stay synchronous. The caller gets the previous value and the
    // next caller gets the fresh one. getSnapshot never throws, so the dangling
    // promise cannot produce an unhandled rejection.
    if (Date.now() - cachedAt >= cacheTtlMs) {
      getSnapshot().catch(() => {});
    }
    return snapshot;
  }

  function getConfigSync() {
    return snapshot.config;
  }

  async function getActiveRow() {
    return prisma.balanceConfig.findFirst({
      where: { active: true },
      orderBy: { version: "desc" },
    });
  }

  async function listVersions(limit = 50) {
    return prisma.balanceConfig.findMany({
      orderBy: { version: "desc" },
      take: Math.max(1, Math.min(limit, 200)),
      select: {
        version: true,
        note: true,
        createdBy: true,
        boundOverride: true,
        createdAt: true,
        active: true,
      },
    });
  }

  // Append a new active version. Throws BalanceConfigError with statusCode
  // 400 (hard validation) / 409 (stale expectedVersion) / 422 (soft bounds).
  async function saveConfig({
    config,
    note = null,
    createdBy = null,
    expectedVersion,
    acknowledgeBoundWarnings = false,
    skipValidation = false,
  }) {
    if (!skipValidation) {
      const errors = validateConfig(config);
      if (errors.length > 0) {
        throw new BalanceConfigError("invalid_config", 400, {
          error: "invalid_config",
          errors,
        });
      }
    }

    const warnings = checkSoftBounds(config);
    if (warnings.length > 0 && !acknowledgeBoundWarnings) {
      throw new BalanceConfigError("bound_warnings", 422, {
        error: "bound_warnings",
        warnings,
      });
    }

    const boundOverride = warnings.length > 0;

    try {
      return await prisma.$transaction(async (tx) => {
        // Row lock on the newest version. This is the SECOND line of defence:
        // expectedVersion catches a stale-READ overwrite, this lock catches two
        // writers racing at the same instant. (An empty table has no row to
        // lock; that race resolves on the unique(version) constraint below.)
        const locked = await tx.$queryRawUnsafe(
          `SELECT version FROM balance_config ORDER BY version DESC LIMIT 1 FOR UPDATE`
        );
        const currentVersion = locked.length > 0 ? Number(locked[0].version) : null;

        const activeRow = await tx.balanceConfig.findFirst({
          where: { active: true },
          orderBy: { version: "desc" },
        });
        const activeVersion = activeRow ? activeRow.version : null;

        if (expectedVersion !== undefined && expectedVersion !== activeVersion) {
          throw new BalanceConfigError("stale_version", 409, {
            error: "stale_version",
            currentVersion: activeVersion,
            config: activeRow ? mergeOverDefaults(activeRow.config) : defaultConfig(),
          });
        }

        const nextVersion = (currentVersion ?? 0) + 1;

        await tx.balanceConfig.updateMany({
          where: { active: true },
          data: { active: false },
        });

        return tx.balanceConfig.create({
          data: {
            version: nextVersion,
            config,
            note,
            createdBy,
            boundOverride,
            active: true,
          },
        });
      });
    } catch (error) {
      // Two writers inserting the same version against an EMPTY table (no row to
      // lock). Surface it as the stale-version conflict it effectively is rather
      // than a 500 — the loser re-reads and retries, same as any other 409.
      if (error.code === "P2002") {
        const active = await getActiveRow();
        throw new BalanceConfigError("stale_version", 409, {
          error: "stale_version",
          currentVersion: active ? active.version : null,
          config: active ? mergeOverDefaults(active.config) : defaultConfig(),
        });
      }
      throw error;
    } finally {
      bustCache();
    }
  }

  // Rollback copies an old version's config FORWARD into a new version. History
  // is never rewritten or deleted — the point of an append-only table.
  async function rollbackTo({ version, expectedVersion, createdBy = null }) {
    const target = await prisma.balanceConfig.findUnique({ where: { version } });
    if (!target) {
      throw new BalanceConfigError("version_not_found", 404, {
        error: "version_not_found",
      });
    }
    return saveConfig({
      config: target.config,
      note: `rollback to v${version}`,
      createdBy,
      expectedVersion,
      // A historical version may sit outside today's bounds (that is a large
      // part of why you are rolling back). Rollback restores a config that was
      // already reviewed and accepted once, so it is not re-gated on the ack.
      acknowledgeBoundWarnings: true,
      // Likewise, do not hard-reject a config the schema has since tightened —
      // it was valid when it was saved and reproducing it is the whole point.
      skipValidation: true,
    });
  }

  // Insert version 1 if the table is empty. Idempotent; safe to call on boot.
  async function ensureSeeded() {
    const existing = await prisma.balanceConfig.findFirst();
    if (existing) return existing;
    try {
      return await saveConfig({
        config: defaultConfig(),
        note: "seed: code defaults (SHORTCUT=RARE, accessoryWeightMode=inverse)",
        createdBy: null,
      });
    } catch (error) {
      if (error.code === "P2002" || error.statusCode === 409) {
        return prisma.balanceConfig.findFirst({ where: { active: true } });
      }
      throw error;
    }
  }

  return {
    getConfig,
    getConfigSync,
    getSnapshot,
    getSnapshotSync,
    getActiveRow,
    listVersions,
    saveConfig,
    rollbackTo,
    ensureSeeded,
    bustCache,
    validateConfig,
    checkSoftBounds,
    mergeOverDefaults,
  };
}

const balanceConfig = buildBalanceConfig();

module.exports = {
  buildBalanceConfig,
  balanceConfig,
  BalanceConfigError,
  validateConfig,
  checkSoftBounds,
  mergeOverDefaults,
  CACHE_TTL_MS,
};
