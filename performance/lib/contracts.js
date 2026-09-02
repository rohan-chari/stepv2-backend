const SUMMARY_SCHEMA = "bara-perf-summary-v2";
const MANIFEST_SCHEMA = "bara-perf-manifest-v1";
const CONFIG_SCHEMA = "bara-perf-config-v1";
const FAILURE_REASON_SCHEMA = "bara-perf-failure-reason-v1";
const BOTTLENECK_SCHEMA = "bara-perf-bottleneck-v1";

const RATE_STATES = Object.freeze(["PASS", "FAIL", "UNSTABLE"]);
const FAILURE_REASONS = Object.freeze([
  "home_p95_threshold",
  "home_p99_threshold",
  "http_error_rate",
  "network_errors",
  "incomplete_home_transactions",
  "dropped_arrivals",
  "worker_restart",
  "db_connection_exhaustion",
  "queue_growth",
  "resource_safety_threshold",
  "timeout",
  "multiple",
  "unknown",
]);
const BOTTLENECKS = Object.freeze([
  "postgres",
  "node",
  "db_pool",
  "redis",
  "queue",
  "generator",
  "multiple",
  "inconclusive",
]);

module.exports = {
  BOTTLENECK_SCHEMA,
  BOTTLENECKS,
  CONFIG_SCHEMA,
  FAILURE_REASON_SCHEMA,
  FAILURE_REASONS,
  MANIFEST_SCHEMA,
  RATE_STATES,
  SUMMARY_SCHEMA,
};
