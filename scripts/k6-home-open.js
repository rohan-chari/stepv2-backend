#!/usr/bin/env node

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { classifyTarget, PROFILES } = require("../src/modules/loadTesting/contract");
const { cleanupHomeOpenFixtures, createHomeOpenFixtures } = require("../src/modules/loadTesting/homeOpenFixtures");
const { assertCapacityRunProfile, assertStartedRun } = require("../src/modules/loadTesting/lifecycle");
const { assertCapacityDatabase } = require("../src/localCapacitySafety");
const { capacityResourcePlan, inspectVmResources } = require("./lima-capacity");

const HOME_OPEN_EXECUTION_FILES = Object.freeze([
  "scripts/k6/home-open.js", "scripts/k6-home-open.js", "scripts/lima-capacity.js",
  "scripts/home-capacity-workflow.js", "scripts/capacity-metrics.js",
  "package.json", "package-lock.json",
  "src/modules/loadTesting/homeCapacityEnvironment.js",
  "scripts/capacity-process.js", "src/app.js", "src/db.js", "src/index.js",
  "src/modules/races/jobs/raceResolutionQueueV2.js",
  "src/modules/races/models/raceResolutionJobV2.js",
  "src/shared/observability/capacityResolutionReadiness.js",
  "src/modules/loadTesting/contract.js", "src/modules/loadTesting/runner.js",
  "src/modules/loadTesting/fixtures.js", "src/modules/loadTesting/homeOpenFixtures.js",
  "docs/home-open-capacity-baseline-requirements.md",
  "docs/home-open-resolution-throughput-requirements.md",
  "docs/home-open-capacity-workflow-simplification-requirements.md",
  "docs/capacity-load-runbook.md",
  "test/modules/loadTesting/homeCapacityWorkflow.test.js",
]);

function argsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2).replaceAll("-", "_");
    result[key] = argv[index + 1] == null || argv[index + 1].startsWith("--")
      ? true : argv[++index];
  }
  return result;
}

function required(value, name) {
  if (!String(value || "").trim()) throw new Error(`${name} is required`);
  return String(value);
}

function positiveInt(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 0 through ${maximum}`);
  }
  return parsed;
}

function applyGuardedCapacityEnvironment(config, runId, environment = process.env) {
  if (environment.CAPACITY_MODE !== "true" || environment.CAPACITY_OUTBOUND_DISABLED !== "true") {
    throw new Error("home-open k6 requires CAPACITY_MODE=true with outbound providers disabled");
  }
  const dbName = config.db_name || "steps_tracker_capacity";
  if (dbName !== "steps_tracker_capacity") throw new Error("home-open only accepts steps_tracker_capacity");
  const password = required(environment.CAPACITY_DB_PASSWORD, "CAPACITY_DB_PASSWORD");
  const redisPassword = required(environment.CAPACITY_REDIS_PASSWORD, "CAPACITY_REDIS_PASSWORD");
  const authSecret = required(environment.CAPACITY_AUTH_SECRET, "CAPACITY_AUTH_SECRET");
  required(environment.CAPACITY_DB_MARKER, "CAPACITY_DB_MARKER");
  environment.CAPACITY_RUN_ID = runId;
  environment.CAPACITY_GLOBAL_EVENT_PROFILE = "home-open";
  environment.CAPACITY_DB_NAME = dbName;
  environment.CAPACITY_DB_HOST_ALLOWLIST = "127.0.0.1";
  environment.SESSION_TOKEN_SECRET = authSecret;
  environment.DATABASE_URL = `postgresql://${encodeURIComponent(config.db_user || "capacity")}:${encodeURIComponent(password)}@127.0.0.1:${config.db_host_port || 55433}/${dbName}`;
  environment.REDIS_URL = `redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:6379/0`;
  environment.CACHE_ENV_PREFIX = `capacity:${runId}:`;
  assertCapacityDatabase(environment.DATABASE_URL, environment);
  return environment;
}

function validateCapacity(config, args, environment = process.env) {
  const runId = required(args.run_id || config.run_id, "run id");
  const directory = path.resolve(required(args.capacity_state_dir || config.directory, "capacity state directory"));
  const workflow = workflowLevelAuthorization({ args, config, runId });
  const state = workflow ? workflow.state : assertStartedRun({ runId, directory, env: environment });
  if (!workflow) assertCapacityRunProfile(state, "home-open");
  classifyTarget({ target: config.target || "capacity-vm", baseUrl: config.base_url,
    databaseUrl: environment.DATABASE_URL });
  if ((config.database_pool_profile || "role-budget") !== "role-budget") {
    throw new Error("home-open requires exact 10/10/8/4 role-budget database pools");
  }
  const resources = capacityResourcePlan(config);
  if (JSON.stringify(resources) !== JSON.stringify({
    vmCpu: 7, vmMemoryGb: 12, backendCpu: 4, backendMemoryGb: 8,
    databaseCpu: 1, databaseMemoryGb: 2, redisCpu: 1, redisMemoryMb: 256,
    overheadCpu: 1, overheadMemoryMb: 1792,
  })) throw new Error("home-open requires the approved 7-vCPU/12-GiB containing resource plan");
  return { runId, directory, state, resources, workflow };
}

function immutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function hash(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function workflowLevelAuthorization({ args, config, runId }) {
  if (!args.workflow_manifest && !args.workflow_child_event) return null;
  if (!args.workflow_manifest || !args.workflow_child_event) {
    throw new Error("workflow Home level requires both manifest and selected-child event");
  }
  const manifestPath = path.resolve(args.workflow_manifest);
  const eventPath = path.resolve(args.workflow_child_event);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const { hash: manifestHash, ...manifestUnsigned } = manifest;
  const { hash: eventHash, ...eventUnsigned } = event;
  if (manifest.schema !== "home-capacity-workflow-manifest-v1" ||
      canonicalHash(manifestUnsigned) !== manifestHash) {
    throw new Error("workflow manifest hash is invalid");
  }
  if (event.schema !== "home-capacity-workflow-event-v1" || event.type !== "child-selected" ||
      canonicalHash(eventUnsigned) !== eventHash || event.manifestHash !== manifest.hash ||
      event.workflowId !== manifest.workflowId || event.payload?.childId !== runId ||
      !String(runId).startsWith(`${manifest.workflowId}-`)) {
    throw new Error("workflow selected-child authorization is invalid");
  }
  const kind = String(event.payload.kind);
  const expectedMode = kind === "smoke" ? "smoke" : kind === "boundary" ? "boundary" : "level";
  const rate = Number(args.rate || (kind === "smoke" ? 1 : config.arrival_rate));
  const repeat = Number(args.repeat || 1);
  const warmupSeconds = Number(args.warmup_seconds ?? 0);
  const measurementSeconds = Number(args.measurement_seconds);
  const timings = event.payload.timings || {};
  if (String(args.mode || "smoke") !== expectedMode || Number(event.payload.rate) !== rate ||
      Number(timings.warmupSeconds) !== warmupSeconds ||
      Number(timings.measurementSeconds) !== measurementSeconds ||
      Number(event.payload.repeat || 1) !== repeat ||
      kind !== "boundary" && repeat !== 1 || rate > manifest.policy.maxRate && rate !== 1) {
    throw new Error("workflow child mode/rate/timing is outside confirmed policy");
  }
  if (kind === "smoke" && (rate !== 1 || warmupSeconds !== 0 || measurementSeconds !== 60) ||
      kind === "discovery" && (warmupSeconds !== 30 || measurementSeconds !== 120) ||
      kind === "boundary" && (warmupSeconds !== 120 || measurementSeconds !== 600) ||
      kind === "level" && ![[30, 120], [120, 600]].some(([warmup, measurement]) =>
        warmupSeconds === warmup && measurementSeconds === measurement)) {
    throw new Error("workflow child timing does not match its confirmed mode");
  }
  const resetEvidencePath = path.resolve(required(config.workflow_reset_evidence,
    "workflow reset evidence"));
  const reset = JSON.parse(fs.readFileSync(resetEvidencePath, "utf8"));
  if (reset.schema !== "home-capacity-child-reset-v1" || reset.workflowId !== manifest.workflowId ||
      reset.childId !== runId || reset.redisKeysBeforeBackend !== 0 ||
      reset.snapshotHash !== manifest.snapshotHash || reset.migrationHash !== manifest.migrationHash ||
      !/^[a-f0-9]{64}$/.test(reset.appliedMigrationHash || "") ||
      !/^[a-f0-9]{64}$/.test(reset.migrationChecksumDriftHash || "") ||
      !/^[a-f0-9]{64}$/.test(reset.historicalRollbackHash || "") ||
      !/^[a-f0-9]{64}$/.test(reset.schemaFingerprint || "") ||
      !/^[a-f0-9]{64}$/.test(reset.childEffectiveEnvironmentHash || "") ||
      !/^[a-f0-9]{64}$/.test(reset.normalizedEffectiveEnvironmentHash || "")) {
    throw new Error("workflow reset evidence is not bound to the selected child");
  }
  if (canonicalHash(JSON.parse(fs.readFileSync(path.resolve(config.workflow_reset_evidence), "utf8"))) !==
      canonicalHash(reset) || crypto.createHash("sha256").update(fs.readFileSync(path.resolve(args.config))).digest("hex") !==
      reset.childConfigHash) {
    throw new Error("workflow child config/reset evidence changed after reset");
  }
  const { verifyJournal } = require("./home-capacity-workflow");
  const journal = verifyJournal({ directory: path.dirname(manifestPath), manifest });
  const selectedIndex = journal.events.findIndex((row) => row.hash === event.hash);
  if (selectedIndex < 0 || journal.events[selectedIndex + 1]?.type !== "child-started" ||
      journal.events[selectedIndex + 1]?.payload?.childId !== runId ||
      journal.events[selectedIndex + 1]?.payload?.childConfigHash !== reset.childConfigHash ||
      journal.events[selectedIndex + 1]?.payload?.resetEvidenceHash !== canonicalHash(reset)) {
    throw new Error("workflow child event is not an authorized started journal transition");
  }
  const approvedManifest = JSON.parse(fs.readFileSync(path.resolve(config.live_manifest), "utf8"));
  if (canonicalHash(approvedManifest) !== manifest.resourceManifestHash) {
    throw new Error("workflow live resource manifest changed after confirmation");
  }
  return { manifest, event, reset, state: {
    runId, profile: "home-open", state: "started", snapshotHash: manifest.snapshotHash,
    scrubAttestationHash: manifest.scrubAttestationHash,
    approvedManifest, liveManifestPath: path.resolve(config.live_manifest),
    backendCommit: manifest.commit, sourceBundleHash: manifest.sourceBundleHash,
    workflowManifestHash: manifest.hash, workflowResetEvidence: reset,
  } };
}

function executionBundleHash(root, files) {
  const digest = crypto.createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.resolve(root, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`executed source is missing: ${file}`);
    }
    digest.update(`${path.relative(root, absolute)}\0`);
    digest.update(fs.readFileSync(absolute));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function metric(summary, name, key, fallback = 0) {
  return Number(summary?.metrics?.[name]?.values?.[key] ?? fallback);
}

function percentile(values, quantile) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function resolutionEvidenceFromLog(log) {
  const parsedRows = String(log || "").split(/\r?\n/).flatMap((line) => {
    const start = line.indexOf("{");
    if (start < 0) return [];
    try {
      const row = JSON.parse(line.slice(start));
      return ["race_resolution_v2", "race_resolution_v2_claim"].includes(row?.event)
        ? [row] : [];
    } catch { return []; }
  });
  const observedClaims = parsedRows.filter((row) => row.event === "race_resolution_v2_claim");
  const observedTerminals = parsedRows.filter((row) => row.event === "race_resolution_v2");
  for (const row of observedClaims) {
    if (![2, 3].includes(row.schemaVersion) || !Number.isFinite(Date.parse(row.observedAt)) ||
        !Number.isFinite(Number(row.queueLagMs)) || typeof row.queuePriority !== "string" ||
        typeof row.attemptId !== "string" || !row.attemptId) {
      throw new Error("home-open resolution claim evidence is incomplete");
    }
  }
  for (const row of observedTerminals) {
    if (typeof row.attemptId !== "string" || !row.attemptId || row.schemaVersion !== 2 ||
        !Number.isFinite(Date.parse(row.observedAt)) || !Number.isFinite(Number(row.coreMs)) ||
        !Number.isFinite(Number(row.queueLagMs)) || typeof row.queuePriority !== "string" ||
        !row.queuePriority) {
      throw new Error("home-open resolution terminal evidence is incomplete");
    }
  }
  const claimIds = new Set(observedClaims.map((row) => row.attemptId));
  const terminalIds = new Set(observedTerminals.map((row) => row.attemptId));
  const claims = observedClaims.filter((row) => terminalIds.has(row.attemptId));
  const rows = observedTerminals.filter((row) => claimIds.has(row.attemptId));
  const leftCensoredTerminals = observedTerminals.filter((row) => !claimIds.has(row.attemptId)).length;
  const rightCensoredClaims = observedClaims.filter((row) => !terminalIds.has(row.attemptId)).length;
  const outcomes = {}; const plans = {}; const priorities = {}; const values = new Map();
  const add = (name, value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    if (!values.has(name)) values.set(name, []);
    values.get(name).push(Math.max(0, number));
  };
  for (const row of rows) {
    if (row.schemaVersion !== 2 || !Number.isFinite(Date.parse(row.observedAt)) ||
        !Number.isFinite(Number(row.coreMs)) || !Number.isFinite(Number(row.queueLagMs)) ||
        typeof row.queuePriority !== "string" || !row.queuePriority) {
      throw new Error("home-open resolution terminal evidence is incomplete");
    }
    const outcome = String(row.outcome || "unknown");
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    priorities[row.queuePriority] = (priorities[row.queuePriority] || 0) + 1;
    if (row.resolutionPlan) plans[row.resolutionPlan] = (plans[row.resolutionPlan] || 0) + 1;
    add("coreMs", row.coreMs); add("queueLagMs", row.queueLagMs);
    add("dirtyParticipantCount", row.dirtyParticipantCount);
    add("fullParticipantCount", row.fullParticipantCount);
    add("changedRows", row.changedRows);
    for (const [name, value] of Object.entries(row.phaseMs || {})) {
      if (!["transaction", "claimReadiness", "fullTriggerPromotion", "claim"].includes(name)) {
        add(name, value);
      }
    }
    for (const [name, value] of Object.entries(row.computePhaseMs || {})) add(`compute.${name}`, value);
  }
  const trend = (name) => ({ p50: percentile(values.get(name) || [], 0.5),
    p95: percentile(values.get(name) || [], 0.95),
    p99: percentile(values.get(name) || [], 0.99) });
  const nonPhaseMetrics = new Set([
    "coreMs", "queueLagMs", "dirtyParticipantCount", "fullParticipantCount", "changedRows",
  ]);
  const phases = Object.fromEntries([...values.keys()].filter((name) =>
    !nonPhaseMetrics.has(name)).sort().map((name) => [name, trend(name)]));
  const terminalCount = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  if (terminalCount !== claims.length || new Set(claims.map((row) => row.attemptId)).size !== claims.length ||
      new Set(rows.map((row) => row.attemptId)).size !== rows.length) {
    throw new Error(`home-open resolution claims/terminals do not reconcile (${claims.length}/${terminalCount})`);
  }
  const topLevelPhaseNames = [...values.keys()].filter((name) =>
    !name.startsWith("compute.") && !nonPhaseMetrics.has(name));
  const cumulativeTopLevelMs = Object.fromEntries(topLevelPhaseNames.map((name) =>
    [name, (values.get(name) || []).reduce((sum, value) => sum + value, 0)]));
  const cumulativeCoreMs = (values.get("coreMs") || []).reduce((sum, value) => sum + value, 0);
  const attributedMs = Object.values(cumulativeTopLevelMs).reduce((sum, value) => sum + value, 0);
  const clockToleranceMs = rows.length * 25;
  if (attributedMs > cumulativeCoreMs + clockToleranceMs) {
    throw new Error("home-open resolution phases exceed claim-to-outcome duration");
  }
  const scopeMetric = (name) => ({
    samples: (values.get(name) || []).length,
    total: (values.get(name) || []).reduce((sum, value) => sum + value, 0),
    ...trend(name),
  });
  const matchedSubsetReconciled = terminalCount === claims.length;
  return { schema: "home-open-resolution-evidence-v2", jobs: rows.length,
    claims: claims.length,
    terminalReconciled: matchedSubsetReconciled && leftCensoredTerminals === 0 && rightCensoredClaims === 0,
    matchedSubsetReconciled,
    terminalCount,
    windowCensorship: { leftCensoredTerminals, rightCensoredClaims },
    outcomes, plans, priorities, coreMs: trend("coreMs"), queueLagMs: trend("queueLagMs"),
    scope: { dirtyParticipantCount: scopeMetric("dirtyParticipantCount"),
      fullParticipantCount: scopeMetric("fullParticipantCount"),
      changedRows: scopeMetric("changedRows") },
    phases, attribution: { excludesOverlappingTransactionAggregate: true,
      computeBreakdownIsNested: true, cumulativeTopLevelMs,
      cumulativeCoreMs, clockToleranceMs,
      unattributedMs: Math.max(0, cumulativeCoreMs - attributedMs) } };
}

function capacityBackendLogCommand(config, since, binding = {}) {
  const instance = config.lima_instance || `step-capacity-${config.run_id}`;
  const container = config.backend_container || `${instance}-backend`;
  const logArgs = ["shell", instance, "docker", "logs", "--timestamps", "--since",
    new Date(since).toISOString()];
  if (binding.window?.endedAt) logArgs.push("--until", new Date(binding.window.endedAt).toISOString());
  logArgs.push(container);
  return logArgs;
}

function captureCapacityBackendLog(config, since, outputPath, evidencePath, binding = {}) {
  if (fs.existsSync(outputPath) || fs.existsSync(evidencePath)) {
    throw new Error("home-open resolution diagnostic artifact already exists");
  }
  const logArgs = capacityBackendLogCommand(config, since, binding);
  const result = spawnSync("limactl", logArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.error || result.status !== 0 || !log.trim()) {
    throw result.error || new Error(`capacity backend log capture failed (${result.status})`);
  }
  fs.writeFileSync(outputPath, log, { flag: "wx", mode: 0o600 });
  immutableJson(evidencePath, { ...resolutionEvidenceFromLog(log), binding: {
    runId: binding.runId,
    sourceTreeHash: binding.sourceTreeHash,
    snapshotHash: binding.snapshotHash,
    scrubAttestationHash: binding.scrubAttestationHash,
    window: { startedAt: new Date(since).toISOString(),
      endedAt: binding.window?.endedAt ? new Date(binding.window.endedAt).toISOString() : null,
      capturedAt: new Date().toISOString() },
  } });
}

function containerMemoryBytes(row) {
  const value = String(row?.MemUsage || row?.MemUsageBytes || "").split("/")[0].trim();
  const match = value.match(/^([0-9.]+)([KMG]i?B)$/i);
  if (!match) return Number.NaN;
  const multiplier = { kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2,
    gb: 1024 ** 3, gib: 1024 ** 3 }[match[2].toLowerCase()];
  return Number(match[1]) * multiplier;
}

function normalizeInfrastructure(metrics, { runId, repeat, startedAt, endedAt,
  poolMeasurementReset } = {}) {
  if (metrics?.schema !== "capacity-metrics-v2" || metrics.runId !== runId ||
      metrics.profile !== "home-open" || repeat != null && Number(metrics.repeat) !== Number(repeat) ||
      !Array.isArray(metrics.samples)) {
    throw new Error("home-open metrics provenance is incomplete");
  }
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const samples = metrics.samples.filter((row) => {
    const at = new Date(row.at).getTime(); return at >= start - 1500 && at <= end + 1500;
  }).sort((left, right) => new Date(left.at) - new Date(right.at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("home-open infrastructure window is invalid");
  }
  let telemetryComplete = samples.length >= Math.max(1, Math.floor((end - start) / 1000) - 2);
  for (let index = 1; index < samples.length; index += 1) {
    if (new Date(samples[index].at) - new Date(samples[index - 1].at) > 2500) telemetryComplete = false;
  }
  const required = ["http:0", "http:1", "resolution:0", "cron:0"];
  const resetProcesses = Object.values(poolMeasurementReset?.processes || {});
  // The reset endpoint shares one measurement id across the census. Per-role
  // stamps intentionally contain only pid/generation/start time.
  const resetMeasurementId = poolMeasurementReset?.measurementId;
  if (poolMeasurementReset?.schema !== "capacity-db-pool-measurement-census-v1" ||
      poolMeasurementReset.runId !== runId ||
      typeof resetMeasurementId !== "string" ||
      JSON.stringify(Object.keys(poolMeasurementReset.processes || {}).sort()) !==
        JSON.stringify(required.slice().sort()) || resetProcesses.some((row) =>
        ![row?.pid, row?.generation, row?.startedAtMs]
          .every((value) => typeof value === "number" && Number.isFinite(value)))) {
    throw new Error("home-open infrastructure DB-pool measurement epoch is missing");
  }
  let processCensusStable = samples.length > 0;
  const health = [];
  const firstPids = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(Number(sample.resolutionQueueLagMs))) {
      throw new Error("home-open infrastructure evidence missing finite queue lag");
    }
    if (!Number.isFinite(Number(sample.resolutionQueueDepth))) {
      throw new Error("home-open infrastructure evidence missing finite queue depth");
    }
    if (sample.databaseError || !Array.isArray(sample.containers) || sample.containers.length !== 3) {
      throw new Error("home-open infrastructure evidence missing exact container census");
    }
    const containerRoles = sample.containers.map((row) => String(row.Name || row.Container || ""));
    if (!["backend", "postgres", "redis"].every((role) => containerRoles.some((name) => name.endsWith(`-${role}`)))) {
      throw new Error("home-open infrastructure evidence missing named containers");
    }
    for (const row of sample.containers) {
      const cpu = Number(String(row.CPUPerc ?? row.CPUPercent ?? "").replace("%", ""));
      if (!Number.isFinite(containerMemoryBytes(row)) || !Number.isFinite(cpu)) {
        throw new Error("home-open infrastructure container evidence must be finite");
      }
    }
    const identities = new Set();
    for (const row of Object.values(sample.health || {})) {
      if (!row?.capacity) continue;
      const capacity = row.capacity;
      identities.add(`${capacity.process?.role}:${capacity.process?.instance}`);
      health.push(capacity);
      const identity = `${capacity.process?.role}:${capacity.process?.instance}`;
      const poolReset = poolMeasurementReset.processes[identity];
      if (!poolReset || capacity.dbPool?.measurementId !== resetMeasurementId ||
          Number(capacity.dbPool?.measurementGeneration) !== Number(poolReset.generation) ||
          Number(capacity.dbPool?.measurementStartedAtMs) !== Number(poolReset.startedAtMs) ||
          Number(capacity.process?.pid) !== Number(poolReset.pid)) {
        throw new Error(`home-open infrastructure DB-pool measurement epoch mismatch (${identity})`);
      }
      for (const value of [capacity.process?.pid, capacity.memory?.rss, capacity.dbPool?.waitMsP99,
        capacity.dbPool?.connectionFailures, capacity.dbPool?.waiting, capacity.dbPool?.max,
        capacity.eventLoop?.maxMs]) {
        if (!Number.isFinite(Number(value))) throw new Error("home-open infrastructure evidence must be finite");
      }
      const expectedPoolMax = { http: 10, resolution: 8, cron: 4 }[capacity.process.role];
      if (Number(capacity.dbPool.max) !== expectedPoolMax) processCensusStable = false;
      if (!firstPids.has(identity)) firstPids.set(identity, String(capacity.process.pid));
      else if (firstPids.get(identity) !== String(capacity.process.pid)) processCensusStable = false;
      if (capacity.runId !== runId || capacity.globalEventProfile !== "home-open") telemetryComplete = false;
    }
    if (identities.size !== required.length || !required.every((identity) => identities.has(identity))) {
      processCensusStable = false;
    }
  }
  const rssCeilings = { http: 1200 * 1024 ** 2, resolution: 600 * 1024 ** 2, cron: 600 * 1024 ** 2 };
  const processMemoryWithinLimits = health.length > 0 && health.every((row) =>
    Number(row.memory?.rss) < (rssCeilings[row.process?.role] || 0));
  const containerPeaks = {};
  const containerCpuPeaks = {};
  for (const sample of samples) for (const row of sample.containers || []) {
    const name = row.Name || row.Container || "unknown";
    containerPeaks[name] = Math.max(containerPeaks[name] || 0, containerMemoryBytes(row) || 0);
    containerCpuPeaks[name] = Math.max(containerCpuPeaks[name] || 0,
      Number(String(row.CPUPerc ?? row.CPUPercent).replace("%", "")) || 0);
  }
  return {
    telemetryComplete, processCensusStable, processMemoryWithinLimits,
    dbPoolWaitP99Ms: Math.max(...health.map((row) => Number(row.dbPool.waitMsP99))),
    poolCheckoutFailures: Math.max(...health.map((row) => Number(row.dbPool.connectionFailures))),
    maxEventLoopDelayMs: Math.max(...health.map((row) => Number(row.eventLoop.maxMs))),
    containerPeakMemoryBytes: containerPeaks,
    containerPeakCpuPercent: containerCpuPeaks,
    recoveredAfterLoad: samples.length >= 5 && samples.slice(-5).every((sample) =>
      Object.values(sample.health).every((row) => Number(row.capacity.dbPool.waiting) === 0 &&
        Number(row.capacity.eventLoop.maxMs) < 1000) &&
      sample.containers.every((row) => Number(String(row.CPUPerc).replace("%", "")) < 100)),
  };
}

