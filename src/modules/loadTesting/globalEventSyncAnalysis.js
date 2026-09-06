const FAILURE_REASONS = Object.freeze([
  "home_p95_threshold", "home_p99_threshold", "http_error_rate", "network_errors",
  "incomplete_home_transactions", "dropped_arrivals", "worker_restart",
  "db_connection_exhaustion", "queue_growth", "resource_safety_threshold", "timeout",
  "lock_wait_threshold", "db_cpu_threshold", "multiple", "inconclusive",
]);
const BOTTLENECKS = Object.freeze(["postgres", "node", "db_pool", "redis", "queue", "generator", "multiple", "inconclusive"]);

const COUNTERS = ["calls", "total_exec_time", "rows", "shared_blks_read", "shared_blks_hit", "shared_blks_dirtied", "temp_blks_written", "wal_bytes"];
const OUTCOME_BUCKETS = Object.freeze(["accepted202", "conflict409", "cooldown429", "other4xx", "server5xx", "networkFailure", "clientTimeout", "malformedResponse", "unexpectedStatus"]);
function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function metricCount(metric) { return number(metric?.values?.count ?? metric?.count ?? metric); }
function outcomeAccounting(metrics = {}, k6Iterations = null) {
  const counts = Object.fromEntries(OUTCOME_BUCKETS.map((key) => [key, 0]));
  const status = metrics.status || metrics.httpStatus || {};
  for (const [code, value] of Object.entries(status)) {
    const n = Number(code); const count = metricCount(value);
    if (n === 202) counts.accepted202 += count;
    else if (n === 409) counts.conflict409 += count;
    else if (n === 429) counts.cooldown429 += count;
    else if (n >= 400 && n < 500) counts.other4xx += count;
    else if (n >= 500 && n < 600) counts.server5xx += count;
    else counts.unexpectedStatus += count;
  }
  counts.networkFailure = metricCount(metrics.networkFailure || metrics.networkFailures);
  counts.clientTimeout = metricCount(metrics.clientTimeout || metrics.clientTimeouts);
  counts.malformedResponse = metricCount(metrics.malformedResponse || metrics.malformedResponses);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const iterations = k6Iterations == null ? total : Number(k6Iterations);
  return { ...counts, total, iterations, complete: total === iterations };
}
function cpuDeltaPercent(previous, current, elapsedSeconds, { hostCores = 1, mode = "single-core" } = {}) {
  const elapsed = Number(elapsedSeconds);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;
  const deltaMicros = (Number(current?.user) || 0) + (Number(current?.system) || 0) - (Number(previous?.user) || 0) - (Number(previous?.system) || 0);
  const singleCore = (deltaMicros / 1e6 / elapsed) * 100;
  return mode === "host-normalized" ? singleCore / Math.max(1, Number(hostCores) || 1) : singleCore;
}
function validateSamplerCoverage(samples = [], { measuredDurationSeconds, minSamples = null } = {}) {
  const measured = samples.filter((sample) => (sample.phase || "measured") === "measured");
  const required = minSamples == null ? Math.max(1, Math.floor(Number(measuredDurationSeconds || 0) - 1)) : Number(minSamples);
  return { available: samples.length > 0, measuredSamples: measured.length, requiredSamples: required, valid: measured.length >= required };
}
function validateLoadShape({ requestedRate, requestedDurationSeconds, iterations, actualDurationSeconds, uniqueUsers, tolerance = 0.05 } = {}) {
  const expected = Math.ceil(Number(requestedRate) * Number(requestedDurationSeconds));
  const rateOk = Math.abs((Number(iterations) / Math.max(0.001, Number(actualDurationSeconds))) - Number(requestedRate)) <= Number(requestedRate) * Number(tolerance);
  const durationOk = Math.abs(Number(actualDurationSeconds) - Number(requestedDurationSeconds)) <= Number(requestedDurationSeconds) * Number(tolerance);
  return { expectedIterations: expected, iterations: Number(iterations), rateOk, durationOk, uniqueUsersOk: Number(uniqueUsers) >= expected, valid: Number(iterations) === expected && rateOk && durationOk && Number(uniqueUsers) >= expected };
}
function canonicalFixtureDescriptor(input = {}) {
  const pick = (value) => Array.isArray(value) ? value.map(pick) : (value && typeof value === "object" ? Object.fromEntries(Object.keys(value).filter((k) => !/(uuid|id|timestamp|date|token|run.?id|createdAt|updatedAt|startedAt|endedAt)/i.test(k)).sort().map((k) => [k, pick(value[k])])) : value);
  return pick(input);
}
function logicalFixtureHash(input = {}) { return require("node:crypto").createHash("sha256").update(JSON.stringify(canonicalFixtureDescriptor(input))).digest("hex"); }
function reconcileCaptureWork({ scheduledUsers = [], attemptedUsers = [], acceptedUsers = [], failedUsers = [], pre = {}, post = {}, expectedArtifacts = null, artifacts = [] } = {}) {
  const ids = (rows) => new Set((rows || []).map((row) => typeof row === "string" ? row : row.userId).filter(Boolean));
  const scheduled = ids(scheduledUsers); const attempted = ids(attemptedUsers); const accepted = ids(acceptedUsers); const failed = ids(failedUsers);
  const remaining = Number(post.WAITING_SYNC || 0); const claimed = Number(post.CLAIMED || post.PROCESSING || 0);
  const expected = expectedArtifacts == null ? accepted.size : Number(expectedArtifacts);
  const actual = Array.isArray(artifacts) ? artifacts.length : Number(post.artifacts || 0);
  const unattempted = [...scheduled].filter((id) => !attempted.has(id));
  const acceptedMissing = Math.max(0, accepted.size - Number(post.completedUsers || post.captureCompletions || 0));
  const unexplained = Math.max(0, acceptedMissing - unattempted.length - failed.size);
  return { scheduledUsers: scheduled.size, attemptedUsers: attempted.size, acceptedUsers: accepted.size, failedUsers: failed.size, unattemptedUsers: unattempted.length, remainingWaitingSync: remaining, claimedInProgress: claimed, expectedArtifacts: expected, captureArtifacts: actual, duplicateArtifacts: Math.max(0, actual - new Set((artifacts || []).map((row) => row.id || row.workId || JSON.stringify(row))).size), acceptedMissingTerminalization: acceptedMissing, unexplained: unexplained, valid: unexplained === 0 && claimed === 0 };
}
function normalizeSql(query) {
  return String(query || "").replace(/\s+/g, " ").replace(/'(?:''|[^'])*'/g, "'?' ").replace(/\b\d+(?:\.\d+)?\b/g, "?").replace(/'\?'\s+/g, "'?' ").trim();
}
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function summarizeValues(values = []) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? { mean: clean.reduce((sum, value) => sum + value, 0) / clean.length, p50: percentile(clean, 50), p95: percentile(clean, 95), p99: percentile(clean, 99), max: Math.max(...clean) } : { mean: null, p50: null, p95: null, p99: null, max: null };
}
function summarizeCapacityResources(samples = []) {
  const values = (selector) => summarizeValues(samples.map(selector));
  const container = (needle, field = "CPUPerc") => values((sample) => Number(String(sample.containers?.find((row) => String(row.Name || row.name || "").includes(needle))?.[field] || "").replace("%", "")));
  const process = (role, instance = null) => summarizeValues(samples.map((sample, index) => {
    const health = role === "http" ? (instance === 1 ? sample.health?.httpPeer : sample.health?.http) : sample.health?.[role];
    const direct = Number(health?.capacity?.process?.cpuPercent ?? health?.capacity?.process?.cpuOneCorePercent);
    if (Number.isFinite(direct)) return direct;
    const previous = samples[index - 1];
    const priorHealth = role === "http" ? (instance === 1 ? previous?.health?.httpPeer : previous?.health?.http) : previous?.health?.[role];
    const cpu = health?.capacity?.cpu; const priorCpu = priorHealth?.capacity?.cpu;
    const dt = previous ? Math.max(0.001, (Date.parse(sample.at) - Date.parse(previous.at)) / 1000) : 0;
    if (!cpu || !priorCpu || !dt) return NaN;
    return ((Number(cpu.user) - Number(priorCpu.user) + Number(cpu.system) - Number(priorCpu.system)) / 1e6 / dt) * 100;
  }));
  const memory = summarizeValues(samples.map((sample) => {
    const raw = sample.containers?.find((row) => String(row.Name || row.name || "").includes("backend"))?.MemUsage || "";
    const match = String(raw).match(/([\d.]+)\s*(GiB|MiB|KiB|B)/i); if (!match) return NaN;
    return Number(match[1]) * ({ gib: 1024 ** 3, mib: 1024 ** 2, kib: 1024, b: 1 }[match[2].toLowerCase()] || 1);
  }));
  return { status: samples.length && samples.some((sample) => sample.containers?.length) ? "available" : "unavailable", backendCpuPercent: container("backend"), postgresCpuPercent: container("postgres"), redisCpuPercent: container("redis"), backendMemory: memory, eventLoopLagMs: summarizeValues(samples.map((s) => s.health?.http?.capacity?.process?.eventLoopP99Ms)), lockWaitMs: summarizeValues(samples.flatMap((s) => s.lockWaitMs || [])), queueDepth: summarizeValues(samples.map((s) => s.resolutionQueueDepth)), queueLagMs: summarizeValues(samples.map((s) => s.resolutionQueueLagMs)), http0CpuPercent: process("http", 0), http1CpuPercent: process("http", 1), resolutionCpuPercent: process("resolution"), cronCpuPercent: process("cron") };
}

