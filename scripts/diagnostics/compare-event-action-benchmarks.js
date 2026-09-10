#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const directory = path.resolve(process.argv[2] || "docs/evidence/event-traffic-efficiency/matched");
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};
const range = (values) => Math.max(...values) - Math.min(...values);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const files = fs.readdirSync(directory).filter((f) => /^(baseline|candidate)-(same|disjoint)-[135]-r[123]\.json(?:\.gz)?$/.test(f));
const runs = files.map((file) => {
  const stored = fs.readFileSync(path.join(directory, file));
  const contents = file.endsWith(".gz") ? zlib.gunzipSync(stored) : stored;
  const data = JSON.parse(contents);
  const sessionPhase = data.phases.find((p) => p.name === "fixed-arrival-event-sessions");
  const requests = data.requests.filter((r) => r.phase === "fixed-arrival-event-sessions");
  return { file, sha256: crypto.createHash("sha256").update(contents).digest("hex"), data,
    summary: { success: data.success === true, sessions: data.sessions?.length || 0,
      acceptedUploads: requests.filter((r) => r.method === "POST" && r.status >= 200 && r.status < 300).length,
      errors: requests.filter((r) => r.status >= 400).length,
      elapsedMs: sessionPhase?.elapsedMs,
      sqlEvents: sessionPhase?.sqlEvents,
      sessionP95Ms: percentile((data.sessions || []).map((s) => s.completionMs), 0.95),
      sessionP99Ms: percentile((data.sessions || []).map((s) => s.completionMs), 0.99),
      requestP95Ms: percentile(requests.map((r) => r.elapsedMs), 0.95),
      requestP99Ms: percentile(requests.map((r) => r.elapsedMs), 0.99),
      successfulPolls: (data.sessions || []).filter((s) => s.pollState === "SUCCEEDED").length,
      sqlSummary: data.sqlSummary,
    },
  };
});
const comparison = { complete: files.length === 36, passed: false, traces: [], runs: runs.map(({ data, ...run }) => run), limitations: [
  "Six sessions per repetition: p95/p99 are observed tail samples, not population estimates.",
  "completionMs includes observer drain followed by progress navigation with verified totals; automatic catch-up HTTP timing is recorded separately.",
  "SQL totals include periodic worker queries; isolated per-action savings require the focused integration tests.",
] };
for (const topology of ["same", "disjoint"]) for (const memberships of [1, 3, 5]) {
  const selected = runs.filter((r) => r.data.trace.topology === topology && r.data.trace.memberships === memberships);
  const baseline = selected.filter((r) => r.data.variant === "baseline");
  const candidate = selected.filter((r) => r.data.variant === "candidate");
  const result = { topology, memberships, baselineRuns: baseline.length, candidateRuns: candidate.length, checks: {}, baseline: {}, candidate: {} };
  if (baseline.length !== 3 || candidate.length !== 3) { comparison.traces.push(result); continue; }
  result.checks.sameTrace = selected.every((r) => JSON.stringify(r.data.trace) === JSON.stringify(baseline[0].data.trace));
  result.checks.allSuccessful = selected.every((r) => r.summary.success && r.summary.sessions === 6 && r.summary.acceptedUploads === 12 && r.summary.errors === 0);
  result.checks.visibleTotals = selected.every((r) => r.data.sessions?.length === 6 && r.data.sessions.every((s) =>
    ["SUCCEEDED", "SUPERSEDED"].includes(s.pollState) && s.receiptCovered === true && s.jobs?.length === memberships &&
    s.jobs.every((j) => j.state === "succeeded" && j.committedGeneration >= j.generation) &&
    s.visible?.length === memberships && s.visible.every((v) => v.totalSteps === v.expectedTotal)));
  result.checks.exercisedNarrowHome = candidate.every((r) => r.data.sessions.some((s) => s.pollState === "SUCCEEDED" && s.catchupView === "sync-refresh-v1"));
  result.checks.identicalOutcomes = selected.every((r) => JSON.stringify(r.data.outcomes) === JSON.stringify(baseline[0].data.outcomes));
  for (const metric of ["sqlEvents", "elapsedMs", "sessionP95Ms", "sessionP99Ms", "requestP95Ms", "requestP99Ms"]) {
    const before = baseline.map((r) => r.summary[metric]), after = candidate.map((r) => r.summary[metric]);
    result.baseline[metric] = { runs: before, mean: mean(before), min: Math.min(...before), max: Math.max(...before) };
    result.candidate[metric] = { runs: after, mean: mean(after), min: Math.min(...after), max: Math.max(...after) };
    if (metric !== "sqlEvents") {
      const ceiling = Math.max(...before) + range(before);
      result.checks[metric] = after.every((n) => n <= ceiling);
      result.baseline[metric].acceptanceCeiling = ceiling;
    }
  }
  result.checks.lowerMeanSessionSql = result.candidate.sqlEvents.mean < result.baseline.sqlEvents.mean;
  result.passed = Object.values(result.checks).every(Boolean);
  comparison.traces.push(result);
}
comparison.passed = comparison.complete && comparison.traces.every((t) => t.passed);
fs.writeFileSync(path.join(directory, "comparison.json"), JSON.stringify(comparison, null, 2));
console.log(JSON.stringify({ complete: comparison.complete, passed: comparison.passed, traces: comparison.traces }, null, 2));
if (process.argv.includes("--require-pass")) assert.ok(comparison.passed, "matched comparison incomplete or acceptance check failed");
