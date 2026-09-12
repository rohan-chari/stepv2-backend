const { createHash } = require("node:crypto");
const { coordinatedOptimizationMetrics } = require("../../../shared/observability/coordinatedOptimizationMetrics");
const DAY_MS = 86400000;
const MAX_PROOF_DAYS = 1024;
const MAX_WINDOW_DAYS = 32;

// Content-addressed memoization of the existing sample-window sum. Day buckets
// identify dependencies only: they NEVER split or round the scoring window.
function createHistoricalScoringWindowCache({ maxEntries = 50_000, ttlMs = 10 * 60_000, now = Date.now, metrics = null } = {}) {
  const entries = new Map();
  let proofs = new WeakMap();
  let hits = 0, misses = 0;
  function proofFor(timeline) {
    const cached = proofs.get(timeline);
    if (cached && cached.revision === timeline.revision) return cached.days;
    const days = new Map();
    let supported = true;
    timeline.forEach((start, end, steps) => {
      if (!supported || !(end > start)) return;
      const first = Math.floor(start / DAY_MS), last = Math.floor((end - 1) / DAY_MS);
      if (!Number.isFinite(first) || !Number.isFinite(last) || last - first >= MAX_WINDOW_DAYS) {
        supported = false; return;
      }
      const evidence = `${start},${end},${steps};`;
      for (let day = first; day <= last; day++) {
        if (!days.has(day)) days.set(day, { hash: createHash("sha256"), maxEnd: -Infinity });
        const row = days.get(day);
        row.hash.update(evidence);
        row.maxEnd = Math.max(row.maxEnd, end);
        if (days.size > MAX_PROOF_DAYS) { supported = false; return; }
      }
    });
    if (supported) for (const row of days.values()) {
      row.digest = row.hash.digest("hex");
      delete row.hash;
    }
    const result = supported ? days : null;
    proofs.set(timeline, { revision: timeline.revision, days: result });
    return result;
  }
  return {
    sum({ userId, timeline, startMs, endMs, closedAtMs = null, historicalBeforeMs, compute }) {
      if (timeline?.isPaged || typeof timeline?.forEach !== "function" ||
          !Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs) ||
          !Number.isFinite(historicalBeforeMs) || endMs > historicalBeforeMs ||
          (closedAtMs != null && !Number.isFinite(closedAtMs))) return compute();
      const first = Math.floor(startMs / DAY_MS), last = Math.floor((endMs - 1) / DAY_MS);
      if (last - first >= MAX_WINDOW_DAYS) return compute();
      const days = proofFor(timeline);
      if (!days) return compute();
      const evidence = [];
      for (let day = first; day <= last; day++) {
        const row = days.get(day);
        // Closed eligibility can change merely as time passes. Until every
        // overlapping bucket is closed, retain the canonical calculation.
        if (closedAtMs != null && row?.maxEnd > closedAtMs) return compute();
        evidence.push(row?.digest || "empty");
      }
      const content = createHash("sha256").update(evidence.join(":")).digest("hex");
      const key = JSON.stringify([1, userId, startMs, endMs, closedAtMs == null ? "open" : "closed", content]);
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) {
        entries.delete(key); entries.set(key, entry);
        hits++;
        metrics?.increment("race_scoring_historical_window_cache_total", { outcome: "hit" });
        return entry.value;
      }
      if (entry) entries.delete(key);
      misses++;
      metrics?.increment("race_scoring_historical_window_cache_total", { outcome: "miss" });
      const value = compute();
      // Only in-memory synchronous timelines are memoized. Paged/asynchronous
      // implementations keep their original bounded execution path.
      if (!Number.isFinite(value)) return value;
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
    snapshot() { return { entries: entries.size, hits, misses }; },
    clear() { entries.clear(); proofs = new WeakMap(); hits = 0; misses = 0; },
  };
}
const processHistoricalScoringWindowCache = createHistoricalScoringWindowCache({ metrics: coordinatedOptimizationMetrics });
// Aggregate-only heartbeat makes cache use observable in each live process.
// No user/race identifiers, SQL writes or extra database reads are emitted.
const telemetryTimer = setInterval(() => {
  console.info(JSON.stringify({ event: "historical_scoring_window_cache", pid: process.pid,
    ...processHistoricalScoringWindowCache.snapshot() }));
}, 60_000);
telemetryTimer.unref();
module.exports = { createHistoricalScoringWindowCache, processHistoricalScoringWindowCache };
