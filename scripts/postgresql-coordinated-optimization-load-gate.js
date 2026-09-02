#!/usr/bin/env node

const fs = require("node:fs");
const RECOVERY_LIMITS_MS = Object.freeze({
  resolution: 5_000, placement: 10_000, postTask: 30_000, domainEvent: 10_000,
  globalSummary: 60_000, notificationSchedule: 60_000, inbox: 60_000,
});
function number(value) { return Number(value) || 0; }
const sum = (artifact, pattern, field) => (artifact.statements || [])
  .filter((row) => pattern.test(row.normalizedQuery))
  .reduce((total, row) => total + number(row[field]), 0);
const reduction = (before, after) => before > 0 ? 1 - after / before : null;
function evaluateLoadGate(baseline, candidate) {
const runtime = candidate.runtimeEvidence || {};
const beforeP95 = baseline.runtimeEvidence?.p95Ms || {};
const afterP95 = runtime.p95Ms || {};
const redis = runtime.healthyRedis || {};
const baselineRedis = baseline.runtimeEvidence?.healthyRedis || {};
const quantilesNoSlowerAtResolution = (after, before) => ["p50", "p95", "p99"].every((q) =>
  Number.isFinite(Number(after?.[q])) && Number.isFinite(Number(before?.[q])) &&
    Number(after[q]) <= Number(before[q]) + 10);
const gates = {
  intervalEvidenceValid: Number.isFinite(Number(baseline.intervalSeconds)) &&
    Number(baseline.intervalSeconds) > 0 && Number.isFinite(Number(candidate.intervalSeconds)) &&
    Number(candidate.intervalSeconds) > 0,
  idleQueueCallReduction: reduction(
    sum(baseline, /SKIP LOCKED|race_resolution|race_placement|global_event_summary/i, "callsPerSecond"),
    sum(candidate, /SKIP LOCKED|race_resolution|race_placement|global_event_summary/i, "callsPerSecond"),
  ),
  globalSummaryScanReduction: reduction(
    sum(baseline, /global_event_summary_work/i, "shared_blks_hit"),
    sum(candidate, /global_event_summary_work/i, "shared_blks_hit"),
  ),
  terminalProjectionFetchReduction: reduction(
    sum(baseline, /domain_event_notification_projections/i, "rows"),
    sum(candidate, /domain_event_notification_projections/i, "rows"),
  ),
  participants500: runtime.scoring?.participants === 500,
  participants500NoFallback: runtime.scoring?.fallbackCount === 0,
  pageHeapAtMost32MiB: Number.isFinite(Number(runtime.scoring?.maxPageHeapGrowthBytes)) &&
    number(runtime.scoring.maxPageHeapGrowthBytes) <= 32 * 1024 * 1024,
  pageHeapNoGrowth: Number.isFinite(Number(runtime.scoring?.retainedHeapSlopeBytesPerPage)) &&
    number(runtime.scoring.retainedHeapSlopeBytesPerPage) <= 0,
  p95NoRegression: ["resolution", "placement", "notification"].every((name) =>
    Number.isFinite(Number(beforeP95[name])) && Number.isFinite(Number(afterP95[name])) &&
      Number(afterP95[name]) <= Number(beforeP95[name])),
  healthyRedisMeasurementResolution10ms: Number(redis.measurementResolutionMs) === 10,
  healthyRedisDrainRequestQuantiles: quantilesNoSlowerAtResolution(
    redis.commitToDrainRequestMs, baselineRedis.commitToDrainRequestMs),
  healthyRedisFirstClaimQuantiles: quantilesNoSlowerAtResolution(
    redis.commitToFirstClaimMs, baselineRedis.commitToFirstClaimMs),
  healthyRedisNeverWaitsForRecovery: Number(runtime.eligibleWorkWaitingForRecoveryPoll) === 0,
  lostWakeRecoveryIntervals: Object.entries(RECOVERY_LIMITS_MS).every(([name, limit]) =>
    Number.isFinite(Number(runtime.lostWakeRecoveryMs?.[name])) &&
    number(runtime.lostWakeRecoveryMs[name]) <= limit),
  postTaskIdleClaimBound: Number.isFinite(Number(runtime.postTaskEmptyClaimsPer30Seconds)) &&
    Number(runtime.postTaskEmptyClaimsPer30Seconds) <= 1,
  noWaitingRacesRecoveryChurn: Number(runtime.waitingRacesRecoveryChurn) === 0,
  noDuplicateVisibleOutput: Number(runtime.duplicateVisibleOutputs) === 0,
};
const failures = Object.entries(gates)
  .filter(([name, value]) => name.endsWith("Reduction") ? value == null || value < 0.9 : value !== true)
  .map(([name, value]) => ({ name, measured: value }));
return { schema: "postgresql-coordinated-optimization-load-gate-v2", gates, failures };
}
if (require.main === module) {
  const [, , baselinePath, candidatePath] = process.argv;
  if (!baselinePath || !candidatePath) throw new Error("usage: postgresql-coordinated-optimization-load-gate.js baseline.json candidate.json");
  const report = evaluateLoadGate(JSON.parse(fs.readFileSync(baselinePath, "utf8")), JSON.parse(fs.readFileSync(candidatePath, "utf8")));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
module.exports = { evaluateLoadGate, RECOVERY_LIMITS_MS };