function generatorSample(pid) {
  try {
    const raw = execFileSync("ps", ["-o", "%cpu=,rss=", "-p", String(pid)], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }).trim();
    const [cpu, rssKb] = raw.split(/\s+/).map(Number);
    return { at: new Date().toISOString(), cpuPercent: cpu, rssBytes: rssKb * 1024 };
  } catch (error) {
    return { at: new Date().toISOString(), error: error.message };
  }
}

async function waitFor(child) {
  if (child.exitCode != null || child.signalCode != null) {
    if (child.exitCode === 0) return;
    throw new Error(`k6 exited ${child.exitCode ?? child.signalCode}`);
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() :
      reject(new Error(`k6 exited ${code ?? signal}`)));
  });
}

function createInFlightTracker(clock = Date.now) {
  const active = new Set();
  let firstAt = null; let lastAt = null; let areaMs = 0; let peak = 0;
  let started = 0; let completed = 0; let invalidEvents = 0;
  const advance = () => {
    const at = clock();
    if (lastAt != null) areaMs += active.size * Math.max(0, at - lastAt);
    if (firstAt == null) firstAt = at;
    lastAt = at;
  };
  return {
    start(id, phase) {
      if (phase !== "measured") return;
      advance();
      if (active.has(id)) { invalidEvents += 1; return; }
      active.add(id); started += 1; peak = Math.max(peak, active.size);
    },
    end(id, phase) {
      if (phase !== "measured") return;
      advance();
      if (!active.delete(id)) { invalidEvents += 1; return; }
      completed += 1;
    },
    summary() {
      if (active.size > 0) advance();
      const elapsedMs = firstAt == null ? 0 : Math.max(1, lastAt - firstAt);
      return { source: "session-start-completion-counters", started, completed,
        activeAtClose: active.size, invalidEvents,
        average: areaMs / elapsedMs, peak,
        observerTransport: "host-loopback-http", observerRequests: started + completed,
        methodologyOverhead: "two synchronous host-loopback requests per measured Home session" };
    },
  };
}

