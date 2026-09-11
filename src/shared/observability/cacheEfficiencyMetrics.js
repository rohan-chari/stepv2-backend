const { coordinatedOptimizationMetrics: metrics } = require("./coordinatedOptimizationMetrics");
const SURFACES = new Set(["list", "equipment", "friends", "summary", "invites", "milestones", "race-meta", "race-members", "slots", "event", "standings", "writer"]);
SURFACES.add('race-viewer-links');
SURFACES.add('race-viewer-state');
for (const surface of ['core','participant','summary','effects','preview','used-types','roster']) SURFACES.add(`race-open-${surface}`);
const OUTCOMES = new Set(["hit", "missing", "generation", "timezone", "boundary", "expired", "malformed", "error", "bypass", "installed", "lost-fill", "fallback"]);
function read(kind, outcome) {
  if (!SURFACES.has(kind) || !OUTCOMES.has(outcome)) throw new TypeError("Unbounded cache efficiency metric label");
  metrics.increment("cache_efficiency_read_total", { kind, outcome });
}
function count(kind, name, amount = 1) {
  if (!SURFACES.has(kind) || !["source_loads", "redis", "bytes", "invalidations"].includes(name)) throw new TypeError("Invalid cache efficiency counter");
  metrics.increment(`cache_efficiency_${name}_total`, { kind }, amount);
}
function age(kind, milliseconds) {
  if (!SURFACES.has(kind)) throw new TypeError("Invalid cache efficiency surface");
  const outcome = milliseconds <= 15000 ? "0-15" : milliseconds <= 30000 ? "15-30" : milliseconds <= 60000 ? "30-60" : "60-plus";
  metrics.increment("cache_efficiency_age_total", { kind, outcome });
}
function standingsHit(asOf, nowMs = Date.now(), counterfactual = false) {
  const milliseconds = nowMs - Date.parse(asOf);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
  read("standings", "hit");
  age("standings", milliseconds);
  if (counterfactual && milliseconds > 15000 && milliseconds <= 30000) {
    metrics.increment("cache_efficiency_counterfactual_total", { kind: "standings", outcome: "15-30" });
  }
}
module.exports = { read, count, age, standingsHit };
