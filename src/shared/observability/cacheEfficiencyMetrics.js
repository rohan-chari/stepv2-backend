const { coordinatedOptimizationMetrics: metrics } = require("./coordinatedOptimizationMetrics");
const SURFACES = new Set(["list", "equipment", "friends", "summary", "invites", "milestones", "race-meta", "race-members", "slots", "event", "standings", "writer"]);
const OUTCOMES = new Set(["hit", "missing", "generation", "timezone", "boundary", "expired", "malformed", "error", "bypass", "installed", "lost-fill", "fallback"]);
function read(kind, outcome) {
  if (!SURFACES.has(kind) || !OUTCOMES.has(outcome)) throw new TypeError("Unbounded cache efficiency metric label");
  metrics.increment("cache_efficiency_read_total", { kind, outcome });
}
function count(kind, name, amount = 1) {
  if (!SURFACES.has(kind) || !["postgres", "redis", "bytes", "invalidations"].includes(name)) throw new TypeError("Invalid cache efficiency counter");
  metrics.increment(`cache_efficiency_${name}_total`, { kind }, amount);
}
function age(kind, milliseconds) {
  if (!SURFACES.has(kind)) throw new TypeError("Invalid cache efficiency surface");
  const outcome = milliseconds <= 15000 ? "0-15" : milliseconds <= 30000 ? "15-30" : milliseconds <= 60000 ? "30-60" : "60-plus";
  metrics.increment("cache_efficiency_age_total", { kind, outcome });
}
module.exports = { read, count, age };