async function startInFlightObserver() {
  const tracker = createInFlightTracker();
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || !["/start", "/end"].includes(request.url)) {
      response.writeHead(404).end(); return;
    }
    let raw = "";
    request.on("data", (chunk) => { if (raw.length < 4096) raw += chunk; });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw);
        tracker[request.url === "/start" ? "start" : "end"](String(body.sessionId), String(body.phase));
        response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}`, tracker,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function readK6Progress(address, baseUrl, runId, phase = "measurement") {
  const [metricsResponse, healthResponse] = await Promise.all([
    fetch(`http://${address}/v1/metrics`), fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }),
  ]);
  const payload = await metricsResponse.json();
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  if (!metricsResponse.ok) throw new Error(`k6 metrics API returned ${metricsResponse.status}`);
  const health = await healthResponse.json();
  const capacity = health.capacity || null;
  const infrastructureWarning = healthResponse.ok !== true || health.status !== "ok" || !capacity ||
    capacity.runId !== runId || capacity.globalEventProfile !== "home-open" ||
    !Number.isFinite(Number(capacity.dbPool?.waiting)) || Number(capacity.dbPool.waiting) > 0 ||
    !Number.isFinite(Number(capacity.eventLoop?.maxMs));
  return {
    ...progressFromMetricsRows(rows, phase),
    infrastructure: { warning: infrastructureWarning, health: health.status || "unknown", capacity },
  };
}

function progressFromMetricsRows(rows = [], phase = "measurement") {
  const sample = (name) => rows.find((row) => row?.id === name)?.attributes?.sample || {};
  // k6's REST schema emits JSON numbers. Do not coerce null/blank/boolean (or
  // strings) into plausible evidence; unavailable samples stay explicit null.
  const finiteOrNull = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const offered = sample(`home_open_sessions_offered{phase:${phase}}`);
  const completed = sample(`home_open_sessions_completed{phase:${phase}}`);
  const failed = sample(`home_open_sessions_failed_count{phase:${phase}}`);
  const latency = sample(`home_open_critical_ms{phase:${phase}}`);
  const errors = sample(`http_req_failed{phase:${phase},telemetry:sut}`);
  return {
    phase,
    offered: finiteOrNull(offered.count),
    completed: finiteOrNull(completed.count),
    failed: finiteOrNull(failed.count),
    latencyMs: { p95: finiteOrNull(latency["p(95)"]),
      p99: finiteOrNull(latency["p(99)"]) },
    errorRate: finiteOrNull(errors.rate),
  };
}

function resolutionHealthUrl(config = {}) {
  const url = new URL(required(config.base_url, "base_url"));
  url.port = "3010";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

function capacityRoleUrl(config, port, pathname) {
  const url = new URL(required(config.base_url, "base_url"));
  url.port = String(port);
  url.pathname = pathname;
  url.search = "";
  return url.toString();
}

async function resetCapacityDbPoolMeasurements(config, runId, measurementId, {
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maximumHttpAttempts = 40,
} = {}) {
  const pathname = "/internal/capacity/db-pool-measurement/reset";
  const headers = { Connection: "close", "X-Capacity-Run-Id": runId,
    "X-Capacity-Measurement-Id": measurementId };
  const processes = {};
  const resetOne = async (url, allowedIdentities) => {
    const response = await fetchImpl(url, { method: "POST", headers,
      signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    const identity = `${body?.process?.role}:${String(body?.process?.instance)}`;
    const measurement = body?.measurement;
    if (!response.ok || body?.schema !== "capacity-db-pool-measurement-reset-v1" ||
        body.runId !== runId || !allowedIdentities.has(identity) ||
        measurement?.id !== measurementId ||
        ![body.process?.pid, measurement?.generation, measurement?.startedAtMs]
          .every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`home-open DB-pool measurement reset evidence is invalid (${identity})`);
    }
    const stamp = { pid: body.process.pid, generation: measurement.generation,
      startedAtMs: measurement.startedAtMs };
    if (processes[identity] && JSON.stringify(processes[identity]) !== JSON.stringify(stamp)) {
      throw new Error(`home-open DB-pool measurement reset changed within epoch (${identity})`);
    }
    processes[identity] = stamp;
  };
  const httpUrl = capacityRoleUrl(config, 3000, pathname);
  for (let attempt = 0; attempt < maximumHttpAttempts &&
      (!processes["http:0"] || !processes["http:1"]); attempt += 1) {
    await resetOne(httpUrl, new Set(["http:0", "http:1"]));
    if (!processes["http:0"] || !processes["http:1"]) await wait(25);
  }
  if (!processes["http:0"] || !processes["http:1"]) {
    throw new Error("home-open DB-pool reset did not census both HTTP workers");
  }
  await resetOne(capacityRoleUrl(config, 3010, pathname), new Set(["resolution:0"]));
  await resetOne(capacityRoleUrl(config, 3011, pathname), new Set(["cron:0"]));
  return { schema: "capacity-db-pool-measurement-census-v1", runId,
    measurementId, processes };
}

async function waitForResolutionWorkerReady(config, runId, {
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  deadlineMs = 120_000,
  pollMs = 250,
  interrupted = () => false,
} = {}) {
  const url = resolutionHealthUrl(config);
  const began = Date.now();
  let lastState = "unreachable";
  while (Date.now() - began <= deadlineMs) {
    if (interrupted()) throw new Error("home-open resolution readiness wait interrupted");
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      const payload = response.ok ? await response.json() : null;
      const capacity = payload?.capacity;
      const readiness = capacity?.resolutionWorker;
      const evidenceMatches = capacity?.runId === runId &&
        capacity?.globalEventProfile === "home-open" &&
        capacity?.process?.role === "resolution" &&
        Number.isInteger(capacity?.process?.pid) && capacity.process.pid > 0 &&
        readiness && typeof readiness.ready === "boolean" &&
        typeof readiness.quietPeriodElapsed === "boolean" &&
        typeof readiness.oldQueueDrainedObserved === "boolean";
      if (evidenceMatches) {
        if (Number(readiness.effectiveConcurrency) !== 2) {
          throw new Error("home-open requires live resolution effective concurrency 2");
        }
        lastState = String(readiness.state || "unknown");
        if (readiness.ready === true && readiness.quietPeriodElapsed === true &&
            readiness.oldQueueDrainedObserved === true) {
          return { ...readiness, pid: capacity.process.pid };
        }
      } else {
        lastState = "invalid-evidence";
      }
    } catch (error) {
      lastState = error.message;
    }
    await wait(pollMs);
  }
  throw new Error(`home-open resolution worker was not ready before load (${lastState})`);
}

async function waitForResolutionQueueQuiescence(prisma, {
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  deadlineMs = 300_000,
  pollMs = 250,
  stableObservationsRequired = 2,
  interrupted = () => false,
} = {}) {
  const began = now();
  let stableObservations = 0;
  let observations = 0;
  let rows = [];
  while (now() - began <= deadlineMs) {
    if (interrupted()) throw new Error("home-open restored resolution queue wait interrupted");
    rows = await prisma.raceResolutionJobV2.findMany({
      select: { state: true, generation: true, processingGeneration: true },
    });
    observations += 1;
    const failed = rows.filter((row) => String(row.state).toUpperCase() === "FAILED");
    if (failed.length) {
      throw new Error(`home-open found ${failed.length} failed restored resolution jobs`);
    }
    const drained = rows.every((row) => String(row.state).toUpperCase() === "SUCCEEDED" &&
      Number(row.generation) === Number(row.processingGeneration));
    stableObservations = drained ? stableObservations + 1 : 0;
    if (stableObservations >= stableObservationsRequired) {
      return { drained: true, stableObservations, observations, jobCount: rows.length };
    }
    await wait(pollMs);
  }
  const pending = rows.filter((row) => String(row.state).toUpperCase() !== "SUCCEEDED" ||
    Number(row.generation) !== Number(row.processingGeneration)).length;
  throw new Error(`home-open restored resolution queue did not quiesce (${pending} pending)`);
}

async function waitForQueueDrain(prisma, raceIds, deadlineMs = 300_000) {
  const began = Date.now();
  let rows = [];
  do {
    rows = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: raceIds } },
      select: { state: true, generation: true, processingGeneration: true, updatedAt: true } });
    if (rows.some((row) => String(row.state).toUpperCase() === "FAILED")) break;
    if (rows.every((row) => String(row.state).toUpperCase() === "SUCCEEDED" &&
        Number(row.generation) === Number(row.processingGeneration))) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() - began < deadlineMs);
  const drained = rows.every((row) => String(row.state).toUpperCase() === "SUCCEEDED" &&
    Number(row.generation) === Number(row.processingGeneration));
  return { drained, drainSeconds: (Date.now() - began) / 1000,
    failedRows: rows.filter((row) => String(row.state).toUpperCase() === "FAILED").length };
}