async function snapshotPgStatStatements(pool) {
  if (!pool) return { status: "unavailable", reason: "database_not_configured", rows: [], reset: null };
  try {
    const [statements, info, provenance] = await Promise.all([
      pool.query("SELECT queryid::text AS queryid, query, calls, total_exec_time, rows, shared_blks_read, shared_blks_hit, shared_blks_dirtied, temp_blks_written, wal_bytes FROM pg_stat_statements"),
      pool.query("SELECT stats_reset, dealloc, stats_reset AS reset_marker FROM pg_stat_statements_info"),
      pool.query("SELECT current_database() AS database, current_setting('server_version_num') AS server_version_num, current_setting('server_version') AS server_version"),
    ]);
    return { status: "available", rows: statements.rows, reset: info.rows[0] || null, provenance: provenance.rows[0] || null };
  } catch (error) {
    if (["42P01", "42883", "42704"].includes(error?.code)) return { status: "unavailable", reason: "pg_stat_statements_absent", rows: [], reset: null };
    throw error;
  }
}

function csvPgStatStatements(rows = []) {
  const columns = ["queryid", "calls", "callsPerSecond", "totalExecutionTimeMs", "meanExecutionTimeMs", "rows", "rowsPerCall", "percentageOfMeasuredDbTime", "source"];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n";
}

