const { coordinatedOptimizationMetrics: metrics } = require("./coordinatedOptimizationMetrics");

const ALLOWED_LABELS = new Set(["race_status", "age_bucket", "result", "reason", "scope_kind"]);
function boundedLabels(labels = {}) {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => ALLOWED_LABELS.has(key)));
}
function increment(name, labels = {}, value = 1) { metrics.increment(name, boundedLabels(labels), value); }
function observe(name, value, labels = {}) { metrics.observe(name, value, boundedLabels(labels)); }

module.exports = { increment, observe };
