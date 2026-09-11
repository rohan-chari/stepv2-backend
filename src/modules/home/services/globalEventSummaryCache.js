const { performance } = require("node:perf_hooks");
const redisCache = require("../../../shared/cache/redisCache");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");
const { readFragment } = require("../../../shared/cache/cacheEfficiencyRead");
function decorate(summary, validForMs) {
  if (!summary) return null;
  const lifetime = Math.floor(Number(validForMs));
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) return null;
  const { remainingMsAtLoad: _ignored, validForMs: _old, ...immutable } = summary;
  return { ...immutable, validForMs: lifetime };
}
const FIELDS = new Set(["id", "eventId", "extraRaceSteps", "raceCount", "settledAt", "expiresAt"]);
function valid(value) {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "empty") return Object.keys(value).length === 1;
  if (value.kind !== "positive" || Object.keys(value).sort().join(",") !== "kind,summary") return false;
  const row = value.summary;
  return row && Object.keys(row).every((field) => FIELDS.has(field)) &&
    typeof row.id === "string" && typeof row.eventId === "string" &&
    Number.isInteger(row.extraRaceSteps) && row.extraRaceSteps > 0 && Number.isInteger(row.raceCount) &&
    Number.isFinite(new Date(row.expiresAt).getTime());
}
async function getCachedGlobalEventSummary({ key, userId = null, enabled, load }) {
  const bypassed = derivedCache.isBypassed(cacheKeys.PREFIX.HOME_IMPACT_SUMMARY);
  if (!enabled || !redisCache.isEnabled() || bypassed) {
    const started = performance.now();
    const fresh = await load();
    return fresh ? decorate(fresh, Number(fresh.validForMs ?? fresh.remainingMsAtLoad) - (performance.now() - started)) : null;
  }
  // Explicit user identity is passed by both callers; the legacy key fallback
  // is retained only for the old injected helper contract.
  if (!userId) return legacySummaryRead({ key, enabled, load });
  let remaining = 0;
  const result = await readFragment({
    kind: "summary", key: `ce:v2:summary:${userId}`,
    markers: [{ domain: "summary", identity: userId }],
    ttlMs: (value) => value.kind === "empty" ? 15000 : remaining,
    validate: valid,
    // Retain the positive-key repair/old-reader contract. Both copies are
    // installed under one generation comparison, so invalidation wins.
    companion: { key, required: value => value.kind === "positive",
      value: value => value.kind === "positive" ? value.summary : null },
    load: async () => {
      const fresh = await load();
      if (!fresh) return { kind: "empty" };
      remaining = Number(fresh.validForMs ?? fresh.remainingMsAtLoad);
      const { validForMs, remainingMsAtLoad, ...summary } = fresh;
      return { kind: "positive", summary };
    },
  });
  if (result.value.kind === "empty") return null;
  return decorate(result.value.summary, result.remainingMs);
}
async function legacySummaryRead({ key, enabled, load }) {
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