function renderGlobalEventSyncReport(summary = {}) {
  const deltas = summary.telemetry?.pgStatStatements?.delta || [];
  const keyQueries = deltas.filter((row) => /step_samples|user_scoring_input_versions|race_powerup|global_event_capture_artifacts/i.test(String(row.query || ""))).slice(0, 8);
  const lines = ["# Global-event step-sync smoke report", "", `Run: ${summary.runId || "unknown"}`, `Profile: ${summary.profile || "unknown"}`, `Runtime: ${Number(summary.runtime?.totalMs || 0)} ms`, `Evidence valid: ${summary.evidenceValid === true ? "yes" : "no"}`, `Workload passed: ${summary.workloadPassed === true ? "yes" : "no"}`, `k6 process succeeded: ${summary.k6ProcessSucceeded === true ? "yes" : "no"}`, ...(summary.invalidityReasons?.length ? [`Invalidity reasons: ${summary.invalidityReasons.join(", ")}`] : []), ...(summary.workloadFailureReasons?.length ? [`Workload failure reasons: ${summary.workloadFailureReasons.join(", ")}`] : []), "", "## Correctness", "", `- Control entered capture: ${summary.correctness?.controlEnteredCapture === true ? "yes" : "no"}`, `- Treatment entered capture: ${summary.correctness?.treatmentEnteredCapture === true ? "yes" : "no"}`, `- Treatment claim observed: ${summary.correctness?.treatmentClaimed === true ? "yes" : "no"}`, `- Duplicate retry accepted: ${summary.correctness?.duplicateAccepted === true ? "yes" : "no"}`, `- Artifact uniqueness: ${summary.correctness?.captureArtifactUniqueness === true ? "yes" : "no"}`, `- Drain completed: ${summary.correctness?.drainCompleted === true ? "yes" : "no"}`, "", "## Evidence", "", `- pg_stat_statements: ${summary.telemetry?.pgStatStatements?.status || "unavailable"}`, `- VM/database one-second sampler: ${summary.telemetry?.vm?.status || summary.telemetry?.metricsArtifact ? "available" : "unavailable"}`, `- Run ID: ${summary.runId || "unknown"}`, "", "### Capture-path SQL deltas", "", ...(keyQueries.length ? keyQueries.map((row) => `- queryid ${row.queryid}: ${Number(row.calls || 0)} calls, ${Number(row.totalExecutionTimeMs || 0).toFixed(2)} ms — ${String(row.query || "").replace(/\s+/g, " ").slice(0, 180)}`) : ["- No matching capture-path SQL rows were observed in the interval."] )];
  const outcome = summary.http?.outcomes || summary.outcomes || {};
  const resources = summary.telemetry?.resources || {};
  lines.push("", "## HTTP outcomes", "", `- Requests: ${Number(outcome.total || 0)}`, `- 202 accepted: ${Number(outcome.accepted202 || 0)}`, `- 409 conflicts: ${Number(outcome.conflict409 || 0)}`, `- 429 cooldowns: ${Number(outcome.cooldown429 || 0)}`, `- 5xx: ${Number(outcome.server5xx || 0)}`, `- Network failures: ${Number(outcome.networkFailures || 0)}`, "", "## Resource statistics", "", ...Object.entries(resources).map(([name, value]) => `- ${name}: ${JSON.stringify(value)}`));
  return lines.join("\n") + "\n";
}

