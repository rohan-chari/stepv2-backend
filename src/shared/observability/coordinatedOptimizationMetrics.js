const APPROVED_METRICS = new Set([
  "global_summary_capture_lookup_total",
  "global_summary_capture_lookup_per_sync",
  "global_summary_capture_mutable_scope_total",
  "global_summary_capture_mutable_users",
  "global_summary_capture_mutable_rows",
  "global_summary_capture_durable_fact_bytes",
  "global_summary_capture_prepared_method_total",
  "global_summary_capture_sample_db_rows",
  "global_summary_capture_daily_db_rows",
  "global_summary_capture_journal_db_rows",
  "global_summary_capture_snapshot_head_rows",
  "global_summary_capture_snapshot_head_bytes",
  "global_summary_capture_projection_root_operations",
  "global_summary_capture_daily_projection_root_operations",
  "global_summary_capture_generation_validation_rows",
  "global_summary_capture_fact_cache_users_total",
  "global_summary_capture_coverage_skip_total",
  "global_summary_waiting_races_ready_total",
  "global_summary_recovery_repair_total",
  "global_summary_worker_claim_total",
  "global_summary_race_resolution_gate_total",
  "global_summary_race_resolution_artifacts_total",
  "global_summary_race_resolution_impacts_total",
  "global_summary_race_resolution_empty_total",
  "race_resolution_total",
  "race_resolution_participants",
  "race_resolution_sql_calls",
  "race_resolution_batch_rows",
  "race_resolution_batch_bytes",
  "race_resolution_batch_heap_bytes",
  "race_resolution_batch_external_bytes",
  "race_resolution_batch_array_buffer_bytes",
  "race_scoring_batch_fallback_total",
  "race_scoring_input_cache_total",
  "race_scoring_input_cache_users",
  "race_scoring_input_cache_sample_rows",
  "race_resolution_query_seconds",
  "race_resolution_compute_seconds",
  "durable_queue_wake_received_total",
  "durable_queue_wake_coalesced_total",
  "durable_queue_wake_publish_failure_total",
  "durable_queue_fallback_poll_total",
  "durable_queue_idle_poll_total",
  "durable_queue_oldest_eligible_seconds",
  "placement_hydration_rows",
  "placement_hydration_ms",
  "placement_canonical_rows_read",
  "domain_projection_claim_examined_rows",
  "domain_projection_completed_total",
  "durable_queue_rows",
  "durable_queue_cleanup_rows_total",
  "durable_queue_cleanup_seconds",
  "domain_event_receipt_provisional_total",
  "domain_event_receipt_oldest_provisional_seconds",
]);

const APPROVED_LABELS = new Set([
  "queue", "state", "state_class", "plan", "outcome", "kind", "reason", "table",
  "found_work",
]);

function metricKey(name, labels = {}) {
  if (!APPROVED_METRICS.has(name)) throw new TypeError(`unapproved metric: ${name}`);
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (!APPROVED_LABELS.has(key) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(String(value))) {
      throw new TypeError(`unapproved metric label: ${key}`);
    }
  }
  return entries.length
    ? `${name}{${entries.map(([key, value]) => `${key}=${value}`).join(",")}}`
    : name;
}

function createCoordinatedOptimizationMetrics() {
  const counters = new Map();
  const histograms = new Map();
  return {
    increment(name, labels = {}, value = 1) {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) throw new TypeError("invalid metric increment");
      const key = metricKey(name, labels);
      counters.set(key, (counters.get(key) || 0) + amount);
    },
    observe(name, value, labels = {}) {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) throw new TypeError("invalid metric observation");
      const key = metricKey(name, labels);
      const row = histograms.get(key) || { count: 0, sum: 0, min: amount, max: amount };
      row.count += 1;
      row.sum += amount;
      row.min = Math.min(row.min, amount);
      row.max = Math.max(row.max, amount);
      histograms.set(key, row);
    },
    snapshot() {
      return {
        schema: "postgresql-coordinated-optimization-metrics-v1",
        counters: Object.fromEntries(counters),
        histograms: Object.fromEntries([...histograms].map(([key, row]) => [key, { ...row }])),
      };
    },
    reset() {
      counters.clear();
      histograms.clear();
    },
  };
}

const coordinatedOptimizationMetrics = createCoordinatedOptimizationMetrics();

module.exports = {
  APPROVED_METRICS,
  createCoordinatedOptimizationMetrics,
  coordinatedOptimizationMetrics,
};
