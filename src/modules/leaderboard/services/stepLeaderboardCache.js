const redisCacheDefault = require("../../../shared/cache/redisCache");
const cacheKeysDefault = require("../../../shared/cache/cacheKeys");

const SOFT_MS = 15_000;
const HARD_MS = 60_000;
const singleFlights = new Map();

function validRow(row) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    Object.keys(row).sort().join(",") === "rank,totalSteps,userId" &&
    typeof row.userId === "string" && Number.isSafeInteger(row.rank) && row.rank > 0 &&
    Number.isFinite(row.totalSteps) && row.totalSteps >= 0;
}

function validCore(core, expected) {
  if (!core || typeof core !== "object" || Array.isArray(core)) return false;
  const allowed = expected.scope === "friends"
    ? ["asOf", "boundary", "buildStartedAt", "currentUser", "period", "rows", "scope", "version"]
    : ["asOf", "boundary", "buildStartedAt", "period", "rows", "scope", "version"];
  if (Object.keys(core).sort().join(",") !== allowed.sort().join(",")) return false;
  if (core.version !== 1 || core.scope !== expected.scope || core.period !== expected.period || core.boundary !== expected.boundary) return false;
  const asOf = Date.parse(core.asOf);
  const started = Date.parse(core.buildStartedAt);
  if (!Number.isFinite(asOf) || !Number.isFinite(started) || !Array.isArray(core.rows)) return false;
  if (core.rows.length > 100 || !core.rows.every(validRow)) return false;
  if (new Set(core.rows.map((row) => row.userId)).size !== core.rows.length) return false;
  if (expected.scope === "friends") {
    const current = core.currentUser;
    if (!current || Object.keys(current).sort().join(",") !== "rank,totalSteps" ||
        !Number.isSafeInteger(current.rank) || current.rank <= 0 ||
        !Number.isFinite(current.totalSteps) || current.totalSteps < 0) return false;
  }
  return true;
}

function buildStepLeaderboardCache(dependencies = {}) {
  const redisCache = dependencies.redisCache || redisCacheDefault;
  const cacheKeys = dependencies.cacheKeys || cacheKeysDefault;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const waitMs = Math.max(250, Math.min(5000, Number(dependencies.waitMs ?? process.env.LEADERBOARD_CACHE_WAIT_MS ?? 500)));
  const lockMs = Math.max(10_000, Number(dependencies.lockMs ?? process.env.LEADERBOARD_CACHE_LOCK_MS ?? 10_000));

  async function read(key, expected) {
    const core = await redisCache.getJSON(key);
    if (!validCore(core, expected)) return null;
    const age = now().getTime() - Date.parse(core.asOf);
    if (age < 0 || age >= HARD_MS) return null;
    return { core, stale: age >= SOFT_MS };
  }

  async function publish(key, core, expected) {
    if (!validCore(core, expected)) return false;
    const remainingMs = Date.parse(core.asOf) + HARD_MS - now().getTime();
    if (remainingMs <= 0) return false;
    const result = await redisCache.withWatch([key], async (ctx) => {
      const existing = await ctx.get(key);
      if (validCore(existing, expected) &&
          Date.parse(existing.buildStartedAt) >= Date.parse(core.buildStartedAt)) {
        return null;
      }
      return { sets: [{ key, value: core, ttlMs: remainingMs }] };
    });
    return result.installed;
  }

  function rebuild(key, expected, load) {
    if (singleFlights.has(key)) return singleFlights.get(key);
    const work = async () => {
      const core = await load();
      const stillFresh = validCore(core, expected) &&
        now().getTime() < Date.parse(core.asOf) + HARD_MS;
      if (!stillFresh) return null;
      await publish(key, core, expected);
      return core;
    };
    const promise = (async () => {
      if (typeof redisCache.withLockStatus === "function") {
        return redisCache.withLockStatus(cacheKeys.leaderboardLock(key), lockMs, work);
      }
      const value = await redisCache.withLock(cacheKeys.leaderboardLock(key), lockMs, work);
      return { status: value == null ? "contended" : "acquired", value };
    })().finally(() => singleFlights.delete(key));
    singleFlights.set(key, promise);
    return promise;
  }

  function rebuildSafe({ key, scope, period, boundary, load }) {
    const expected = { scope, period, boundary };
    rebuild(key, expected, load).catch((error) =>
      logger.warn?.("leaderboard cache rebuild failed", { message: error?.message })
    );
  }

  async function getOrLoad({ key, scope, period, boundary, load }) {
    const expected = { scope, period, boundary };
    const started = Date.now();
    const hit = await read(key, expected);
    if (hit && !hit.stale) {
      logger.info?.("social-cache", { surface: "leaderboard", outcome: "hit/fresh", durationMs: Date.now() - started });
      return hit.core;
    }
    if (hit?.stale) {
      rebuild(key, expected, load).catch((error) => logger.warn?.("leaderboard cache rebuild failed", { message: error?.message }));
      logger.info?.("social-cache", { surface: "leaderboard", outcome: "hit/stale", durationMs: Date.now() - started });
      return hit.core;
    }

    const built = await rebuild(key, expected, load);
    if (built.status === "acquired" && built.value) return built.value;
    // Only a healthy Redis NX miss means another worker may publish shortly.
    // Disabled/error Redis and an exhausted loader fall straight through to
    // the complete Postgres path instead of imposing the contention budget.
    if (built.status !== "contended") return null;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      const appeared = await read(key, expected);
      if (appeared) return appeared.core;
    }
    logger.info?.("social-cache", { surface: "leaderboard", outcome: "miss", durationMs: Date.now() - started });
    return null;
  }

  return { getOrLoad, read, publish, rebuildSafe };
}

const service = buildStepLeaderboardCache();
module.exports = { ...service, buildStepLeaderboardCache, validCore, SOFT_MS, HARD_MS };