function deltaPgStatStatements(rows = [], { durationSeconds = 1, sourceMap = {} } = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.queryid ?? row.queryId ?? row.query ?? "unknown");
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  const result = [];
  for (const [queryid, list] of grouped) {
    const before = list.length > 1 ? list[0] : {};
    const after = list.length > 1 ? list[list.length - 1] : list[0];
    const rawQuery = after.query || before.query || null;
    const item = { queryid, query: normalizeSql(rawQuery), rawQuery };
    for (const field of COUNTERS) item[field] = Math.max(0, number(after[field]) - number(before[field]));
    item.callsPerSecond = item.calls / Math.max(0.001, Number(durationSeconds));
    item.meanExecutionTimeMs = item.calls ? item.total_exec_time / item.calls : 0;
    item.rowsPerCall = item.calls ? item.rows / item.calls : 0;
    item.totalExecutionTimeMs = item.total_exec_time;
    const mappedEntry = sourceMap[queryid] || sourceMap[String(queryid)];
    const mapped = typeof mappedEntry === "string" ? mappedEntry : mappedEntry && (!mappedEntry.queryPattern || new RegExp(mappedEntry.queryPattern, "i").test(item.query || "")) ? `${mappedEntry.source || "unknown"}${mappedEntry.function ? `#${mappedEntry.function}` : ""}` : null;
    item.source = mapped || sourceByShape(item.query) || "unknown";
    result.push(item);
  }
  const total = result.reduce((sum, item) => sum + item.totalExecutionTimeMs, 0);
  result.forEach((item) => { item.percentageOfMeasuredDbTime = total ? (item.totalExecutionTimeMs / total) * 100 : 0; });
  return result.sort((a, b) => b.totalExecutionTimeMs - a.totalExecutionTimeMs || a.queryid.localeCompare(b.queryid));
}

function sourceByShape(query) {
  const text = String(query || "");
  if (/user_scoring_input_versions/i.test(text) && /FOR UPDATE/i.test(text)) return "src/modules/steps/services/globalEventSummaryCapture.js#lockEligibleSummaryCaptureDependencies";
  if (/step_samples/i.test(text)) return "src/modules/steps/services/globalEventSummaryCapture.js#loadArtifactFacts";
  if (/race_powerup|race_active_effect/i.test(text)) return "src/modules/steps/services/globalEventSummaryCapture.js#loadArtifactFacts";
  if (/global_event_capture_artifacts/i.test(text)) return "src/modules/steps/services/globalEventSummaryCapture.js#captureArtifact";
  if (/global_event_summary_work/i.test(text)) return "src/modules/steps/services/globalEventSummaryCapture.js#claimEligibleSummaryWork";
  if (/global_event_race_impacts|missing.?summary|summary.*recovery/i.test(text)) return "src/modules/steps/jobs/globalEventSummary.js#recoverMissingSummaries";
  if (/race_resolution_full_triggers|full.?trigger/i.test(text)) return "src/modules/races/jobs/raceResolutionQueueV2.js#promoteFullTriggers";
  return null;
}

