#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prisma } = require("../src/db");
const { Pool } = require("pg");
const { createGlobalEventSyncFixture, cleanupGlobalEventSyncFixture, assertCapacityVmEndpoint, assertGlobalEventSyncFixtureCensus, assertGlobalEventSyncFixtureDatabase, normalizeGlobalEventSyncManifest } = require("../src/modules/loadTesting/globalEventSyncFixture");
const { buildIdempotencyKey, buildSyncBody, normalizeGlobalEventSyncConfig } = require("../src/modules/loadTesting/globalEventSyncProfiles");
const { buildSummary, csvPgStatStatements, deltaPgStatStatements, phaseRuntime, renderGlobalEventSyncReport, snapshotPgStatStatements, summarizeCapacityResources, outcomeAccounting, validateSamplerCoverage } = require("../src/modules/loadTesting/globalEventSyncAnalysis");
const { assertStartedRun, assertCapacityRunProfile, loadState } = require("../src/modules/loadTesting/lifecycle");
const { createCollector } = require("./capacity-metrics");
const { assertCapacityDatabaseMarker, assertOutboundDisabled } = require("../src/localCapacitySafety");
const sqlMap = require("../src/modules/loadTesting/globalEventSyncSqlMap.json");
const { applyProvider } = require("./capacity");
const lifecycle = require("../src/modules/loadTesting/lifecycle");

