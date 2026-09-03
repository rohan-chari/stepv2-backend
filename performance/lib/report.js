const fs = require("node:fs");
const path = require("node:path");
const { BOTTLENECKS, FAILURE_REASONS, SUMMARY_SCHEMA } = require("./contracts");

function buildSummary(input = {}) {
  const scan = input.scan || {};
  if (scan.failureReason != null && !FAILURE_REASONS.includes(scan.failureReason)) {
    throw new Error("summary has an unsupported failure reason");
  }
  if (!BOTTLENECKS.includes(scan.primaryBottleneck || "inconclusive")) {
    throw new Error("summary has an unsupported primary bottleneck");
  }
  return {
    schema: SUMMARY_SCHEMA,
    status: input.status || "completed",
    error: input.error || null,
    runId: input.runId,
    mode: input.mode,
    commit: input.commit,
    dataset: input.dataset,
    workload: input.workload || null,
    environmentBinding: input.environmentBinding || null,
    topology: input.topology || null,
    fixtureProfile: input.fixtureProfile || null,
    backgroundMode: input.backgroundMode,
    cacheMode: input.cacheMode,
    highestPassingRate: scan.highestPassingRate ?? null,
    firstFailingRate: scan.firstFailingRate ?? null,
    rateClassifications: scan.rateClassifications || [],
    headroomPolicy: scan.headroomPolicy ?? null,
    calculatedHeadroomTarget: scan.calculatedHeadroomTarget ?? null,
    safeCapacityCandidateTested: scan.safeCapacityCandidateTested ?? null,
    safeCapacityCandidates: scan.safeCapacityCandidates || [],
    safeHomeOpensPerSecond: scan.safeHomeOpensPerSecond ?? null,
    safeCapacityUnavailableReason: scan.safeCapacityUnavailableReason ?? null,
    failureReason: scan.failureReason ?? null,
    failureReasonDetail: scan.failureReasonDetail ?? null,
    primaryBottleneck: scan.primaryBottleneck || "inconclusive",
    scanRuntimeSeconds: input.runtime?.scanRuntimeSeconds ?? null,
    runtimeTargetExceeded: input.runtime?.runtimeTargetExceeded === true,
    runtimeBudgetWarning: input.runtime?.runtimeBudgetWarning === true,
    runtimeBreakdownSeconds: input.runtime?.runtimeBreakdownSeconds || {},
    levels: input.levels || [],
    warnings: input.warnings || [],
    limitations: input.limitations || [],
  };
}

function buildManifest(input = {}) {
  return {
    schema: "bara-perf-manifest-v1",
    runId: input.runId,
    mode: input.mode,
    commit: input.commit,
    dataset: input.dataset,
    workload: input.workload || null,
    environmentBinding: input.environmentBinding || null,
    topology: input.topology || null,
    fixtureProfile: input.fixtureProfile || null,
    backgroundMode: input.backgroundMode,
    cacheMode: input.cacheMode,
    effectiveConfig: input.effectiveConfig || null,
    startedAt: input.startedAt || null,
    endedAt: input.endedAt || null,
  };
}

function displayBottleneck(value) {
  return ({ postgres: "PostgreSQL", node: "Node HTTP workers", db_pool: "Database pool",
    redis: "Redis", queue: "Resolution queue", generator: "k6 generator",
    multiple: "Multiple subsystems", inconclusive: "Inconclusive" })[value] || value;
}

function failureSentence(summary) {
  const detail = summary.failureReasonDetail;
  if (summary.failureReason === "home_p95_threshold" && detail) {
    return `${summary.firstFailingRate} Home opens/sec failed because Home p95 reached ${Number(detail.observed).toLocaleString("en-US")} ms, above the configured ${Number(detail.threshold).toLocaleString("en-US")} ms threshold.`;
  }
  if (summary.firstFailingRate == null) return "No confirmed failing rate was observed.";
  return `${summary.firstFailingRate} Home opens/sec failed the ${summary.failureReason || "unknown"} capacity gate.`;
}

