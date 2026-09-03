const SUMMARY_SCHEMA = "bara-perf-summary-v3";
const MANIFEST_SCHEMA = "bara-perf-manifest-v1";
const CONFIG_SCHEMA = "bara-perf-config-v1";
const FAILURE_REASON_SCHEMA = "bara-perf-failure-reason-v2";
const BOTTLENECK_SCHEMA = "bara-perf-bottleneck-v1";

const RATE_STATES = Object.freeze(["PASS", "FAIL", "UNSTABLE"]);
const FAILURE_REASONS = Object.freeze([
  "home_p95_threshold",
  "home_p99_threshold",
  "races_core_p95_threshold",
  "races_core_p99_threshold",
  "http_error_rate",
  "network_errors",
  "incomplete_home_transactions",
  "incomplete_races_core_transactions",
  "incomplete_races_discovery",
  "incomplete_races_friends",
  "races_contract_error",
  "scheduler_quota_drift",
  "cache_profile_mismatch",
  "races_payload_content_mismatch",
  "fixture_state_coverage_missing",
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