function args(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) { const token = argv[i].slice(2); const equals = token.indexOf("="); const key = (equals < 0 ? token : token.slice(0, equals)).replaceAll("-", "_"); out[key] = equals >= 0 ? token.slice(equals + 1) : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true); } return out; }
function loadConfig(parsed) {
  const file = parsed.config ? JSON.parse(fs.readFileSync(path.resolve(parsed.config), "utf8")) : {};
  const aliases = { run_id: "runId", matrix_id: "matrixId", base_url: "baseUrl", output_dir: "outputDir", capacity_state_dir: "capacityStateDirectory", control_users: "controlUsers", eligible_summary_count: "eligibleSummaryCount", participants_per_race: "participantsPerRace", races_per_user: "racesPerUser", race_sizes: "raceSizes", samples_per_participant: "samplesPerParticipant", sample_history_minutes: "sampleHistoryMinutes", powerup_event_density: "powerupEventDensity", arrival_rate: "arrivalRate", snapshot_hash: "snapshotHash", scrub_attestation_path: "scrubAttestationPath", scrub_attestation_hash: "scrubAttestationHash", dry_run: "dryRun" };
  const mapped = { ...file };
  for (const [key, value] of Object.entries(parsed)) if (key !== "config") mapped[aliases[key] || key] = value;
  if (typeof mapped.raceSizes === "string") mapped.raceSizes = mapped.raceSizes.split(",").filter(Boolean).map(Number);
  return mapped;
}
function required(value, name) { if (!value) throw new Error(`--${name} is required`); return value; }
function immutable(file, value) { if (fs.existsSync(file)) throw new Error(`artifact already exists: ${file}`); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); fs.linkSync(tmp, file); fs.unlinkSync(tmp); }
function immutableText(file, value) { if (fs.existsSync(file)) throw new Error(`artifact already exists: ${file}`); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.tmp-${process.pid}`; fs.writeFileSync(tmp, String(value), { mode: 0o600, flag: "wx" }); fs.linkSync(tmp, file); fs.unlinkSync(tmp); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function durationSeconds(value) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
  if (!match) throw new Error("duration must be expressed in seconds, minutes, or hours");
  return Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2].toLowerCase()]);
}

async function verifyCapacityTopology({ baseUrl, runId, profile = "global-event-sync", timeoutMs = 120_000 } = {}) {
  const root = new URL(baseUrl);
  const urls = [0, 1].map((instance) => { const url = new URL(root); url.port = root.port || "80"; url.pathname = "/health"; url.search = `?capacity_instance_probe=${instance}`; return url; });
  const roleUrl = (port) => { const url = new URL(root); url.port = String(port); url.pathname = "/health"; url.search = ""; return url; };
  const fetchJson = async (url) => { const response = await fetch(url, { headers: { Accept: "application/json", Connection: "close" }, signal: AbortSignal.timeout(2_000) }); if (!response.ok) throw new Error(`capacity readiness returned HTTP ${response.status}`); return response.json(); };
  const deadline = Date.now() + timeoutMs; let lastError;
  while (Date.now() < deadline) {
    try {
      const httpByIdentity = new Map();
      for (let probe = 0; probe < 20 && httpByIdentity.size < 2; probe += 1) { const row = await fetchJson(urls[probe % urls.length]); const identity = `${row.capacity?.process?.role}:${row.capacity?.process?.instance}`; if (identity === "http:0" || identity === "http:1") httpByIdentity.set(identity, row); }
      if (httpByIdentity.size < 2) throw new Error("capacity readiness did not observe both HTTP workers");
      const http = [httpByIdentity.get("http:0"), httpByIdentity.get("http:1")];
      const resolution = await fetchJson(roleUrl(3010)); const cron = await fetchJson(roleUrl(3011));
      const all = [...http, resolution, cron]; const identities = new Set(all.map((row) => `${row.capacity?.process?.role}:${row.capacity?.process?.instance}`));
      if (!["http:0", "http:1", "resolution:0", "cron:0"].every((identity) => identities.has(identity))) throw new Error("capacity readiness did not observe exactly the required worker identities");
      if (all.some((row) => row.capacity?.runId !== runId || row.capacity?.globalEventProfile !== profile)) throw new Error("capacity readiness identity mismatch");
      const httpPools = http.map((row) => Number(row.capacity?.dbPool?.max));
      const pool = { http0: httpPools[0], http1: httpPools[1], resolution: Number(resolution.capacity?.dbPool?.max), cron: Number(cron.capacity?.dbPool?.max) };
      if (pool.http0 !== 10 || pool.http1 !== 10 || pool.resolution !== 8 || pool.cron !== 4) throw new Error(`capacity pool topology mismatch: ${JSON.stringify(pool)}`);
      const resolutionReady = resolution.capacity?.resolutionWorker?.ready === true || resolution.capacity?.resolutionWorker?.state === "ready";
      if (!resolutionReady) throw new Error("resolution worker is not ready");
      return { ready: true, identities: [...identities].sort(), pool };
    } catch (error) { lastError = error; await sleep(500); }
  }
  throw new Error(`capacity topology readiness timed out: ${lastError?.message || "unknown error"}`);
}

function matrixOutputPaths(matrix) {
  return { manifest: path.join(matrix.outputDir, `${matrix.matrixId}.manifest.json`), state: path.join(matrix.outputDir, `${matrix.matrixId}.state.json`), summary: path.join(matrix.outputDir, `${matrix.matrixId}.summary.json`), csv: path.join(matrix.outputDir, `${matrix.matrixId}.summary.csv`), report: path.join(matrix.outputDir, `${matrix.matrixId}.report.md`) };
}

function writeMatrixState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, file);
}

function matrixCsv(summary) {
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return ["childId,scenario,repeat,state,p95Ms,postgresCpuMean", ...summary.children.map((row) => [row.childId, row.scenario, row.repeat, row.state, row.summary?.http?.latency?.p95 ?? row.summary?.http?.p95 ?? row.summary?.latency?.p95, row.summary?.telemetry?.resources?.postgresCpuPercent?.mean].map(quote).join(","))].join("\n") + "\n";
}

function matrixDryRun(matrix, output = process.stdout) {
  validateMatrixManifest(matrix);
  output.write(`Matrix ${matrix.matrixId} (${matrix.children.length} children)\n`);
  for (const child of matrix.children) output.write(`${child.childId}: planned -> restoring -> starting -> fixture-created -> warming -> measuring -> draining -> evidence-written -> stopped -> snapshot-restored\n`);
  return { dryRun: true, matrixId: matrix.matrixId, children: matrix.children.map((child) => child.childId), vmStarted: false };
}

function childConfig(config, matrix, child) {
  return { ...config, run_id: child.childId, directory: child.stateDir, profile: "global-event-sync", base_url: config.base_url || config.baseUrl, output_dir: child.outputDir, runId: child.childId };
}
function sanitizeCapacityConfig(config = {}) {
  const output = {};
  for (const [key, value] of Object.entries(config)) {
    if (/(password|secret|token|credential|private.?key|database.?url)/i.test(key)) output[key] = "[redacted]";
    else if (value && typeof value === "object" && !Array.isArray(value)) output[key] = sanitizeCapacityConfig(value);
    else output[key] = value;
  }
  return output;
}

async function runMatrixChild({ matrix, plan, config, tokens = {}, output, onActive = () => {} }) {
  const child = { ...plan, childId: plan.childId, stateDir: path.join(matrix.outputDir, "state"), outputDir: path.join(matrix.outputDir, plan.childId) };
  fs.mkdirSync(child.outputDir, { recursive: true, mode: 0o700 });
  const childStateFile = path.join(child.stateDir, `${child.childId}.state.json`);
  const existing = fs.existsSync(childStateFile) ? JSON.parse(fs.readFileSync(childStateFile, "utf8")) : { schema: "global-event-step-sync-matrix-child-v1", childId: child.childId, state: "planned", matrixId: matrix.matrixId, scenario: child.scenario, repeat: child.repeat };
  if (["complete", "snapshot-restored"].includes(existing.state)) return existing;
  if (["fixture-created", "warming", "measuring", "draining", "evidence-written", "stopped"].includes(existing.state)) {
    if (existing.state !== "stopped") writeMatrixState(childStateFile, { ...existing, state: "recovery-required", recovery: "restore snapshot before retry" });
    // A consumed fixture is never resumed. The force restore below is the
    // only path back to a new fixture for this child.
  }
  const childConfigPath = path.join(child.outputDir, "capacity-config.json");
  const effectiveConfig = childConfig(config, matrix, child);
  if (!fs.existsSync(childConfigPath)) immutable(childConfigPath, effectiveConfig);
  const sanitizedConfigPath = path.join(child.outputDir, `${child.childId}.sanitized-config.json`);
  if (!fs.existsSync(sanitizedConfigPath)) immutable(sanitizedConfigPath, { schema: "global-event-step-sync-sanitized-config-v1", childId: child.childId, config: sanitizeCapacityConfig(effectiveConfig) });
  const env = { ...process.env, CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true", CAPACITY_RUN_ID: child.childId, CAPACITY_STATE_DIR: child.stateDir, CAPACITY_GLOBAL_EVENT_PROFILE: "global-event-sync", CAPACITY_SCRUB_ATTESTATION_PATH: config.scrub_attestation_path || config.scrubAttestationPath || "", DATABASE_URL: config.database_url || process.env.DATABASE_URL || "" };
  assertCapacityDatabaseMarker({ env });
  assertOutboundDisabled(env);
  applyProvider(effectiveConfig, childConfigPath, env);
  env.CAPACITY_MODE = "true"; env.CAPACITY_OUTBOUND_DISABLED = "true"; env.CAPACITY_RUN_ID = child.childId; env.CAPACITY_STATE_DIR = child.stateDir;
  const snapshotPath = path.resolve(matrix.snapshot.path);
  let state = existing;
  const advance = (next, extra = {}) => { state = appendTransition(state, next, child.stateDir, extra); return state; };
  let fixture;
  try {
    if (state.state === "planned" || state.state === "failed" || state.state === "recovery-required") {
      advance("restoring");
      await lifecycle.preflight({ snapshotPath, profile: "global-event-sync", target: "capacity-vm", directory: child.stateDir, runId: child.childId });
      await lifecycle.restore({ runId: child.childId, directory: child.stateDir, snapshotPath, env, force: true });
      advance("starting");
      const verified = lifecycle.loadState(child.childId, child.stateDir);
      await lifecycle.start({ runId: child.childId, directory: child.stateDir, env, input: `START ${child.childId} ${verified.snapshotHash}`, interactive: true, liveManifestPath: config.live_manifest || config.liveManifest });
      onActive({ child, env, snapshotPath });
    } else if (["restoring", "starting"].includes(state.state)) {
      throw new Error(`child ${child.childId} interrupted before a safe restart; restore is required`);
    }
    const lifecycleState = lifecycle.loadState(child.childId, child.stateDir);
    if (lifecycleState.state !== "started") throw new Error(`child ${child.childId} did not reach started state`);
    const topology = await verifyCapacityTopology({ baseUrl: config.base_url || config.baseUrl, runId: child.childId });
    state = { ...state, topology };
    const scenario = matrix.scenarios.find((item) => item.name === child.scenario);
    const fixtureConfig = { ...matrix.fixture, profile: scenario.profile, overlap: scenario.overlap, seed: matrix.logicalFixtureSeeds[scenario.name], users: matrix.fixture.users || 2, controlUsers: matrix.fixture.controlUsers || 1, eligibleSummaryCount: matrix.fixture.eligibleSummaryCount || 1 };
    const fixtureResult = await createGlobalEventSyncFixture({ prisma, runId: child.childId, config: fixtureConfig, env });
    fixture = fixtureResult.manifest;
    const fixtureFile = path.join(child.outputDir, `${child.childId}.fixture.manifest.json`);
    const tokenFile = path.join(child.outputDir, `${child.childId}.fixture.tokens`);
    immutable(fixtureFile, { ...fixture, logicalFixtureHash: fixtureLogicalHash({ census: fixture.census, cohorts: fixture.cohorts, payloadExample: fixture.payloadExample, overlap: scenario.overlap }) });
    immutable(tokenFile, Object.fromEntries(fixtureResult.users.map((user) => [user.id, user.token])));
    await assertGlobalEventSyncFixtureCensus({ prisma, manifest: fixture });
    if (fixture.census.eligibleSummaryWork !== Number(fixtureConfig.eligibleSummaryCount)) throw new Error("fixture treatment eligibility census mismatch");
    const eligibleBefore = await prisma.globalEventSummaryWork.findMany({ where: { eventId: fixture.event.id, userId: { in: fixture.cohorts.treatmentUserIds } }, select: { id: true, userId: true, status: true, expiresAt: true }, orderBy: { userId: "asc" } });
    if (eligibleBefore.length !== Number(fixtureConfig.eligibleSummaryCount) || eligibleBefore.some((row) => row.status !== "WAITING_SYNC" || new Date(row.expiresAt) <= new Date(fixture.fixtureNow))) throw new Error("fixture treatment eligibility was not proven immediately before traffic");
    const eligibilityPath = path.join(child.outputDir, `${child.childId}.eligibility-before.json`);
    immutable(eligibilityPath, { schema: "global-event-step-sync-eligibility-v1", childId: child.childId, intent: scenario.intent, cohort: scenario.cohort, rows: eligibleBefore });
    advance("fixture-created", { fixtureManifest: fixtureFile, sanitizedConfig: sanitizedConfigPath, eligibility: eligibilityPath, topology, logicalFixtureHash: fixtureLogicalHash({ census: fixture.census, cohorts: fixture.cohorts, payloadExample: fixture.payloadExample, overlap: scenario.overlap }) });
    advance("warming", { warmupSeconds: Number(matrix.warmup.seconds) });
    await sleep(Number(matrix.warmup.seconds) * 1000);
    advance("measuring");
    const selectedCohort = child.scenario === "ordinary-sync" ? "control" : "treatment";
    const ids = selectedCohort === "control" ? fixture.cohorts.controlUserIds : fixture.cohorts.treatmentUserIds;
    const users = fixtureResult.users.filter((user) => ids.includes(user.id)).map((user) => ({ ...user, cohort: selectedCohort }));
    const result = await runProfile({ manifest: fixture, baseUrl: required(config.base_url || config.baseUrl, "base-url"), outputDir: child.outputDir, runId: child.childId, tokens: Object.fromEntries(fixtureResult.users.map((user) => [user.id, user.token])), metricsConfig: { ...config, base_url: config.base_url || config.baseUrl, lima_instance: config.lima_instance || config.limaInstance }, profile: scenario.profile, rate: scenario.rate, duration: scenario.duration, users, repeat: child.repeat, intent: scenario.intent, jitterMs: scenario.jitterMs || 0 });
    advance("draining");
    const pendingStatuses = ["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"];
    const drainStarted = Date.now(); let drained = false;
    for (let attempt = 0; attempt < 600; attempt += 1) { const pending = await prisma.globalEventSummaryWork.count({ where: { eventId: fixture.event.id, userId: { in: fixture.cohorts.treatmentUserIds }, status: { in: pendingStatuses } } }); if (!pending) { drained = true; break; } await sleep(100); }
    const eligibleAfter = await prisma.globalEventSummaryWork.findMany({ where: { eventId: fixture.event.id, userId: { in: fixture.cohorts.treatmentUserIds } }, select: { id: true, userId: true, status: true, finalRaceCount: true, requiredRaceCount: true }, orderBy: { userId: "asc" } });
    const correctnessPath = path.join(child.outputDir, `${child.childId}.correctness.json`);
    immutable(correctnessPath, { schema: "global-event-step-sync-correctness-v1", childId: child.childId, eligibilityBefore: eligibleBefore, eligibilityAfter: eligibleAfter, drained, drainTimeMs: Date.now() - drainStarted, terminal: eligibleAfter.every((row) => !pendingStatuses.includes(row.status)) });
    advance("evidence-written", { summary: path.join(child.outputDir, `${child.childId}.${scenario.profile}.r${child.repeat}.summary.json`), correctness: correctnessPath });
    await lifecycle.stop({ runId: child.childId, directory: child.stateDir, env });
    onActive(null);
    state = { ...state, state: "stopped", summary: result, artifacts: { outputDir: child.outputDir, fixtureManifest: fixtureFile, sanitizedConfig: sanitizedConfigPath, eligibility: eligibilityPath, correctness: correctnessPath } };
    writeMatrixState(childStateFile, state);
    await lifecycle.restore({ runId: child.childId, directory: child.stateDir, snapshotPath, env, force: true });
    state = { ...state, state: "snapshot-restored", completedAt: new Date().toISOString() };
    writeMatrixState(childStateFile, state);
    return state;
  } catch (error) {
    const failed = { ...state, state: "failed", failedAt: new Date().toISOString(), error: String(error?.message || error), evidenceMayBePartial: true, recovery: "VM must be stopped and snapshot restore proven before retry" };
    writeMatrixState(childStateFile, failed);
    try { const current = lifecycle.loadState(child.childId, child.stateDir); if (current.state === "started") await lifecycle.stop({ runId: child.childId, directory: child.stateDir, env }); } catch { /* preserve original failure */ }
    try { await lifecycle.restore({ runId: child.childId, directory: child.stateDir, snapshotPath, env, force: true }); } catch (restoreError) { failed.state = "recovery-required"; failed.recoveryError = String(restoreError?.message || restoreError); }
    onActive(null);
    writeMatrixState(childStateFile, failed);
    throw error;
  }
}

function readSnapshotInputs(config) {
  const snapshotPath = config.snapshot || config.snapshot_path;
  let metadata = config.snapshot_metadata || config.snapshotMetadata || {};
  if (typeof metadata === "string" && fs.existsSync(metadata)) metadata = JSON.parse(fs.readFileSync(metadata, "utf8"));
  if ((!metadata || typeof metadata !== "object" || !Object.keys(metadata).length) && snapshotPath && fs.existsSync(`${snapshotPath}.snapshot.json`)) metadata = JSON.parse(fs.readFileSync(`${snapshotPath}.snapshot.json`, "utf8"));
  const attestationPath = config.scrub_attestation_path || config.scrubAttestationPath || metadata.scrubAttestationPath;
  const sha256 = (file) => file && fs.existsSync(file) ? require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null;
  return { snapshotPath, snapshotHash: config.snapshot_hash || config.snapshotHash || metadata.sourceSnapshotHash || metadata.snapshotHash, attestationPath, attestationHash: config.scrub_attestation_hash || config.scrubAttestationHash || sha256(attestationPath) };
}

async function matrix({ config, matrixId, outputDir, repetitions = 3, dryRun = false, resume = false, output = process.stdout }) {
  const snapshotMeta = readSnapshotInputs(config);
  const destination = path.resolve(outputDir || config.output_dir || config.outputDir || path.join(process.cwd(), "results", matrixId));
  const expectedManifestPath = path.join(destination, `${matrixId}.manifest.json`);
  let matrix;
  if (fs.existsSync(expectedManifestPath)) {
    if (!resume) throw new Error(`matrix manifest already exists; pass --resume to continue without rerunning immutable children: ${expectedManifestPath}`);
    matrix = JSON.parse(fs.readFileSync(expectedManifestPath, "utf8"));
  } else {
    matrix = buildMatrixManifest({ matrixId, commit: config.commit || null, target: config.target || "capacity-vm", baseUrl: config.base_url || config.baseUrl, snapshot: { path: path.resolve(snapshotMeta.snapshotPath || ""), hash: snapshotMeta.snapshotHash }, attestation: { path: path.resolve(snapshotMeta.attestationPath || ""), hash: snapshotMeta.attestationHash }, scenarios: undefined, repetitions: Number(repetitions), fixture: config.fixture || { users: 2, controlUsers: 1, eligibleSummaryCount: 1 }, warmup: config.warmup || { seconds: 15 }, safety: config.safety, topology: config.topology, outputDir: destination });
    validateMatrixManifest(matrix);
    immutable(expectedManifestPath, matrix);
  }
  validateMatrixManifest(matrix);
  const paths = matrixOutputPaths(matrix);
  if (dryRun) return matrixDryRun(matrix, output);
  const stateFile = paths.state; let root = fs.existsSync(stateFile) && resume ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { schema: "global-event-step-sync-matrix-state-v1", matrixId, manifest: paths.manifest, children: matrix.children.map((child) => ({ ...child, state: "planned" })) };
  writeMatrixState(stateFile, root);
  const childResults = root.children.filter((child) => ["complete", "snapshot-restored"].includes(child.state) && child.summary).map((child) => ({ ...child, runId: child.childId }));
  let active = null;
  const signalHandler = async (signal) => {
    const recoveryPath = path.join(matrix.outputDir, `${matrix.matrixId}.recovery-required.json`);
    if (!fs.existsSync(recoveryPath)) immutable(recoveryPath, { schema: "global-event-step-sync-matrix-recovery-v1", matrixId, signal, childId: active?.child.childId || null, createdAt: new Date().toISOString(), instructions: "Verify the capacity VM is stopped and restore the approved disposable snapshot before resuming." });
    if (active) {
      try { const current = lifecycle.loadState(active.child.childId, active.child.stateDir); if (current.state === "started") await lifecycle.stop({ runId: active.child.childId, directory: active.child.stateDir, env: active.env }); await lifecycle.restore({ runId: active.child.childId, directory: active.child.stateDir, snapshotPath: active.snapshotPath, env: active.env, force: true }); } catch { /* recovery record is the durable handoff */ }
    }
    throw new Error(`matrix interrupted by ${signal}; see ${recoveryPath}`);
  };
  process.once("SIGINT", signalHandler); process.once("SIGTERM", signalHandler);
  try { for (const child of matrix.children) {
    let childResult;
    try {
      const result = await runMatrixChild({ matrix, plan: child, config, output, onActive: (value) => { active = value; } });
      childResult = { childId: child.childId, runId: child.childId, repeat: child.repeat, scenario: child.scenario, state: result.state === "snapshot-restored" ? "complete" : result.state, summary: result.summary, artifacts: result.artifacts };
    } catch (error) {
      const childStatePath = path.join(matrix.outputDir, "state", `${child.childId}.state.json`);
      const childState = fs.existsSync(childStatePath) ? JSON.parse(fs.readFileSync(childStatePath, "utf8")) : { state: "recovery-required", error: String(error?.message || error) };
      childResult = { childId: child.childId, runId: child.childId, repeat: child.repeat, scenario: child.scenario, state: childState.state, error: childState.error || String(error?.message || error), artifacts: childState.artifacts || {} };
      if (childState.state === "recovery-required") throw error;
    }
    childResults.push(childResult);
    root = { ...root, children: root.children.map((item) => item.childId === child.childId ? { ...item, ...childResult } : item) }; writeMatrixState(stateFile, root);
  } } finally { process.removeListener("SIGINT", signalHandler); process.removeListener("SIGTERM", signalHandler); }
  const aggregate = aggregateMatrixResults({ matrix, children: childResults });
  immutable(paths.summary, aggregate); immutable(paths.csv, matrixCsv(aggregate)); immutableText(paths.report, renderMatrixReport(aggregate));
  return aggregate;
}
function invokeGlobalEventK6({ baseUrl, runId, date, token, output }) {
  if (fs.existsSync(output)) throw new Error(`artifact already exists: ${output}`);
  const result = spawnSync(process.env.K6_BIN || "k6", ["run", "--summary-export", output, path.resolve(__dirname, "k6-global-event-sync.js")], {
    stdio: "inherit", env: { ...process.env, BASE_URL: baseUrl, CAPACITY_RUN_ID: runId,
      GLOBAL_EVENT_SYNC_PROFILE: "ordinary-sync", ARRIVAL_RATE: "1", DURATION: "1s", USERS: "1",
      SAMPLES_PER_SYNC: "2", SYNC_DATE: date, CAPACITY_TOKENS: token },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`global-event k6 exited with status ${result.status}`);
  return output;
}
function statusMetrics(metrics = {}) {
  const count = (name) => Number(metrics[name]?.values?.count ?? metrics[name]?.count ?? 0);
  const status = (code) => count(`global_event_sync_status_${code}`);
  const network = count("global_event_sync_network_failures");
  const timeout = count("global_event_sync_timeouts");
  const malformed = count("global_event_sync_malformed_responses");
  const buckets = { accepted202: status(202), conflict409: status(409), cooldown429: status(429), other4xx: 0, server5xx: count("global_event_sync_status_5xx") + status(500), networkFailure: Math.max(0, network - timeout), clientTimeout: timeout, malformedResponse: malformed, unexpectedStatus: 0 };
  for (const [name, value] of Object.entries(metrics)) {
    const match = name.match(/^global_event_sync_http_status(?:\{[^}]*status[=:](\d+)[^}]*\})?$/);
    if (!match) continue;
    if (!match[1]) continue;
    const code = Number(match[1]); const n = Number(value.values?.count ?? value.count ?? 0);
    if (code >= 400 && code < 500 && ![409, 429].includes(code)) buckets.other4xx += n;
    else if (code >= 500 && code < 600 && code !== 500) buckets.server5xx += n;
    else if (code === 0 || !code) buckets.networkFailure += n;
  }
  const iterations = count("iterations");
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  return { ...buckets, total, iterations, complete: iterations === 0 || total === iterations };
}
function runK6Profile({ baseUrl, runId, outputDir, manifest, tokens, profile, rate, duration, users, repeat = 1, intent, jitterMs = 0 }) {
  const output = path.join(outputDir, `${runId}.${profile}.r${repeat}.k6.json`);
  if (fs.existsSync(output)) throw new Error(`artifact already exists: ${output}`);
  const tokenValues = users.map((user) => tokens[user.id]).filter(Boolean);
  if (tokenValues.length !== users.length) throw new Error("k6 token census does not match selected users");
  const date = new Date(manifest.fixtureNow || manifest.createdAt).toISOString().slice(0, 10);
  const result = spawnSync(process.env.K6_BIN || "k6", ["run", "--summary-export", output, path.resolve(__dirname, "k6-global-event-sync.js")], {
    encoding: "utf8", env: { ...process.env, BASE_URL: baseUrl, CAPACITY_RUN_ID: runId, GLOBAL_EVENT_SYNC_PROFILE: profile, CAPACITY_COHORT: users[0]?.cohort || "treatment", CAPACITY_REQUEST_INTENT: intent || "background-sync", ARRIVAL_RATE: String(rate), DURATION: duration, USERS: String(users.length), USER_REUSE_INTERVAL_SECONDS: String(process.env.USER_REUSE_INTERVAL_SECONDS || 0), ONE_SHOT: String((Number(rate) * Number(String(duration).replace(/s$/, ""))) <= users.length), SAMPLES_PER_SYNC: String(manifest.payloadExample?.samples?.length || 12), SYNC_DATE: date, CAPACITY_REPEAT: String(repeat), JITTER_MS: String(jitterMs || 0), CAPACITY_TOKENS: tokenValues.join(",") },
  });
  fs.writeFileSync(path.join(outputDir, `${runId}.${profile}.r${repeat}.k6.log`), `${result.stdout || ""}\n${result.stderr || ""}`, { mode: 0o600, flag: "wx" });
  if (result.error) throw result.error;
  if (!fs.existsSync(output)) throw new Error("k6 did not produce its summary artifact");
  return { output, exitCode: result.status, summary: JSON.parse(fs.readFileSync(output, "utf8")), log: path.join(outputDir, `${runId}.${profile}.r${repeat}.k6.log`) };
}
function readBoundedErrorSamples(file, limit = 50) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.includes("CAPACITY_HTTP_ERROR ")).slice(0, limit).flatMap((line) => { try { const value = JSON.parse(line.slice(line.indexOf("{") )); return [{ status: Number(value.status) || 0, code: String(value.code || "").slice(0, 64), signature: String(value.error || value.message || "").replace(/[\r\n\t]+/g, " ").slice(0, 160) }]; } catch { return []; } });
}
async function runProfile({ manifest, baseUrl, outputDir, runId, tokens, metricsConfig, profile, rate, duration, users, repeat = 1, intent, jitterMs = 0 }) {
  if (normalizeGlobalEventSyncManifest(manifest).runId !== runId) throw new Error("run profile manifest identity mismatch");
  await assertGlobalEventSyncFixtureCensus({ prisma, manifest });
  await assertCapacityVmEndpoint(baseUrl, { runId, profile: process.env.CAPACITY_GLOBAL_EVENT_PROFILE || "global-event-sync" });
  const dbPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2_000 }) : null;
  let collector = null; const startedAt = Date.now(); let before = null; let after = null; let k6 = null; let metrics = null;
  try {
    collector = createCollector({ config: metricsConfig, output: path.join(outputDir, `${runId}.${profile}.r${repeat}.metrics.json`), provenance: { runId, profile, repeat } }); collector.start();
    before = await snapshotPgStatStatements(dbPool);
    collector.setPhase("measured");
    k6 = runK6Profile({ baseUrl, runId, outputDir, manifest, tokens, profile, rate, duration, users, repeat, intent, jitterMs });
    collector.setPhase("drain");
    after = await snapshotPgStatStatements(dbPool); metrics = collector; await collector.finish(); collector = null; await dbPool?.end();
    const beforeByQuery = new Map(before.rows.map((row) => [String(row.queryid), row]));
    const paired = after.rows.flatMap((row) => [beforeByQuery.get(String(row.queryid)) || { queryid: row.queryid }, row]);
    const delta = before.status === "available" && after.status === "available" ? deltaPgStatStatements(paired, { durationSeconds: Math.max(0.001, (Date.now() - startedAt) / 1000), sourceMap: sqlMap }) : [];
    const outcomes = statusMetrics(k6.summary.metrics || {});
    const iterations = Number(k6.summary.metrics?.iterations?.values?.count || 0);
    const coverage = validateSamplerCoverage(metrics.samples, { measuredDurationSeconds: durationSeconds(duration), minSamples: Math.max(1, Math.floor(durationSeconds(duration) - 1)) });
    const workloadFailureReasons = [];
    if (!outcomes.complete) workloadFailureReasons.push("incomplete_outcome_accounting");
    if (outcomes.server5xx) workloadFailureReasons.push("server5xx");
    if (outcomes.clientTimeout) workloadFailureReasons.push("client_timeout");
    const errorSamples = readBoundedErrorSamples(k6.log);
    const summary = buildSummary({ schema: "global-event-step-sync-run-summary-v1", runId, profile, repeat, startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), fixture: { census: manifest.census, selectedUsers: users.length, intendedUserIds: users.map((user) => user.id), logicalFixtureHash: manifest.logicalFixtureHash || null, materializedFixtureHash: manifest.materializedFixtureHash || null }, http: { outcomes: { ...outcomes, iterations }, errorSamples, k6ExitCode: k6.exitCode }, evidenceValid: coverage.valid && Boolean(manifest.logicalFixtureHash) && Boolean(manifest.materializedFixtureHash), workloadPassed: workloadFailureReasons.length === 0, k6ProcessSucceeded: k6.exitCode === 0, invalidityReasons: coverage.valid ? [] : ["insufficient_sampler_coverage"], workloadFailureReasons, telemetry: { pgStatStatements: { before, after, delta, status: before.status === "available" && after.status === "available" ? "available" : "unavailable" }, metricsArtifact: path.join(outputDir, `${runId}.${profile}.r${repeat}.metrics.json`), samplerCoverage: coverage }, runtime: phaseRuntime({ measuredLoad: Date.now() - startedAt }) });
    summary.telemetry.resources = summarizeCapacityResources(metrics.samples);
    immutable(path.join(outputDir, `${runId}.${profile}.r${repeat}.summary.json`), summary); immutable(path.join(outputDir, `${runId}.${profile}.r${repeat}.pg-statements.csv`), csvPgStatStatements(delta)); immutableText(path.join(outputDir, `${runId}.${profile}.r${repeat}.report.md`), renderGlobalEventSyncReport(summary));
    return summary;
  } catch (error) {
    if (collector) { metrics = collector; await collector.finish().catch(() => {}); collector = null; }
    if (!after) after = await snapshotPgStatStatements(dbPool).catch(() => ({ status: "unavailable", reason: "failure_snapshot_failed", rows: [], reset: null }));
    if (dbPool) await dbPool.end().catch(() => {});
    const beforeRows = before?.rows || []; const beforeByQuery = new Map(beforeRows.map((row) => [String(row.queryid), row])); const paired = (after?.rows || []).flatMap((row) => [beforeByQuery.get(String(row.queryid)) || { queryid: row.queryid }, row]); const delta = before?.status === "available" && after?.status === "available" ? deltaPgStatStatements(paired, { durationSeconds: Math.max(0.001, (Date.now() - startedAt) / 1000), sourceMap: sqlMap }) : [];
    const base = { schema: "global-event-step-sync-run-failure-v1", runId, profile, repeat, failedAt: new Date().toISOString(), error: String(error?.message || error), evidenceMayBePartial: true, telemetry: { pgStatStatements: { before, after, delta }, metricsArtifact: path.join(outputDir, `${runId}.${profile}.r${repeat}.metrics.json`) } };
    const failure = path.join(outputDir, `${runId}.${profile}.r${repeat}.failure.json`); if (!fs.existsSync(failure)) immutable(failure, base);
    const csv = path.join(outputDir, `${runId}.${profile}.r${repeat}.pg-statements.csv`); if (!fs.existsSync(csv)) immutable(csv, csvPgStatStatements(delta));
    const report = path.join(outputDir, `${runId}.${profile}.r${repeat}.report.md`); if (!fs.existsSync(report)) immutableText(report, `# Global-event step-sync run\n\nRun: ${runId}\n\nStatus: FAILED\n\nReason: ${base.error}\n\nEvidence may be partial: yes\n`);
    throw error;
  }
}
async function smoke({ manifest, baseUrl, outputDir, runId, tokens, metricsConfig = null, runK6 = false }) {
  manifest = normalizeGlobalEventSyncManifest(manifest);
  if (manifest.runId !== runId) throw new Error("smoke manifest run ID does not match requested run");
  if (process.env.CAPACITY_MODE === "true" || process.env.CAPACITY_MODE === "1") {
    await assertCapacityDatabaseMarker({ env: process.env });
    assertOutboundDisabled(process.env);
  }
  await assertGlobalEventSyncFixtureCensus({ prisma, manifest });
  const users = manifest.users || [];
  const controlUser = users.find((row) => row.cohort === "control");
  const treatmentUsers = users.filter((row) => row.cohort === "treatment").slice(0, Math.max(1, Number(process.env.CAPACITY_SMOKE_TREATMENT_USERS || 8)));
  const selected = [controlUser, ...treatmentUsers].filter(Boolean);
  if (!controlUser || treatmentUsers.length < 1) throw new Error("smoke requires control and treatment users in manifest");
  const selectedTreatment = treatmentUsers[0];
  const targetWork = await prisma.globalEventSummaryWork.findMany({
    where: { eventId: manifest.event.id, userId: { in: treatmentUsers.map((user) => user.id) } },
    select: { id: true },
  });
  const targetWorkIds = targetWork.map((row) => row.id);
  if (targetWorkIds.length !== treatmentUsers.length) throw new Error("smoke treatment cohort does not match summary-work census");
  // The lifecycle profile identifies this workflow (global-event-sync), while
  // the manifest profile identifies the traffic cohort. Verify the VM's
  // workflow identity separately so a scenario label cannot mask a wrong
  // backend process.
  await assertCapacityVmEndpoint(baseUrl, { runId, profile: process.env.CAPACITY_GLOBAL_EVENT_PROFILE || "global-event-sync" });
  const startedAt = Date.now(); const samples = [];
  const metricsPath = path.join(outputDir, `${runId}.smoke.metrics.json`);
  let collector = metricsConfig?.base_url && metricsConfig.capacityMetricsEnabled !== false
    ? createCollector({ config: metricsConfig, output: metricsPath, provenance: { runId, profile: manifest.profile || "eligible-overlap", repeat: 1 } }) : null;
  let dbPool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 }) : null;
  try {
    collector?.start();
  const { snapshotPgStatStatements } = require("../src/modules/loadTesting/globalEventSyncAnalysis");
  const pgBefore = await snapshotPgStatStatements(dbPool);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/steps/sync-v2`;
  const fixtureNow = new Date(manifest.fixtureNow || manifest.createdAt || Date.now());
  const request = async (user, index, key, body) => {
    const token = tokens?.[user.id]; if (!token) throw new Error(`smoke token missing for ${user.id}`);
    const at = Date.now();
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": key, "X-Step-Sync-Intent": "home-pull", "X-App-Version": "2.3.11", "X-Client-Features": "impact_summaries,impact_summary_expiry_v1", "X-Capacity-Run-Id": runId }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const parsed = await response.json().catch(() => null);
    return { response, parsed, at };
  };
  for (const [index, user] of [[0, controlUser]]) {
    const key = buildIdempotencyKey({ runId, repeat: 1, userId: user.id, iteration: index });
    const body = buildSyncBody({ date: fixtureNow.toISOString().slice(0, 10), now: fixtureNow, sampleCount: 2, seed: `${runId}:${user.id}` });
    const first = await request(user, index, key, body);
    if (first.response.status !== 202 || !first.parsed?.record?.id) throw new Error(`smoke sync failed for ${user.cohort}: HTTP ${first.response.status}`);
    samples.push({ userId: user.id, cohort: user.cohort, status: first.response.status, latencyMs: Date.now() - first.at, summaryReceipt: first.parsed?.globalEventSummaryWork ? { id: first.parsed.globalEventSummaryWork.id, state: first.parsed.globalEventSummaryWork.state } : null, syncRecordId: first.parsed.record.id });
  }
  const treatmentResults = await Promise.all(treatmentUsers.map(async (user, index) => {
    const key = buildIdempotencyKey({ runId, repeat: 1, userId: user.id, iteration: index + 1 });
    const body = buildSyncBody({ date: fixtureNow.toISOString().slice(0, 10), now: fixtureNow, sampleCount: 2, seed: `${runId}:${user.id}` });
    const first = await request(user, index + 1, key, body);
    if (first.response.status !== 202 || !first.parsed?.record?.id) throw new Error(`smoke sync failed for treatment: HTTP ${first.response.status}`);
    const duplicate = await request(user, index + 1, key, body);
    if (duplicate.response.status !== 202 || duplicate.parsed?.record?.id !== first.parsed.record.id) throw new Error(`smoke duplicate retry failed for treatment: HTTP ${duplicate.response.status}`);
    return { first, duplicate, user };
  }));
  for (const { first, duplicate, user } of treatmentResults) {
    samples.push({ userId: user.id, cohort: user.cohort, status: first.response.status, latencyMs: Date.now() - first.at, summaryReceipt: first.parsed?.globalEventSummaryWork ? { id: first.parsed.globalEventSummaryWork.id, state: first.parsed.globalEventSummaryWork.state } : null, syncRecordId: first.parsed.record.id });
    samples.push({ userId: user.id, cohort: user.cohort, duplicate: true, status: duplicate.response.status, syncRecordId: duplicate.parsed?.record?.id || null });
  }
  const k6Artifact = runK6 ? invokeGlobalEventK6({ baseUrl, runId, date: fixtureNow.toISOString().slice(0, 10), token: tokens[selected[0].id], output: path.join(outputDir, `${runId}.smoke.k6.json`) }) : null;
  let drain = { completed: false, elapsedMs: 0 };
  const drainStarted = Date.now();
  // Resolution is intentionally asynchronous; a smoke run must wait long
  // enough to prove the public request's capture work reaches a terminal
  // state, while remaining bounded for a hung queue.
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const pending = await prisma.globalEventSummaryWork.count({ where: { id: { in: targetWorkIds }, status: { in: ["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"] } } });
    const races = await prisma.raceResolutionJobV2.count({ where: { raceId: { in: manifest.ids.races || [] }, state: { in: ["QUEUED", "RUNNING"] } } });
    if (pending === 0 && races === 0) { drain = { completed: true, elapsedMs: Date.now() - drainStarted }; break; }
    await sleep(100);
  }
  drain.elapsedMs ||= Date.now() - drainStarted;
  const [work, artifacts, samplesCount, workRows, artifactRows, stepRows, summaries] = await Promise.all([prisma.globalEventSummaryWork.count({ where: { id: { in: targetWorkIds } } }), prisma.globalEventCaptureArtifact.count({ where: { workId: { in: targetWorkIds } } }), prisma.stepSample.count({ where: { userId: { in: manifest.ids.users || [] } } }), prisma.globalEventSummaryWork.findMany({ where: { id: { in: targetWorkIds } }, select: { id: true, userId: true, status: true, finalRaceCount: true, requiredRaceCount: true } }), prisma.globalEventCaptureArtifact.findMany({ where: { workId: { in: targetWorkIds } }, select: { id: true, workId: true, raceId: true } }), prisma.step.findMany({ where: { id: { in: manifest.ids.steps || [] } }, select: { id: true, userId: true, steps: true } }), prisma.globalEventUserSummary.findMany({ where: { eventId: manifest.event.id, userId: { in: [selectedTreatment.id] } }, select: { userId: true, extraRaceSteps: true, raceCount: true } })]);
  const pgAfter = await snapshotPgStatStatements(dbPool);
  if (pgBefore.status === "available" && pgAfter.status === "available" && Number(pgBefore.reset?.dealloc || 0) !== Number(pgAfter.reset?.dealloc || 0)) throw new Error("pg_stat_statements deallocation counter changed during smoke interval");
  const control = samples.find((row) => row.cohort === "control" && !row.duplicate);
  const treatment = samples.find((row) => row.cohort === "treatment" && !row.duplicate);
  const duplicate = samples.find((row) => row.duplicate);
  const result = buildSummary({ runId, profile: "smoke", startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(), correctness: { controlEnteredCapture: control?.summaryReceipt == null, treatmentEnteredCapture: treatment?.summaryReceipt != null, treatmentReceipt: treatment?.summaryReceipt || null, duplicateAccepted: duplicate?.status === 202, duplicateRecordMatches: duplicate?.syncRecordId === treatment?.syncRecordId, summaryWorkRowsRemaining: work, captureArtifacts: artifacts, captureArtifactUniqueness: new Set(artifactRows.map((row) => `${row.workId}:${row.raceId}`)).size === artifactRows.length, sampleRows: samplesCount, externalDeliveryDisabled: process.env.CAPACITY_OUTBOUND_DISABLED === "true" || process.env.CAPACITY_OUTBOUND_DISABLED === "1", drainCompleted: drain.completed, summaryTerminal: workRows.every((row) => ["CREATED", "ALL_ZERO", "UNSCORABLE", "EXPIRED_UNDELIVERED"].includes(row.status)), summaryRaceCounts: workRows.every((row) => row.status === "UNSCORABLE" ? Number(row.finalRaceCount) === 0 : Number(row.finalRaceCount) === Number(row.requiredRaceCount)) }, telemetry: { pgStatStatements: { before: pgBefore, after: pgAfter, status: pgBefore.status === "available" && pgAfter.status === "available" ? "available" : "unavailable" }, vm: collector ? { status: "available", artifact: metricsPath, samples: collector.samples.length } : { status: "unavailable", reason: "capacity metrics sampler not configured" }, queue: { summaryWorkRows: work, captureArtifacts: artifacts } }, samples: samples.map(({ userId, ...row }) => row), runtime: phaseRuntime({ measuredLoad: Date.now() - startedAt }) });
  result.correctness.treatmentClaimed = workRows.every((row) => row.status !== "WAITING_SYNC");
  result.correctness.treatmentWorkSuccess = workRows.length === treatmentUsers.length && workRows.every((row) => ["CREATED", "ALL_ZERO"].includes(row.status) && Number(row.finalRaceCount) === Number(row.requiredRaceCount));
  result.correctness.captureArtifactUniqueness = new Set(artifactRows.map((row) => `${row.workId}:${row.raceId}`)).size === artifactRows.length;
  result.correctness.fixtureStepRows = stepRows.length;
  result.correctness.summaryRows = summaries.length;
  const beforeByQuery = new Map(pgBefore.rows.map((row) => [String(row.queryid), row]));
  const pairedPgRows = pgAfter.rows.flatMap((row) => [beforeByQuery.get(String(row.queryid)) || { queryid: row.queryid }, row]);
  const pgDelta = pgBefore.status === "available" && pgAfter.status === "available" ? deltaPgStatStatements(pairedPgRows, { durationSeconds: Math.max(0.001, (Date.now() - startedAt) / 1000), sourceMap: sqlMap }) : [];
  result.telemetry.pgStatStatements.deltaStatus = pgBefore.status === "available" && pgAfter.status === "available" ? "available" : "unavailable";
  // Keep the query-id deltas in the machine-readable summary as well as the
  // CSV. Without this field a report consumer cannot distinguish the causal
  // capture reads from setup/health polling.
  result.telemetry.pgStatStatements.delta = pgDelta;
  if (k6Artifact) result.telemetry.k6 = { status: "available", artifact: k6Artifact };
  immutable(path.join(outputDir, `${runId}.smoke.summary.json`), result);
  immutable(path.join(outputDir, `${runId}.smoke.pg-statements.csv`), csvPgStatStatements(pgDelta));
  immutableText(path.join(outputDir, `${runId}.smoke.report.md`), renderGlobalEventSyncReport(result));
  const requiredCorrectness = ["controlEnteredCapture", "treatmentEnteredCapture", "duplicateAccepted", "duplicateRecordMatches", "captureArtifactUniqueness", "externalDeliveryDisabled", "drainCompleted", "summaryTerminal", "summaryRaceCounts", "treatmentWorkSuccess"];
  const failedCorrectness = requiredCorrectness.filter((key) => result.correctness[key] !== true);
  if (failedCorrectness.length) throw new Error(`smoke correctness gates failed: ${failedCorrectness.join(", ")}`);
  return result;
  } catch (error) {
    // The lifecycle remains responsible for stopping workers before cleanup.
    // Emit an explicit, immutable recovery record so a failed smoke cannot be
    // mistaken for a clean run and an operator can run manifest-scoped cleanup.
    const failurePath = path.join(outputDir, `${runId}.smoke.failure.json`);
    if (!fs.existsSync(failurePath)) {
      immutable(failurePath, { schema: "global-event-sync-smoke-failure-v1", runId, failedAt: new Date().toISOString(), cleanupRequired: true, error: String(error?.message || error) });
    }
    throw error;
  } finally {
    if (collector) await collector.finish().catch(() => {});
    collector = null;
    if (dbPool) await dbPool.end().catch(() => {});
    dbPool = null;
  }
}
async function main() {
  const [command] = process.argv.slice(2); const parsed = args(process.argv.slice(3)); const inputConfig = loadConfig(parsed);
  const runId = required(inputConfig.runId || process.env.CAPACITY_RUN_ID, "run-id"); const config = command === "fixture" ? normalizeGlobalEventSyncConfig({ ...inputConfig, profile: inputConfig.profile || "eligible-overlap" }) : { profile: inputConfig.profile || "eligible-overlap", capacityMetricsEnabled: inputConfig.capacityMetricsEnabled !== false }; assertGlobalEventSyncFixtureDatabase(process.env);
  if (["fixture", "smoke", "run"].includes(command)) {
    const stateDirectory = required(inputConfig.capacityStateDirectory || process.env.CAPACITY_STATE_DIR, "capacity-state-dir");
    const state = assertStartedRun({ runId, directory: path.resolve(stateDirectory), env: process.env });
    // A global-event-sync lifecycle run contains multiple traffic profiles;
    // accept its scenario profile without weakening the exact run/attestation
    // checks performed by assertStartedRun.
    if (state.profile !== config.profile && state.profile !== "global-event-sync") assertCapacityRunProfile(state, config.profile);
  }
  if (command === "fixture") {
    const file = path.resolve(required(inputConfig.output, "output"));
    const tokensFile = `${file}.tokens`;
    if (fs.existsSync(file) || fs.existsSync(tokensFile)) throw new Error("fixture output artifacts already exist; choose a new run/output");
    const fixture = await createGlobalEventSyncFixture({ prisma, runId, config, env: process.env });
    const safeFixture = { ...fixture.manifest, users: fixture.users.map(({ token, ...user }) => user) };
    immutable(file, safeFixture);
    immutable(tokensFile, Object.fromEntries(fixture.users.map((user) => [user.id, user.token])));
    process.stdout.write(`${JSON.stringify({ manifest: file, privateTokens: tokensFile }, null, 2)}\n`); return;
  }
  if (command === "smoke") { const fixture = JSON.parse(fs.readFileSync(path.resolve(required(inputConfig.manifest, "manifest")), "utf8")); const tokenFile = path.resolve(required(inputConfig.tokens, "tokens")); const metricsConfig = { ...inputConfig, base_url: inputConfig.base_url || inputConfig.baseUrl, lima_instance: inputConfig.lima_instance || inputConfig.limaInstance, capacityMetricsEnabled: config.capacityMetricsEnabled }; const result = await smoke({ manifest: fixture, tokens: JSON.parse(fs.readFileSync(tokenFile, "utf8")), baseUrl: required(inputConfig.baseUrl || inputConfig.base_url, "base-url"), outputDir: path.resolve(inputConfig.outputDir || "results"), runId, metricsConfig, runK6: inputConfig.runK6 === true || inputConfig.runK6 === "true" }); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }
  if (command === "run") {
    const manifestPath = path.resolve(required(inputConfig.manifest, "manifest")); const fixture = normalizeGlobalEventSyncManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8"))); const tokenFile = path.resolve(required(inputConfig.tokens, "tokens")); const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    if (fixture.runId !== runId || !path.basename(manifestPath).startsWith(runId)) throw new Error("run manifest filename and run ID must agree");
    const profile = String(inputConfig.profile || "eligible-overlap"); const rate = Number(inputConfig.rate ?? inputConfig.arrivalRate ?? 5); const duration = String(inputConfig.duration || "30s"); const durationMatch = duration.match(/^(\d+(?:\.\d+)?)(s|m|h)$/i); if (!durationMatch) throw new Error("run duration must be expressed in seconds, minutes, or hours"); const durationSeconds = Number(durationMatch[1]) * ({ s: 1, m: 60, h: 3600 }[durationMatch[2].toLowerCase()]); const requestedUsers = Number(inputConfig.users || 0);
    const controlIds = new Set(fixture.cohorts?.controlUserIds || []); const treatmentIds = new Set(fixture.cohorts?.treatmentUserIds || []); const cohortName = ["ordinary-sync", "idle-baseline"].includes(profile) ? "control" : "treatment"; const ids = [...(cohortName === "control" ? controlIds : treatmentIds)]; const users = (fixture.users || []).filter((user) => ids.includes(user.id)).slice(0, requestedUsers > 0 ? requestedUsers : ids.length).map((user) => ({ ...user, cohort: cohortName }));
    if (!users.length) throw new Error(`run profile ${profile} has no users in the requested cohort`);
    const metricsConfig = { ...inputConfig, base_url: inputConfig.baseUrl || inputConfig.base_url, lima_instance: inputConfig.limaInstance || inputConfig.lima_instance, capacityMetricsEnabled: config.capacityMetricsEnabled };
    const periodic = ["android-periodic", "android-synchronized", "android-jittered", "foreground-five-minute", "expedited-over-periodic", "mixed-production"].includes(profile); if (!periodic && rate * durationSeconds > users.length) throw new Error("one-shot run would reuse users; provide more cohort users or a shorter duration"); if (periodic && Number(inputConfig.reuseIntervalSeconds || 0) <= 0) throw new Error("periodic run requires --reuse-interval-seconds"); if (inputConfig.reuseIntervalSeconds) process.env.USER_REUSE_INTERVAL_SECONDS = String(inputConfig.reuseIntervalSeconds);
    const result = await runProfile({ manifest: fixture, baseUrl: required(inputConfig.baseUrl || inputConfig.base_url, "base-url"), outputDir: path.resolve(inputConfig.outputDir || "results"), runId, tokens, metricsConfig, profile, rate, duration, users, repeat: Number(inputConfig.repeat || 1), intent: inputConfig.intent }); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command === "cleanup") {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(required(inputConfig.manifest, "manifest")), "utf8"));
    if (normalizeGlobalEventSyncManifest(fixture).runId !== runId) throw new Error("cleanup manifest run ID does not match requested run");
    await assertCapacityDatabaseMarker({ env: process.env });
    if (process.env.CAPACITY_MODE === "true" || process.env.CAPACITY_MODE === "1") assertOutboundDisabled(process.env);
    const state = loadState(runId, path.resolve(required(inputConfig.capacityStateDirectory || process.env.CAPACITY_STATE_DIR, "capacity-state-dir")));
    if (state.state !== "stopped") throw new Error("global-event cleanup requires a stopped/quiesced capacity run");
    process.stdout.write(`${JSON.stringify(await cleanupGlobalEventSyncFixture({ prisma, manifest: fixture.manifest || fixture }), null, 2)}\n`); return;
  }
  throw new Error("usage: npm run capacity:global-event-sync -- <fixture|smoke|run|cleanup>");
}
main().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }).finally(() => prisma.$disconnect());

module.exports = { smoke, statusMetrics };