function classifyFailureReason(metrics = {}) {
  const gates = metrics.gates || {};
  const failed = [];
  if (gates.homeP95 === false) failed.push("home_p95_threshold");
  if (gates.homeP99 === false) failed.push("home_p99_threshold");
  if (gates.errorRate === false) failed.push("http_error_rate");
  if (gates.networkErrors === false) failed.push("network_errors");
  if (gates.incomplete === false) failed.push("incomplete_home_transactions");
  if (gates.dropped === false) failed.push("dropped_arrivals");
  if (gates.workerRestart === false) failed.push("worker_restart");
  if (gates.dbConnections === false) failed.push("db_connection_exhaustion");
  if (gates.lockWait === false) failed.push("lock_wait_threshold");
  if (gates.queue === false) failed.push("queue_growth");
  if (gates.resource === false) failed.push("resource_safety_threshold");
  if (gates.timeout === false) failed.push("timeout");
  if (gates.dbCpu === false) failed.push("db_cpu_threshold");
  return failed.length === 0 ? "inconclusive" : failed.length === 1 ? failed[0] : "multiple";
}

function classifyPrimaryBottleneck(metrics = {}) {
  const dbCpu = number(metrics.db?.cpuPercent ?? metrics.dbCpuPercent);
  const nodeCpu = number(metrics.node?.cpuPercent ?? metrics.serverCpuPercent);
  const locks = number(metrics.locks?.blocked ?? metrics.lockWaits);
  const pool = number(metrics.pool?.waiting ?? metrics.poolWaiters);
  const queue = number(metrics.queue?.growth ?? metrics.queueGrowth);
  if (pool > 0 && dbCpu < 85 && nodeCpu < 85) return "db_pool";
  if (queue > 0 && dbCpu < 85 && nodeCpu < 85 && locks === 0) return "queue";
  const candidates = [];
  if (dbCpu >= 85) candidates.push([dbCpu, "postgres"]);
  if (locks > 0) candidates.push([locks, "postgres"]);
  if (pool > 0) candidates.push([pool, "db_pool"]);
  if (queue > 0) candidates.push([queue, "queue"]);
  if (nodeCpu >= 85) candidates.push([nodeCpu, "node"]);
  if (!candidates.length) return "inconclusive";
  const maximum = Math.max(...candidates.map(([score]) => score));
  const tied = candidates.filter(([score]) => score === maximum).map(([, name]) => name);
  return new Set(tied).size > 1 ? "multiple" : tied[0];
}

function phaseRuntime(phases = {}, minimumRuntimeMs = 0) {
  const known = ["environmentPreparation", "workflowValidation", "initialPrewarm", "targetedResets", "settlingDraining", "perLevelWarmups", "measuredLoad", "failureConfirmation", "boundaryNarrowing", "metricsCollection", "reportGeneration", "cleanup"];
  const output = {};
  for (const name of known) output[`${name}Ms`] = Math.max(0, number(phases[name] ?? phases[`${name}Ms`]));
  output.totalMs = Math.max(Number(minimumRuntimeMs) || 0, Object.values(output).reduce((sum, value) => sum + value, 0));
  return output;
}

function buildSummary(input = {}) {
  const summary = { schema: "global-event-step-sync-summary-v1", version: "1.0.0", ...input };
  if (!FAILURE_REASONS.includes(summary.failureReason)) summary.failureReason = "inconclusive";
  if (!BOTTLENECKS.includes(summary.primaryBottleneck)) summary.primaryBottleneck = "inconclusive";
  summary.runtime = phaseRuntime(summary.runtime || {});
  return summary;
}

module.exports = { BOTTLENECKS, FAILURE_REASONS, OUTCOME_BUCKETS, buildSummary, classifyFailureReason,
  classifyPrimaryBottleneck, csvPgStatStatements, deltaPgStatStatements, normalizeSql, percentile, phaseRuntime, renderGlobalEventSyncReport, snapshotPgStatStatements, sourceByShape, summarizeCapacityResources, summarizeValues, outcomeAccounting, metricCount, cpuDeltaPercent, validateSamplerCoverage, validateLoadShape, canonicalFixtureDescriptor, logicalFixtureHash, reconcileCaptureWork };