function renderReport(summary) {
  const profile = summary.fixtureProfile?.productionShapedScores;
  const classifications = summary.rateClassifications.length
    ? summary.rateClassifications.map((row) =>
      `| ${row.rate}/sec | ${row.unstable ? "UNSTABLE → " : ""}${row.state} | ${row.failures} fail, ${row.passes} pass |`).join("\n")
    : "| — | — | — |";
  const levels = summary.levels.length
    ? summary.levels.map((row) => `| ${row.rate}/sec | ${row.homeP95Ms ?? "—"} | ${row.homeP99Ms ?? "—"} | ${row.httpErrorRate ?? "—"} | ${row.actualWarmupSeconds ?? "—"}/${row.configuredWarmupSeconds ?? "—"} sec |`).join("\n")
    : "| — | — | — | — | — |";
  const runtime = Object.entries(summary.runtimeBreakdownSeconds)
    .map(([name, value]) => `| ${name} | ${value} |`).join("\n") || "| — | — |";
  const resources = summary.levels.length ? summary.levels.map((row) =>
    `| ${row.rate}/sec | ${row.resources?.postgresCpuPercent ?? "—"} | ${row.resources?.nodeCpuPercent ?? "—"} | ${row.resources?.redisCpuPercent ?? "—"} | ${row.resources?.dbPoolWaitP99Ms ?? "—"} | ${row.resources?.eventLoopP99Ms ?? "—"} |`).join("\n") :
    "| — | — | — | — | — | — |";
  const queues = summary.levels.length ? summary.levels.map((row) =>
    `| ${row.rate}/sec | ${row.queueGrowth ?? "—"} | ${row.resources?.queueInsertRate ?? "—"} | ${row.resources?.queueProcessRate ?? "—"} |`).join("\n") :
    "| — | — | — | — |";
  const sqlFingerprint = (value) => String(value || "—").replace(/\s+/g, " ")
    .replaceAll("|", "\\|").replaceAll("`", "'").slice(0, 240);
  const topSql = summary.levels.flatMap((row) => (row.resources?.topSql || []).map((sql) =>
    `| ${row.rate}/sec | ${sql.queryId ?? "—"} | ${sql.calls ?? "—"} | ${sql.totalExecMs ?? "—"} | ${sql.meanExecMs ?? "—"} | ${sql.sharedBlocksHit ?? "—"}/${sql.sharedBlocksRead ?? "—"}/${sql.tempBlocksWritten ?? "—"} | \`${sqlFingerprint(sql.normalizedQuery)}\` |`)).join("\n") ||
    "| — | — | — | — | — | — | — |";
  const warnings = [...summary.warnings];
  if (summary.runtimeBudgetWarning) warnings.unshift("RUNTIME BUDGET WARNING: scan exceeded 20 minutes.");
  return `# Bara Home Capacity — ${summary.runId}\n\n` +
    `Status: ${summary.status}; mode: ${summary.mode}; cache: ${summary.cacheMode}; background: ${summary.backgroundMode}.\n\n` +
    `Workload: ${summary.workload?.name || "unknown"}@${summary.workload?.profileVersion || "unknown"}; ` +
    `dataset: ${summary.dataset || "unknown"}.\n\n` +
    `Fixture score shape: ${summary.fixtureProfile?.scoreShape || "unknown"}; ` +
    `aggregate source: ${profile?.source || "unknown"}; fallback used: ${profile?.fallbackUsed ?? "unknown"}.\n\n` +
    `- Highest passing rate: ${summary.highestPassingRate ?? "unavailable"}/sec\n` +
    `- First failing rate: ${summary.firstFailingRate ?? "unavailable"}/sec\n` +
    `- Headroom policy: ${summary.headroomPolicy == null ? "unavailable" : `${summary.headroomPolicy * 100}%`}\n` +
    `- Calculated headroom target: ${summary.calculatedHeadroomTarget ?? "unavailable"}/sec\n` +
    `- Safe-capacity candidate tested: ${summary.safeCapacityCandidateTested ?? "unavailable"}/sec\n` +
    `- Safe operating capacity: ${summary.safeHomeOpensPerSecond ?? "unavailable"}/sec\n` +
    `${summary.safeCapacityUnavailableReason ? `- Safe-capacity unavailable reason: ${summary.safeCapacityUnavailableReason}\n` : ""}` +
    `- Total runtime: ${summary.scanRuntimeSeconds ?? "unavailable"} sec\n\n` +
    `## FIRST FAILURE\n\n${failureSentence(summary)}\n\n` +
    `## PRIMARY BOTTLENECK\n\n${displayBottleneck(summary.primaryBottleneck)}. This is an evidence-based subsystem inference, separate from the failed capacity criterion.\n\n` +
    `## Rate classifications\n\n| Rate | Classification | Votes |\n|---:|---|---|\n${classifications}\n\n` +
    `## Level measurements\n\n| Rate | Home p95 ms | Home p99 ms | HTTP error rate | Warmup actual/configured |\n|---:|---:|---:|---:|---:|\n${levels}\n\n` +
    `## Resource evidence\n\n| Rate | PostgreSQL CPU % | Node CPU % | Redis CPU % | DB pool wait p99 ms | Event-loop p99 ms |\n|---:|---:|---:|---:|---:|---:|\n${resources}\n\n` +
    `## Queue evidence\n\n| Rate | Growth items/sec | Insert rate | Process rate |\n|---:|---:|---:|---:|\n${queues}\n\n` +
    `## Top SQL\n\n| Rate | Query ID | Calls | Total exec ms | Mean exec ms | Shared hit/read/temp written | Normalized fingerprint |\n|---:|---|---:|---:|---:|---:|---|\n${topSql}\n\n` +
    `## Runtime breakdown\n\n| Phase | Seconds |\n|---|---:|\n${runtime}\n\n` +
    `## Environment binding\n\n\`\`\`json\n${JSON.stringify(summary.environmentBinding, null, 2)}\n\`\`\`\n\n` +
    `## Fixture profile evidence\n\n\`\`\`json\n${JSON.stringify(summary.fixtureProfile, null, 2)}\n\`\`\`\n\n` +
    `## Warnings\n\n${warnings.length ? warnings.map((row) => `- ${row}`).join("\n") : "None."}\n\n` +
    `## Limitations\n\n${summary.limitations.length ? summary.limitations.map((row) => `- ${row}`).join("\n") : "None recorded."}\n`;
}

function atomicWrite(file, contents) {
  if (fs.existsSync(file)) throw new Error(`report already exists: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeReports({ directory, input }) {
  const summary = buildSummary(input);
  const manifestPath = path.join(directory, "manifest.json");
  const summaryPath = path.join(directory, "summary.json");
  const reportPath = path.join(directory, "report.md");
  atomicWrite(manifestPath, `${JSON.stringify(buildManifest(input), null, 2)}\n`);
  atomicWrite(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  atomicWrite(reportPath, renderReport(summary));
  return { summary, manifestPath, summaryPath, reportPath };
}

module.exports = { atomicWrite, buildManifest, buildSummary, renderReport, writeReports };