function buildVerification({ summary, metrics, generatorSamples, rate, measurementSeconds,
  warmupSeconds, queue, infrastructure, provenance, topology, cleanup, inFlightEvidence } = {}) {
  const phase = "phase:measurement";
  const expected = rate * measurementSeconds;
  const trend = (name) => ({ p50: metric(summary, name, "med", Number.NaN),
    p95: metric(summary, name, "p(95)", Number.NaN),
    p99: metric(summary, name, "p(99)", Number.NaN) });
  const endpointSpecs = {
    "POST /steps/sync-v2": "sync-v2", "POST /steps": "legacy-steps",
    "POST /steps/samples": "legacy-samples", "GET /home/race-card": "home-race-card",
    "GET /races": "compact-races", "GET /home/suggested-races": "suggested-races",
    "GET /shop/catalog": "shop-catalog", "GET /friends": "friends-summary",
    "GET /auth/me": "auth-me", "GET /assets/manifest": "assets-manifest",
    "GET /steps/race-resolution/:jobId": "race-resolution",
    "GET /home/global-event-summary-work/:workId": "global-summary-work",
  };
  const endpoints = Object.fromEntries(Object.entries(endpointSpecs).map(([label, endpoint]) => {
    const requests = metric(summary, `http_reqs{endpoint:${endpoint},${phase}}`, "count", 0);
    return [label, {
      requests,
      observed: requests > 0,
      status: Object.fromEntries(["2xx", "3xx", "4xx", "5xx", "timeout"].map((status) =>
        [status, metric(summary,
          `home_open_endpoint_status{endpoint:${endpoint},status:${status},${phase}}`, "count", 0)])),
      latencyMs: requests > 0 ? trend(`http_req_duration{endpoint:${endpoint},${phase}}`) :
        { p50: 0, p95: 0, p99: 0 },
    }];
  }));
  const perSecond = Array.from({ length: measurementSeconds }, (_, second) => {
    const started = metric(summary, `home_open_sessions_started{${phase},second:${second}}`, "count", 0);
    return { second, offered: rate, started,
      dropped: rate - started,
      criticalComplete: metric(summary, `home_open_sessions_critical_complete{${phase},second:${second}}`, "count", 0),
      allSettled: metric(summary, `home_open_sessions_all_settled{${phase},second:${second}}`, "count", 0),
      failed: metric(summary, `home_open_sessions_failed_count{${phase},second:${second}}`, "count", 0),
      freshnessFailed: metric(summary,
        `home_open_sessions_freshness_failed_count{${phase},second:${second}}`, "count", 0) };
  });
  const result = {
    schema: "home-open-capacity-result-v1", provenance, fixtureTopology: topology, cleanup,
    parameters: { arrivalRatePerSecond: rate, warmupSeconds, measurementSeconds },
    sessions: {
      expected,
      offered: expected,
      started: metric(summary, `home_open_sessions_started{${phase}}`, "count"),
      late: metric(summary, `home_open_sessions_late{${phase}}`, "count"),
      dropped: metric(summary, `dropped_iterations{${phase}}`, "count"),
      criticalComplete: metric(summary, `home_open_sessions_critical_complete{${phase}}`, "count"),
      allSettled: metric(summary, `home_open_sessions_all_settled{${phase}}`, "count"),
      failed: metric(summary, `home_open_sessions_failed_count{${phase}}`, "count"),
      freshnessFailed: metric(summary,
        `home_open_sessions_freshness_failed_count{${phase}}`, "count"),
      failureReasons: Object.fromEntries(["critical", "manifest", "suggested",
        "resolution_not_settled", "global_summary_not_settled", "deadline"].map((reason) => [reason,
        metric(summary, `home_open_session_failure_reason{${phase},reason:${reason}}`, "count", 0)])),
      criticalHomeMs: trend(`home_open_critical_ms{${phase}}`),
      allHomeMs: trend(`home_open_all_ms{${phase}}`),
      schedulerLagMs: trend(`home_open_scheduler_lag_ms{${phase}}`),
      perSecond,
      averageInFlight: Number(inFlightEvidence?.average),
      peakInFlight: Number(inFlightEvidence?.peak),
      inFlightCounterEvidence: inFlightEvidence,
    },
    decisions: {
      syncRetries: metric(summary, "home_open_sync_retries", "count"),
      syncLegacyFallbacks: metric(summary, "home_open_sync_legacy_fallbacks", "count"),
      legacyStepRetries: metric(summary, "home_open_legacy_step_retries", "count"),
      presentationFallbacks: metric(summary, "home_open_presentation_fallbacks", "count"),
      friendsFallbacks: metric(summary, "home_open_friends_fallbacks", "count"),
      resolutionPolls: metric(summary, "home_open_resolution_polls", "count"),
      globalSummaryPolls: metric(summary, "home_open_global_summary_polls", "count"),
      globalSummaryCreatedRefetches: metric(summary,
        "home_open_global_summary_created_refetches", "count"),
    },
    generator: {
      iterations: metric(summary, `iterations{${phase}}`, "count"),
      quotaRejected: metric(summary,
        `home_open_sessions_quota_rejected{${phase}}`, "count", Number.NaN),
      droppedIterations: metric(summary, `dropped_iterations{${phase}}`, "count"),
      cpuPresent: generatorSamples.length > 0 && generatorSamples.every((row) => Number.isFinite(row.cpuPercent)),
      memoryPresent: generatorSamples.length > 0 && generatorSamples.every((row) => Number.isFinite(row.rssBytes)),
      vuUtilizationPresent: Number.isFinite(metric(summary, "vus_max", "max", Number.NaN)),
      peakCpuPercent: Math.max(0, ...generatorSamples.map((row) => Number(row.cpuPercent) || 0)),
      peakMemoryBytes: Math.max(0, ...generatorSamples.map((row) => Number(row.rssBytes) || 0)),
      networkErrors: metric(summary, `home_open_network_errors{${phase}}`, "count", Number.NaN),
    },
    summary: { errorRate: metric(summary, `http_req_failed{${phase},telemetry:sut}`, "rate",
      Number.NaN) },
    endpoints,
    queue: { ...queue, peakDepth: Math.max(...metrics.samples.map((row) =>
      Number(row.resolutionQueueDepth))), p95LagMs: percentile(metrics.samples.map((row) =>
      Number(row.resolutionQueueLagMs)), 0.95) },
    infrastructure,
  };
  try {
    const perSecondFreshnessFailures = result.sessions.perSecond.reduce((sum, row) =>
      sum + Number(row.freshnessFailed), 0);
    if (perSecondFreshnessFailures !== result.sessions.freshnessFailed) {
      throw new Error("home-open capacity gate failed: per-second freshness accounting");
    }
    if (Object.values(result.sessions.failureReasons).reduce((sum, value) => sum + value, 0) !==
        result.sessions.freshnessFailed) {
      throw new Error("home-open capacity gate failed: failure reason accounting");
    }
    // Keep the full application runner out of provider bootstrap. The reusable
    // environment does not have a database URL until after it has been safely
    // prepared; importing the runner earlier initializes DB-bound models.
    require("../src/modules/loadTesting/runner").assertHomeOpenGates(result);
    result.gates = { passed: true, safeOperatingCeilingEligible: true, failures: [] };
  } catch (error) {
    result.gates = { passed: false, safeOperatingCeilingEligible: false,
      failures: [error.message] };
  }
  return result;
}

