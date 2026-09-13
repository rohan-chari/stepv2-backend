const { randomUUID } = require('node:crypto');
const { coordinatedOptimizationMetrics: metrics } = require('../../../shared/observability/coordinatedOptimizationMetrics');

// Precedence is evaluated by callers from left to right. Exactly one process
// and raw terminal is emitted per user request; lookup/post/publication are
// separate stages and must never be summed as additional requests.
const REASONS = Object.freeze({
  process: ['hit', 'absent', 'expired', 'generation_mismatch', 'coverage_mismatch', 'caller_budget_source_model_mismatch'],
  raw: ['redis_disabled', 'caller_budget', 'no_historical_range', 'missing', 'malformed', 'incomplete_generation',
    'unavailable', 'absent_unknown', 'oversized', 'batch_byte_budget', 'malformed_payload', 'batch_row_budget',
    'accepted', 'proof_changed', 'paged_tail', 'merged_row_cap', 'memory_guard', 'source_failure'],
  lookup: ['unavailable', 'absent_unknown', 'oversized', 'batch_byte_budget', 'malformed_payload', 'batch_row_budget', 'accepted'],
  post: ['proof_changed', 'paged_tail', 'merged_row_cap'],
  publication: ['success', 'unavailable_failure', 'no_proof', 'changed_proof', 'paged_source',
    'total_timeline_cap_legacy', 'historical_row_cap', 'encoded_byte_cap', 'memory_guard'],
  coverage: ['first_observation', 'potential_coverage_reuse', 'different_coverage', 'same_coverage'],
});
const counters = Object.fromEntries(Object.keys(REASONS).map(stage => [stage, Object.fromEntries(REASONS[stage].map(reason => [reason, 0]))]));
const processStartIdentity = randomUUID();
const startedAt = new Date().toISOString();
let intervalStarted = Date.now();
let timer;
let legacySnapshot = () => ({});
let previousCounters = structuredClone(counters);
const ioTotals = {};
const reasonRows = {};
let previousIO = {};
const observations = new Map();
function startTelemetry() {
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    const intervalStages = Object.fromEntries(Object.entries(counters).map(([kind, values]) => [kind,
      Object.fromEntries(Object.entries(values).map(([reason, value]) => [reason, value - previousCounters[kind][reason]]))]));
    const intervalIO = Object.fromEntries(Object.entries(ioTotals).map(([kind, values]) => [kind,
      Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value - (previousIO[kind]?.[name] || 0)]))]));
    console.info(JSON.stringify({ event: 'historical_raw_sample_cache', schemaVersion: 2,
      observedAt: new Date(now).toISOString(), pid: process.pid, processStartIdentity,
      processStartedAt: startedAt, intervalMs: now - intervalStarted,
      ...legacySnapshot(), stages: counters, intervalStages, sourceRowsByReason: reasonRows, io: ioTotals, intervalIO }));
    previousCounters = structuredClone(counters); previousIO = structuredClone(ioTotals);
    intervalStarted = now;
  }, 60000);
  timer.unref();
}
function recordCacheStage(stage, reason, count = 1) {
  if (!REASONS[stage]?.includes(reason)) throw new TypeError('unknown cache telemetry reason');
  counters[stage][reason] += count;
  metrics.increment('race_scoring_cache_stage_total', { kind: stage, reason }, count);
  startTelemetry();
}
function observeCoverage(bound, proof, cutoff, now = Date.now()) {
  // One actual interval only; never synthesize a union of incomparable reads.
  // The fixed bound and TTL affect telemetry only, never cache acceptance.
  const key = `${bound.userId}:${proof.revision}`;
  for (const [id, row] of observations) { if (row.expiresAt > now) break; observations.delete(id); }
  const previous = observations.get(key);
  const start = +bound.rangeStart;
  let reason = 'first_observation';
  if (previous) {
    reason = previous.start === start && previous.cutoff === cutoff ? 'same_coverage'
      : previous.start <= start && previous.cutoff > start && previous.cutoff <= cutoff ? 'potential_coverage_reuse' : 'different_coverage';
  } else {
    if (observations.size >= 2000) observations.delete(observations.keys().next().value);
    observations.set(key, { start, cutoff, expiresAt: now + 600000 });
  }
  if (previous && start <= previous.start && cutoff >= previous.cutoff) {
    previous.start = start; previous.cutoff = cutoff; // one wider observed interval, never a union
  }
  recordCacheStage('coverage', reason);
  return reason;
}
function recordCacheRows(stage, reason, rows) {
  if (!REASONS[stage]?.includes(reason)) throw new TypeError('unknown cache row reason');
  const values = reasonRows[stage] ||= {};
  values[reason] = (values[reason] || 0) + rows;
  metrics.increment('race_scoring_cache_reason_rows_total', { kind: stage, reason }, rows);
}
function recordCacheIO(kind, { operations = 0, bytes = 0, rows = 0, elapsedMs = 0 } = {}) {
  if (!['proof', 'sample', 'redis_read', 'redis_write', 'full', 'recent'].includes(kind)) throw new TypeError('unknown cache IO');
  const total = ioTotals[kind] ||= { operations: 0, bytes: 0, rows: 0, elapsedMs: 0 };
  total.operations += operations; total.bytes += bytes; total.rows += rows; total.elapsedMs += elapsedMs;
  metrics.increment('race_scoring_cache_io_total', { kind, outcome: 'operations' }, operations);
  metrics.increment('race_scoring_cache_io_total', { kind, outcome: 'bytes' }, bytes);
  metrics.increment('race_scoring_cache_io_total', { kind, outcome: 'rows' }, rows);
  metrics.observe('race_scoring_cache_io_seconds', elapsedMs / 1000, { kind });
}
function setLegacySnapshot(reader) { legacySnapshot = reader; }
module.exports = { recordCacheStage, recordCacheRows, recordCacheIO, observeCoverage, setLegacySnapshot, REASONS };
