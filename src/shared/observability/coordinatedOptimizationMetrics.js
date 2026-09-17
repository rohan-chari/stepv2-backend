const APPROVED_METRICS = new Set([
  "deadline_scheduler_pass_total", "deadline_scheduler_query_total", "deadline_scheduler_drain_total", "deadline_scheduler_pass_seconds",
  "global_event_enrollment_seconds", "global_event_enrollment_total",
  "race_scoring_cache_reason_rows_total", "race_scoring_cache_stage_total", "race_scoring_cache_io_total", "race_scoring_cache_io_seconds",
  "event_fingerprint_cache_total",
  "cache_efficiency_read_total", "cache_efficiency_source_loads_total",
  "cache_efficiency_redis_total", "cache_efficiency_bytes_total",
  "cache_efficiency_invalidations_total", "cache_efficiency_age_total",
  "cache_efficiency_counterfactual_total",
  "race_effect_expiry_stage_seconds",
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
  "race_scoring_historical_window_cache_total",
  "race_scoring_historical_raw_cache_total",
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
  "domain_event_receipt_created_total",
  "domain_event_receipt_repaired_total",
  "domain_event_receipt_failed_total",
  "domain_event_receipt_quarantined_total",
  "domain_event_receipt_recovery_claim_total",
  "domain_event_receipt_recovery_age_seconds",
  "late_samples_received_total", "late_sample_age_seconds",
  "historical_discovery_queries_total", "historical_discovery_races_found",
  "historical_intents_created", "historical_intents_coalesced",
  "historical_intents_overflowed", "historical_intents_completed",
  "historical_intents_retried", "historical_queue_age_seconds",
  "historical_worker_duration_ms", "historical_race_fence_wait_ms",
  "historical_out_of_horizon_total",
  "historical_effects_checked", "historical_effects_corrected",
  "historical_reconciliation_noop", "historical_reconciliation_generation_stale",
  "historical_source_rows_read", "historical_corrections_created",
  "correction_delta_steps_absolute", "historical_reconciliation_duration_ms",
]);

const APPROVED_LABELS = new Set([
  "queue", "state", "state_class", "plan", "outcome", "kind", "reason", "table",
  "found_work",
  "race_status", "age_bucket", "result", "scope_kind",
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