function aggregateHomeOpenLadder(reports = [], { failureBound = null, maxRate = 500,
  failureReport = null } = {}) {
  if (!Array.isArray(reports) || !reports.length || reports.some((row) =>
    row?.schema !== "home-open-capacity-result-v1" ||
    !Number.isFinite(Number(row.parameters?.arrivalRatePerSecond)))) {
    throw new Error("home-open ladder aggregation requires valid result artifacts");
  }
  const hasWorkflowProvenance = reports.some((row) => row.provenance?.workflowManifestHash != null);
  if (hasWorkflowProvenance && (reports.length !== 3 || reports.map((row) =>
    Number(row.provenance?.repeat)).sort().join(",") !== "1,2,3")) {
    throw new Error("home-open workflow certification requires exactly three reports, one each for repeats 1, 2, and 3");
  }
  const runIds = reports.map((row) => row.provenance?.runId);
  if (runIds.some((runId) => typeof runId !== "string" || !runId) ||
      new Set(runIds).size !== runIds.length) {
    throw new Error("home-open ladder aggregation requires unique run IDs");
  }
  const binding = (row) => JSON.stringify({ backendCommit: row.provenance?.backendCommit,
    profileVersion: row.provenance?.profileVersion,
    scrubAttestationHash: row.provenance?.scrubAttestationHash,
    sourceTreeHash: row.provenance?.sourceTreeHash,
    snapshotHash: row.provenance?.snapshotHash, manifestHash: row.provenance?.manifestHash,
    liveManifestHash: row.provenance?.liveManifestHash, resources: row.provenance?.resources,
    actualVmResources: row.provenance?.actualVmResources });
  const expectedBinding = binding(reports[0]);
  const baseBindingComplete = (row) => [row.provenance?.backendCommit, row.provenance?.profileVersion,
    row.provenance?.scrubAttestationHash, row.provenance?.sourceTreeHash,
    row.provenance?.snapshotHash, row.provenance?.manifestHash]
    .every((value) => typeof value === "string" && value) &&
    Boolean(row.provenance?.resources && row.provenance?.actualVmResources);
  if (reports.some((row) => binding(row) !== expectedBinding ||
      !baseBindingComplete(row))) {
    throw new Error("home-open ladder aggregation provenance/resource mismatch");
  }
  const workflowBinding = (row) => JSON.stringify(Object.fromEntries([
    "workflowManifestHash", "sourceBundleHash", "reportVersion", "parityHash",
    "resourceManifestHash", "topologyHash", "effectiveEnvironmentHash", "migrationHash",
    "appliedMigrationHash", "migrationChecksumDriftHash", "historicalRollbackHash", "schemaFingerprint",
    "normalizedEffectiveEnvironmentHash",
  ].map((name) => [name, row.provenance?.[name]])));
  let expectedWorkflowBinding = null;
  const workflowReports = reports.filter((row) => row.provenance?.workflowManifestHash != null);
  if (workflowReports.length) {
    if (workflowReports.length !== reports.length) {
      throw new Error("home-open certification cannot mix workflow and standalone provenance");
    }
    expectedWorkflowBinding = workflowBinding(reports[0]);
    if (reports.some((row) => workflowBinding(row) !== expectedWorkflowBinding ||
        Object.values(JSON.parse(workflowBinding(row))).some((value) =>
          typeof value !== "string" || !value) || row.provenance?.mode !== "boundary" ||
        Number(row.parameters?.warmupSeconds) !== 120 ||
        Number(row.parameters?.measurementSeconds) !== 600)) {
      throw new Error("home-open certification workflow provenance/timing mismatch");
    }
  }
  const boundaryPasses = reports.filter((row) => row.provenance?.mode === "boundary" &&
    row.gates?.passed === true);
  const byRate = new Map();
  for (const row of boundaryPasses) {
    const rate = Number(row.parameters.arrivalRatePerSecond);
    const rows = byRate.get(rate) || []; rows.push(row); byRate.set(rate, rows);
  }
  const confirmed = [...byRate].filter(([, rows]) =>
    new Set(rows.map((row) => Number(row.provenance.repeat))).size === 3 &&
    [1, 2, 3].every((repeat) => rows.some((row) => Number(row.provenance.repeat) === repeat)))
    .sort(([left], [right]) => right - left);
  if (!confirmed.length) {
    throw new Error("home-open final report requires three passing boundary repeats");
  }
  const supported = confirmed[0][0];
  const supporting = confirmed[0][1];
  const confirmedMaxRate = Number(maxRate);
  if (!Number.isInteger(confirmedMaxRate) || confirmedMaxRate < 2 || confirmedMaxRate > 500) {
    throw new Error("home-open aggregation max rate is invalid");
  }
  const derivedFailure = reports.filter((row) => row.gates?.passed === false)
    .map((row) => Number(row.parameters?.arrivalRatePerSecond)).filter((rate) => rate > supported)
    .sort((left, right) => left - right)[0] ?? null;
  const observedFailure = failureBound == null ? derivedFailure : Number(failureBound);
  if (observedFailure != null && (!Number.isInteger(observedFailure) || observedFailure <= supported ||
      observedFailure > confirmedMaxRate)) throw new Error("home-open aggregation failure bound is invalid");
  if (failureReport) {
    if (failureReport.schema !== "home-open-capacity-result-v1" ||
        failureReport.gates?.passed !== false) {
      throw new Error("home-open failure report must be a verified failed report");
    }
    if (observedFailure == null ||
        Number(failureReport.parameters?.arrivalRatePerSecond) !== observedFailure) {
      throw new Error("home-open failure report must match the measured failure bound");
    }
    if (!baseBindingComplete(failureReport) || binding(failureReport) !== expectedBinding ||
        expectedWorkflowBinding != null && workflowBinding(failureReport) !== expectedWorkflowBinding) {
      throw new Error("home-open failure report certification binding mismatch");
    }
  }
  const lowerBoundOnly = observedFailure == null && supported === confirmedMaxRate;
  const maximum = (selector) => Math.max(...supporting.map(selector).map(Number).filter(Number.isFinite));
  const cpuPeak = (rows, suffix) => Math.max(0, ...rows.flatMap((row) =>
    Object.entries(row.infrastructure?.containerPeakCpuPercent || {})
      .filter(([name]) => name.endsWith(suffix)).map(([, value]) => Number(value) || 0)));
  const evidence = (rows, failed = false) => ({
    runIds: rows.map((row) => row.provenance?.runId || null),
    failedGates: [...new Set(rows.flatMap((row) => row.gates?.failures || []))],
    infrastructure: { backendCpuPeakPercent: cpuPeak(rows, "-backend"),
      databaseCpuPeakPercent: cpuPeak(rows, "-postgres"), redisCpuPeakPercent: cpuPeak(rows, "-redis"),
      dbPoolWaitP99Ms: Math.max(0, ...rows.map((row) => Number(row.infrastructure?.dbPoolWaitP99Ms) || 0)),
      eventLoopDelayMs: Math.max(0, ...rows.map((row) => Number(row.infrastructure?.maxEventLoopDelayMs) || 0)) },
    queue: { peakDepth: Math.max(0, ...rows.map((row) => Number(row.queue?.peakDepth) || 0)),
      p95LagMs: Math.max(0, ...rows.map((row) => Number(row.queue?.p95LagMs) || 0)),
      drainSeconds: Math.max(0, ...rows.map((row) => Number(row.queue?.drainSeconds) || 0)) },
    classification: failed ? "failing-boundary" : "passing-boundary",
  });
  const endpoints = supporting.flatMap((row) => Object.entries(row.endpoints || {}).map(([name, value]) =>
    ({ name, p95: Number(value.latencyMs?.p95), requests: Number(value.requests || 0) })))
    .filter((row) => Number.isFinite(row.p95) && row.requests > 0)
    .sort((left, right) => right.p95 - left.p95);
  return {
    schema: "home-open-capacity-final-v1",
    provedAtLeastHardCap: lowerBoundOnly && confirmedMaxRate === 500,
    highestCertifiedTestedRate: supported,
    measuredFailureBound: observedFailure,
    unresolvedBracket: observedFailure == null ? null : [supported, observedFailure],
    lowerBound: lowerBoundOnly ? supported : null,
    repeatableSupportedMaximumHomeOpensPerSecond: supported,
    safeOperatingCeilingHomeOpensPerSecond: observedFailure == null ? null : Math.floor(supported * 0.7),
    supportedHomeOpensPerMinute: supported * 60,
    boundaryRepeats: supporting.map((row) => ({ runId: row.provenance.runId || null,
      repeat: Number(row.provenance.repeat), rate: Number(row.parameters.arrivalRatePerSecond) })),
    inFlightSessions: { averageMaximum: maximum((row) => row.sessions.averageInFlight),
      peakMaximum: maximum((row) => row.sessions.peakInFlight) },
    latencyMs: { criticalHomeP95Worst: maximum((row) => row.sessions.criticalHomeMs.p95),
      allSettledP95Worst: maximum((row) => row.sessions.allHomeMs.p95) },
    endpointBottleneck: endpoints[0] || null,
    infrastructureBottleneck: {
      dbPoolWaitP99MsWorst: maximum((row) => row.infrastructure.dbPoolWaitP99Ms),
      eventLoopDelayMsWorst: maximum((row) => row.infrastructure.maxEventLoopDelayMs),
    },
    passingEvidence: evidence(supporting),
    failureEvidence: failureReport ? evidence([failureReport], true) : null,
    limitations: [
      "Home-only capacity is not whole-app concurrent-user capacity.",
      "Home opens per minute cannot be converted to DAU without an observed session-frequency model.",
      "The local capacity VM is production-shaped but not the production host.",
    ],
  };
}

