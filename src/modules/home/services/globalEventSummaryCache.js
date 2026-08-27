const { performance } = require("node:perf_hooks");
const redisCache = require("../../../shared/cache/redisCache");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

function decorate(summary, validForMs) {
  if (!summary) return null;
  const lifetime = Math.floor(Number(validForMs));
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) return null;
  const { remainingMsAtLoad: _ignored, validForMs: _old, ...immutable } = summary;
  return { ...immutable, validForMs: lifetime };
}

async function getCachedGlobalEventSummary({ key, enabled, load }) {
  const bypassed = derivedCache.isBypassed(cacheKeys.PREFIX.HOME_IMPACT_SUMMARY);
  if (enabled && redisCache.isEnabled() && !bypassed) {
    const hit = await redisCache.getJSONWithPttl(key);
    if (hit?.value && hit.pttlMs > 0) return decorate(hit.value, hit.pttlMs);
  }

  const started = performance.now();
  const fresh = await load();
  if (!fresh) return null;
  const remaining = Number(fresh.validForMs ?? fresh.remainingMsAtLoad);
  const adjustedRemainingMs = Math.floor(remaining - (performance.now() - started));
  const response = decorate(fresh, adjustedRemainingMs);
  if (!response) return null;
  if (enabled && redisCache.isEnabled() &&
      !derivedCache.isBypassed(cacheKeys.PREFIX.HOME_IMPACT_SUMMARY) &&
      adjustedRemainingMs >= 1000) {
    const { validForMs: _validForMs, ...immutable } = response;
    const ttlMs = Math.floor(adjustedRemainingMs / 1000) * 1000;
    if (ttlMs > 0) await redisCache.setJSONWithTtlMs(key, immutable, ttlMs);
  }
  return response;
}

module.exports = { getCachedGlobalEventSummary, decorate };