function textReport(result) {
  return [
    `run=${result.provenance.runId} profile=home-open@${result.provenance.profileVersion}`,
    `backendCommit=${result.provenance.backendCommit} manifestHash=${result.provenance.manifestHash}`,
    `rate=${result.parameters.arrivalRatePerSecond} home-opens/s warmup=${result.parameters.warmupSeconds}s measured=${result.parameters.measurementSeconds}s`,
    `sessions expected=${result.sessions.expected} critical=${result.sessions.criticalComplete} all=${result.sessions.allSettled} dropped=${result.sessions.dropped}`,
    `criticalHomeMs p95=${result.sessions.criticalHomeMs.p95} p99=${result.sessions.criticalHomeMs.p99}`,
    `errors=${(result.summary.errorRate * 100).toFixed(3)}% dbPoolWaitP99Ms=${result.infrastructure.dbPoolWaitP99Ms}`,
    `globalEventIsolation total=${result.cleanup.globalEventIsolation.totalEventCount} active=${result.cleanup.globalEventIsolation.activeEventCount} summaryWork=${result.cleanup.globalEventIsolation.summaryWorkCount}`,
    `gate=${result.gates.passed ? "PASS" : "FAIL"}`,
  ].join("\n") + "\n";
}

async function executeHomeOpenLevel(input, dependencies = {}) {
  if (!input || typeof dependencies.execute !== "function") {
    throw new Error("single Home-open level requires an explicit guarded executor");
  }
  const report = await dependencies.execute(input);
  if (report?.schema !== "home-open-capacity-result-v1" ||
      report.provenance?.runId !== input.runId || typeof report.gates?.passed !== "boolean") {
    throw new Error("single Home-open executor did not return a verified per-level report");
  }
  return report;
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (String(args.mode || "") === "aggregate") {
    const files = required(args.reports, "--reports").split(",").map((file) => path.resolve(file.trim()));
    const result = aggregateHomeOpenLadder(files.map((file) => JSON.parse(fs.readFileSync(file, "utf8"))));
    const output = path.resolve(required(args.output, "--output"));
    immutableJson(output, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const configPath = path.resolve(required(args.config, "--config"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const runId = required(args.run_id || config.run_id, "run id");
  applyGuardedCapacityEnvironment(config, runId);
  const { state, resources, workflow } = validateCapacity(config, args);
  const actualVmResources = inspectVmResources(config.lima_instance || `step-capacity-${runId}`);
  if (actualVmResources.cpu !== resources.vmCpu || actualVmResources.memoryGb !== resources.vmMemoryGb ||
      actualVmResources.diskGb !== Number(config.vps_specs.disk_gb)) {
    throw new Error(`home-open actual VM resources differ from approved plan: ${JSON.stringify(actualVmResources)}`);
  }
  const mode = String(args.mode || "smoke");
  if (!["smoke", "level", "boundary"].includes(mode)) throw new Error("mode must be smoke, level, or boundary");
  const rate = positiveInt(args.rate || (mode === "smoke" ? 1 : config.arrival_rate), "rate", 500);
  if (rate < 1) throw new Error("rate must be at least 1");
  const warmupSeconds = positiveInt(args.warmup_seconds ?? (mode === "smoke" ? 0 : 120), "warmup seconds", 120);
  const measurementSeconds = positiveInt(args.measurement_seconds ?? (mode === "smoke" ? 120 : 600), "measurement seconds", 600);
  const warmupRate = positiveInt(args.warmup_rate ?? Math.max(1, Math.floor(rate / 2)), "warmup rate", 500);
  const repeat = positiveInt(args.repeat ?? 1, "repeat", 3);
  const approvedRates = new Set(PROFILES["home-open"].ladder.rates);
  if (!workflow && mode !== "smoke" && !approvedRates.has(rate) && mode !== "boundary") {
    throw new Error("level rate must be an approved Home-open ladder rate");
  }
  if (mode === "boundary" && (repeat < 1 || repeat > 3)) {
    throw new Error("boundary repeat must be 1, 2, or 3");
  }
  if (mode !== "boundary" && repeat !== 1) throw new Error("repeat applies only to boundary runs");
  if (mode !== "smoke" && warmupRate >= rate && !(workflow && rate === 1 && warmupRate === 1)) {
    throw new Error("warmup rate must be lower than measured rate");
  }
  if (!workflow && mode === "smoke" && (rate !== 1 || warmupSeconds !== 0 || measurementSeconds !== 120)) {
    throw new Error("smoke is fixed at 1 Home open/second for 120 seconds without warmup");
  }
  if (!workflow && mode !== "smoke" && (warmupSeconds !== 120 || measurementSeconds !== 600)) {
    throw new Error("ladder candidates require 120-second warmup and 600-second measurement");
  }
  const outputDir = path.resolve(args.output_dir ||
    path.join("results", "capacity", "home-open", runId));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const stem = `${runId}.home-open.${mode}.${rate}`;
  const summaryPath = path.join(outputDir, `${stem}.k6-summary.json`);
  const metricsPath = path.join(outputDir, `${stem}.metrics.json`);
  const topologyPath = path.join(outputDir, `${stem}.topology.json`);
  const generatorPath = path.join(outputDir, `${stem}.generator.json`);
  const reportPath = path.join(outputDir, `${stem}.json`);
  const textPath = path.join(outputDir, `${stem}.txt`);
  const backendLogPath = path.join(outputDir, `${stem}.backend.log`);
  const resolutionEvidencePath = path.join(outputDir, `${stem}.resolution.json`);
  const cleanupPath = path.join(outputDir, `${stem}.cleanup.json`);
  for (const file of [summaryPath, metricsPath, topologyPath, generatorPath, reportPath, textPath,
    backendLogPath, resolutionEvidencePath, cleanupPath]) {
    if (fs.existsSync(file)) throw new Error(`home-open artifact already exists: ${file}`);
  }
  const suppliedTemporary = process.env.HOME_OPEN_CREDENTIAL_TEMP_DIR;
  const temporary = suppliedTemporary ? path.resolve(suppliedTemporary) :
    fs.mkdtempSync(path.join(os.tmpdir(), `home-open-${runId}-`));
  if (!temporary.startsWith(`${os.tmpdir()}${path.sep}home-open-`) || !fs.existsSync(temporary)) {
    throw new Error("unsafe or missing Home credential temporary directory");
  }
  const fixturePath = path.join(temporary, "fixture.json");
  const prisma = require("../src/db").prisma;
  const sourceTreeHash = executionBundleHash(path.resolve(__dirname, ".."),
    HOME_OPEN_EXECUTION_FILES);
  const resolutionBinding = { runId, sourceTreeHash, snapshotHash: state.snapshotHash,
    scrubAttestationHash: state.scrubAttestationHash };
  let fixture;
  let metricsChild;
  let k6Child;
  let k6StartedAt;
  let inFlightObserver;
  let backendLogCaptured = false;
  let interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal = signal;
    if (k6Child?.exitCode == null) k6Child.kill("SIGINT");
    if (metricsChild?.exitCode == null) metricsChild.kill("SIGTERM");
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint); process.once("SIGTERM", onSigterm);
  try {
    const resolutionReadiness = await waitForResolutionWorkerReady(config, runId, {
      interrupted: () => interruptedSignal != null,
    });
    process.stdout.write(`${JSON.stringify({ event: "home_open_resolution_ready", runId,
      ...resolutionReadiness })}\n`);
    const startupQueueQuiescence = await waitForResolutionQueueQuiescence(prisma, {
      interrupted: () => interruptedSignal != null,
    });
    process.stdout.write(`${JSON.stringify({ event: "home_open_restored_queue_quiescent", runId,
      ...startupQueueQuiescence })}\n`);
    fixture = await createHomeOpenFixtures({ prisma, runId, users: 5000, arrivalRate: rate,
      env: process.env });
    immutableJson(topologyPath, fixture.topology);
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const sampleEnd = new Date(Date.now() - 10 * 60_000);
    const sampleStart = new Date(sampleEnd.getTime() - 10 * 60_000);
    immutableJson(fixturePath, {
      schema: "home-open-k6-fixture-v2", runId,
      runHash: hash(runId),
      client: { appVersion: "2.3.11", timezone: "America/New_York",
        releaseChannel: "prod", platform: "ios", localDate,
        headerProfile: PROFILES["home-open"].homeOpen.clientHeaderProfile,
        features: PROFILES["home-open"].homeOpen.clientFeatures },
      users: fixture.users.map((user, userIndex) => ({ userIndex, token: user.token,
        sampleStart: sampleStart.toISOString(), sampleEnd: sampleEnd.toISOString() })),
    });
    const poolMeasurementId = `${runId}:home-open:${mode}:${repeat}`;
    const poolMeasurementReset = await resetCapacityDbPoolMeasurements(
      config, runId, poolMeasurementId);
    const resolutionProcess = poolMeasurementReset.processes?.["resolution:0"];
    if (!resolutionProcess || resolutionProcess.pid !== resolutionReadiness.pid) {
      throw new Error("home-open resolution worker restarted between readiness and measurement reset");
    }
    const measurementReadiness = await waitForResolutionWorkerReady(config, runId, {
      deadlineMs: 5_000,
      interrupted: () => interruptedSignal != null,
    });
    if (measurementReadiness.pid !== resolutionReadiness.pid) {
      throw new Error("home-open resolution worker restarted before measured load");
    }
    process.stdout.write(`${JSON.stringify({ event: "home_open_db_pool_measurement_reset",
      ...poolMeasurementReset })}\n`);
    metricsChild = spawn(process.execPath, [path.resolve(__dirname, "capacity-metrics.js"),
      "--config", configPath, "--output", metricsPath], { stdio: "inherit", env: {
      ...process.env, CAPACITY_RUN_ID: runId, CAPACITY_GLOBAL_EVENT_PROFILE: "home-open",
      CAPACITY_REPEAT: args.repeat || "1",
    } });
    k6StartedAt = new Date();
    inFlightObserver = await startInFlightObserver();
    const k6Environment = {
      K6_BASE_URL: config.base_url,
      K6_FIXTURE_PATH: fixturePath,
      K6_SUMMARY_PATH: summaryPath,
      K6_HOME_RATE: String(rate),
      K6_HOME_WARMUP_RATE: String(warmupRate),
      K6_HOME_WARMUP_SECONDS: String(warmupSeconds),
      K6_HOME_MEASUREMENT_SECONDS: String(measurementSeconds),
      K6_HOME_INFLIGHT_URL: inFlightObserver.url,
    };
    const k6Arguments = Object.entries(k6Environment)
      .flatMap(([name, value]) => ["-e", `${name}=${value}`]);
    const k6ApiAddress = `127.0.0.1:${16600 + parseInt(hash(runId).slice(0, 4), 16) % 1000}`;
    const k6 = spawn("k6", ["run", "--address", k6ApiAddress, ...k6Arguments,
      path.resolve(__dirname, "k6/home-open.js")], {
      stdio: "inherit", env: { ...process.env, K6_BASE_URL: config.base_url,
        ...k6Environment,
      },
    });
    k6Child = k6;
    const generatorSamples = [];
    const sampleGenerator = () => generatorSamples.push(generatorSample(k6.pid));
    sampleGenerator();
    const generatorTimer = setInterval(sampleGenerator, 1000);
    const updateTimer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - k6StartedAt) / 1000);
      const boundedSessionSeconds = Math.ceil(
        PROFILES["home-open"].homeOpen.allSettledDeadlineMs / 1000) + 1;
      const progressPhase = warmupSeconds > 0 &&
        elapsedSeconds < warmupSeconds + boundedSessionSeconds ? "warmup" : "measurement";
      return readK6Progress(k6ApiAddress, config.base_url, runId, progressPhase)
      .then((progress) => process.stdout.write(`${JSON.stringify({ event: "home_open_progress",
        runId, rate, elapsedSeconds,
        ...progress, generator: generatorSamples.at(-1) })}\n`))
      .catch((error) => process.stdout.write(`${JSON.stringify({ event: "home_open_progress",
        runId, rate, elapsedSeconds: Math.floor((Date.now() - k6StartedAt) / 1000),
        offered: null, completed: null, failed: null, latencyMs: null, errorRate: null,
        infrastructure: { warning: true, evidenceError: error.message },
        generator: generatorSamples.at(-1) })}\n`));
    }, 60_000);
    let k6Error;
    try { await waitFor(k6); } catch (error) { k6Error = error; }
    clearInterval(generatorTimer); clearInterval(updateTimer);
    await inFlightObserver.close();
    const inFlightEvidence = inFlightObserver.tracker.summary();
    inFlightObserver = null;
    const queue = interruptedSignal ? { drained: false, drainSeconds: 0, failedRows: 0,
      interruption: interruptedSignal } :
      await waitForQueueDrain(prisma, fixture.races.map((race) => race.id));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    captureCapacityBackendLog(config, k6StartedAt, backendLogPath, resolutionEvidencePath,
      resolutionBinding);
    backendLogCaptured = true;
    const k6EndedAt = new Date();
    metricsChild.kill("SIGTERM");
    await waitFor(metricsChild);
    metricsChild = null;
    immutableJson(generatorPath, { schema: "home-open-generator-metrics-v1", runId,
      startedAt: k6StartedAt, endedAt: k6EndedAt, samples: generatorSamples });
    if (!fs.existsSync(summaryPath)) throw k6Error || new Error("k6 summary artifact is missing");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const metrics = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
    const cleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });
    fixture = null;
    const infrastructure = normalizeInfrastructure(metrics, { runId, repeat,
      startedAt: k6StartedAt, endedAt: k6EndedAt, poolMeasurementReset });
    const provenance = {
      schema: "home-open-capacity-binding-v1", runId, profile: "home-open",
      mode, repeat,
      profileVersion: PROFILES["home-open"].version,
      backendCommit: state.backendCommit || execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 10_000,
        killSignal: "SIGKILL" }).trim(),
      sourceTreeHash: state.sourceBundleHash || sourceTreeHash,
      sourceBundleHash: state.sourceBundleHash || null,
      workflowManifestHash: state.workflowManifestHash || null,
      workflowResetEvidence: state.workflowResetEvidence || null,
      reportVersion: workflow?.manifest?.reportVersion || null,
      parityHash: workflow?.manifest?.parityHash || null,
      resourceManifestHash: workflow?.manifest?.resourceManifestHash || null,
      topologyHash: workflow?.manifest?.topologyHash || null,
      effectiveEnvironmentHash: workflow?.manifest?.effectiveEnvironmentHash || null,
      migrationHash: workflow?.reset?.migrationHash || null,
      appliedMigrationHash: workflow?.reset?.appliedMigrationHash || null,
      migrationChecksumDriftHash: workflow?.reset?.migrationChecksumDriftHash || null,
      historicalRollbackHash: workflow?.reset?.historicalRollbackHash || null,
      schemaFingerprint: workflow?.reset?.schemaFingerprint || null,
      childEffectiveEnvironmentHash: workflow?.reset?.childEffectiveEnvironmentHash || null,
      normalizedEffectiveEnvironmentHash: workflow?.reset?.normalizedEffectiveEnvironmentHash || null,
      resolutionEvidenceHash: hash(fs.readFileSync(resolutionEvidencePath)),
      manifestHash: hash(state.approvedManifest), liveManifestHash: hash(fs.readFileSync(state.liveManifestPath)),
      snapshotHash: state.snapshotHash, scrubAttestationHash: state.scrubAttestationHash,
      resources, actualVmResources,
      resolutionReadiness,
      startupQueueQuiescence,
      poolMeasurementReset,
      k6ExitError: k6Error?.message || null,
    };
    const report = buildVerification({ summary, metrics, generatorSamples, rate,
      measurementSeconds, warmupSeconds, queue, infrastructure, provenance,
      topology: JSON.parse(fs.readFileSync(topologyPath, "utf8")), cleanup, inFlightEvidence });
    immutableJson(reportPath, report);
    fs.writeFileSync(textPath, textReport(report), { flag: "wx", mode: 0o600 });
    process.stdout.write(textReport(report));
    if (!report.gates.passed) throw new Error(`home-open level failed: ${report.gates.failures.join("; ")}`);
  } finally {
    process.removeListener("SIGINT", onSigint); process.removeListener("SIGTERM", onSigterm);
    if (k6Child && k6Child.exitCode == null) k6Child.kill("SIGKILL");
    if (inFlightObserver) await inFlightObserver.close().catch(() => {});
    if (metricsChild && metricsChild.exitCode == null) metricsChild.kill("SIGTERM");
    if (!backendLogCaptured && k6StartedAt) {
      try {
        captureCapacityBackendLog(config, k6StartedAt, backendLogPath, resolutionEvidencePath,
          resolutionBinding);
        backendLogCaptured = true;
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`home-open diagnostic capture failed: ${error.message}\n`);
      }
    }
    try {
      if (fixture?.manifest) {
        const earlyCleanup = await cleanupHomeOpenFixtures({ prisma, manifest: fixture.manifest });
        if (!fs.existsSync(cleanupPath)) immutableJson(cleanupPath, { schema: "home-open-host-cleanup-v1", runId,
          interruptedSignal, cleanup: earlyCleanup, temporaryPaths: [temporary], credentialsRetained: false });
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
      fs.rmSync(temporary, { recursive: true, force: true });
      if (!fs.existsSync(cleanupPath)) immutableJson(cleanupPath, { schema: "home-open-host-cleanup-v1", runId,
        interruptedSignal, cleanup: null, temporaryPaths: [temporary], credentialsRetained: false });
    }
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { HOME_OPEN_EXECUTION_FILES, aggregateHomeOpenLadder, applyGuardedCapacityEnvironment, buildVerification,
  capacityBackendLogCommand, captureCapacityBackendLog, createInFlightTracker, executionBundleHash, normalizeInfrastructure,
  progressFromMetricsRows, resetCapacityDbPoolMeasurements, validateCapacity, waitFor,
  executeHomeOpenLevel, resolutionEvidenceFromLog, waitForResolutionQueueQuiescence,
  waitForResolutionWorkerReady, workflowLevelAuthorization };
