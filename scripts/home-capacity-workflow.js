#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync, spawn } = require("node:child_process");
const dotenv = require("dotenv");
const { assertSnapshotAttestation, compareLiveManifest } = require("../src/modules/loadTesting/safety");
const { assertHomeCapacityParityOverlay } = require("../src/modules/loadTesting/homeCapacityEnvironment");

const LADDER_RATES = Object.freeze([2, 5, 10, 20, 30, 40, 60, 80, 100, 150, 225, 340, 500]);
const WORKFLOW_SCHEMA = "home-capacity-workflow-manifest-v1";
const RESULT_SCHEMA = "home-capacity-workflow-result-v1";
const REPORT_VERSION = "1.0.0";
const TIMINGS = Object.freeze({
  smoke: Object.freeze({ warmupSeconds: 0, measurementSeconds: 60 }),
  scan: Object.freeze({ warmupSeconds: 30, measurementSeconds: 120 }),
  certification: Object.freeze({ warmupSeconds: 120, measurementSeconds: 600 }),
});
const UPPER_BOUNDS = Object.freeze({
  prepareSeconds: 900,
  resetAndReadinessSeconds: 600,
  drainSeconds: 300,
  terminalCleanupSeconds: 180,
});
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{5,63}$/;
const CAPACITY_ENV_ALLOWLIST = new Set([
  "CAPACITY_MODE", "CAPACITY_OUTBOUND_DISABLED", "CAPACITY_RUN_ID", "CAPACITY_DB_NAME",
  "CAPACITY_DB_HOST_ALLOWLIST", "CAPACITY_DB_MARKER", "CAPACITY_REDIS_HOST_ALLOWLIST",
  "CAPACITY_GLOBAL_EVENT_PROFILE", "CAPACITY_DATABASE_POOL_PROFILE",
  "CAPACITY_PROVIDER_ATTEMPT_COUNT", "CACHE_ENV_PREFIX", "DATABASE_URL", "REDIS_URL",
  "SESSION_TOKEN_SECRET", "PORT", "NODE_ENV", "APNS_PRODUCTION",
  "PATH",
  "PROD_DATABASE_URL", "STAGING_DATABASE_URL", "PEER_DATABASE_URL",
  "APNS_KEY_PATH", "APNS_SIGNING_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID",
  "FCM_SERVICE_ACCOUNT", "FCM_SERVICE_ACCOUNT_PATH", "GOOGLE_APPLICATION_CREDENTIALS",
  "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
]);
const SECRET_ENV_ALLOWLIST = new Set([
  "CAPACITY_DB_PASSWORD", "CAPACITY_REDIS_PASSWORD", "CAPACITY_AUTH_SECRET",
  "CAPACITY_DB_MARKER", "CAPACITY_SCRUB_ATTESTATION_SECRET",
]);
const PARITY_ENV_NAME = /^[A-Z][A-Z0-9_]{1,79}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

function hashObject(value) { return sha256(canonical(value)); }

function positiveInteger(value, name, { minimum = 1, maximum = 500 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseCli(argv = []) {
  const [mode, ...items] = argv;
  if (!["scan", "certify", "level"].includes(mode)) {
    throw new Error("usage: npm run capacity:home -- <scan|certify|level> [options]");
  }
  const known = new Set(["config", "expect-commit", "start-rate", "max-rate", "from-scan",
    "rate", "certification-length"]);
  const values = {};
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) throw new Error(`unsupported argument: ${item}`);
    const name = item.slice(2);
    if (!known.has(name)) throw new Error(`unsupported option: --${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`option may be supplied once: --${name}`);
    if (name === "certification-length") { values[name] = true; continue; }
    const next = items[++index];
    if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
    values[name] = next;
  }
  const startRate = positiveInteger(values["start-rate"] ?? 2, "start rate", { minimum: 2 });
  const maxRate = positiveInteger(values["max-rate"] ?? 500, "max rate", { minimum: 2 });
  if (startRate > maxRate) throw new Error("start rate cannot exceed max rate");
  const rate = values.rate == null ? null : positiveInteger(values.rate, "rate");
  if (mode === "level" && rate == null) throw new Error("level requires --rate");
  if (mode !== "level" && rate != null) throw new Error("--rate is only supported by level");
  if (mode !== "certify" && values["from-scan"]) {
    throw new Error("--from-scan is only supported by certify");
  }
  if (mode !== "level" && values["certification-length"]) {
    throw new Error("--certification-length is only supported by level");
  }
  return {
    mode,
    config: values.config || "docs/capacity-load.config.json",
    expectCommit: values["expect-commit"] || null,
    startRate,
    maxRate,
    fromScan: values["from-scan"] || null,
    rate,
    certificationLength: values["certification-length"] === true,
  };
}

function generateWorkflowId({ now = new Date(), commit } = {}) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").toLowerCase();
  const short = String(commit || "").toLowerCase().match(/^[a-f0-9]{7,40}$/)?.[0]?.slice(0, 7);
  if (!short) throw new Error("workflow ID requires a commit SHA");
  return `home-${stamp}-${short}`;
}

function uniqueWorkflowId(base, workflowsRoot) {
  if (!SAFE_ID.test(base || "")) throw new Error("unique workflow ID requires a safe base");
  if (!fs.existsSync(path.join(workflowsRoot, base))) return base;
  for (let ordinal = 2; ordinal <= 999; ordinal += 1) {
    const suffix = `-n${ordinal}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!fs.existsSync(path.join(workflowsRoot, candidate))) return candidate;
  }
  throw new Error("could not allocate a unique workflow ID");
}

function childId(workflowId, { kind, rate, ordinal, repeat } = {}) {
  if (!SAFE_ID.test(workflowId || "") || !["smoke", "discovery", "boundary", "level"].includes(kind)) {
    throw new Error("child requires a safe workflow descendant and supported kind");
  }
  positiveInteger(rate, "rate");
  let suffix = `${kind}-r${rate}`;
  if (kind === "discovery") suffix += `-n${positiveInteger(ordinal, "ordinal", { maximum: 100 })}`;
  if (kind === "boundary") suffix += `-p${positiveInteger(repeat, "repeat", { maximum: 3 })}`;
  const value = `${workflowId}-${suffix}`;
  if (!SAFE_ID.test(value)) throw new Error("workflow child ID exceeds safe length");
  return value;
}

const HARNESS_POLICY = Object.freeze({
  schema: "home-capacity-policy-v1",
  reportVersion: REPORT_VERSION,
  ladderRates: LADDER_RATES,
  timings: TIMINGS,
  upperBounds: UPPER_BOUNDS,
  childId,
});

function buildInitialRates({ startRate = 2, maxRate = 500 } = {}) {
  positiveInteger(startRate, "start rate", { minimum: 2 });
  positiveInteger(maxRate, "max rate", { minimum: 2 });
  if (startRate > maxRate) throw new Error("start rate cannot exceed max rate");
  return [...new Set([startRate, ...LADDER_RATES.filter((rate) => rate > startRate && rate <= maxRate),
    maxRate])].sort((left, right) => left - right);
}

function nextBracketRate({ low, high } = {}) {
  positiveInteger(low, "low rate"); positiveInteger(high, "high rate");
  if (high <= low) throw new Error("failure bound must exceed passing bound");
  const tolerance = Math.max(2, Math.ceil(low * 0.1));
  if (high - low <= tolerance) return null;
  const next = Math.floor((low + high) / 2);
  return next > low ? next : null;
}

function scanBracketTolerance(low) {
  const value = positiveInteger(low, "passing scan rate");
  return Math.max(2, Math.ceil(value * 0.1));
}

function certificationCandidates(observations = []) {
  return [...new Set(observations.filter((row) => row?.passed === true)
    .map((row) => positiveInteger(row.rate, "candidate rate")))].sort((left, right) => right - left);
}

function discoveryChildBound({ startRate, maxRate } = {}) {
  const initial = buildInitialRates({ startRate, maxRate }).length;
  return initial + Math.ceil(Math.log2(maxRate - 1));
}

function maximumChildren({ mode, startRate, maxRate, fromScanPassingCount = null } = {}) {
  if (mode === "level") return 2;
  const discovery = discoveryChildBound({ startRate, maxRate });
  if (mode === "scan") return 1 + discovery;
  if (mode === "certify" && fromScanPassingCount != null) {
    return 1 + 3 * positiveInteger(fromScanPassingCount, "scan passing candidate count", { maximum: 500 });
  }
  if (mode === "certify") return 1 + discovery + 3 * (1 + discovery);
  throw new Error("unsupported workflow mode");
}

function durationEstimate(manifest) {
  const policy = manifest?.policy || {};
  const mode = manifest?.mode;
  const childCount = Number(policy.maximumChildren);
  if (!Number.isInteger(childCount) || childCount < 1) throw new Error("duration estimate requires child bound");
  const discoveryBound = mode === "scan" ? childCount - 1 : mode === "certify" && !manifest.fromScan
    ? discoveryChildBound(policy) : 0;
  const certificationBound = mode === "certify" ? childCount - 1 - discoveryBound : 0;
  const selectedLevelSeconds = mode === "level" && manifest.certificationLength
    ? TIMINGS.certification.warmupSeconds + TIMINGS.certification.measurementSeconds
    : TIMINGS.scan.warmupSeconds + TIMINGS.scan.measurementSeconds;
  const scheduledWorst = TIMINGS.smoke.measurementSeconds +
    discoveryBound * (TIMINGS.scan.warmupSeconds + TIMINGS.scan.measurementSeconds + UPPER_BOUNDS.drainSeconds) +
    certificationBound * (TIMINGS.certification.warmupSeconds + TIMINGS.certification.measurementSeconds + UPPER_BOUNDS.drainSeconds) +
    (mode === "level" ? selectedLevelSeconds + UPPER_BOUNDS.drainSeconds : 0);
  const worstCaseSeconds = UPPER_BOUNDS.prepareSeconds + childCount * UPPER_BOUNDS.resetAndReadinessSeconds +
    scheduledWorst + UPPER_BOUNDS.terminalCleanupSeconds;
  const bestCaseSeconds = UPPER_BOUNDS.prepareSeconds + UPPER_BOUNDS.resetAndReadinessSeconds +
    TIMINGS.smoke.measurementSeconds + UPPER_BOUNDS.drainSeconds + UPPER_BOUNDS.terminalCleanupSeconds +
    (mode === "level" ? selectedLevelSeconds : mode === "certify"
      ? 3 * (TIMINGS.certification.warmupSeconds + TIMINGS.certification.measurementSeconds) :
      TIMINGS.scan.warmupSeconds + TIMINGS.scan.measurementSeconds);
  return { schema: "home-capacity-duration-estimate-v1", bounded: true,
    bestCaseSeconds, worstCaseSeconds, childCount, assumptions: UPPER_BOUNDS };
}

function buildWorkflowManifest(input = {}) {
  if (!SAFE_ID.test(input.workflowId || "") || !["scan", "certify", "level"].includes(input.mode)) {
    throw new Error("workflow manifest requires a safe ID and supported mode");
  }
  for (const name of ["commit", "sourceBundleHash", "snapshotHash", "scrubAttestationHash",
    "parityHash", "resourceManifestHash", "effectiveEnvironmentHash", "configHash",
    "snapshotMetadataHash"]) {
    if (!/^[a-f0-9]{40,64}$/.test(String(input[name] || ""))) throw new Error(`manifest requires ${name}`);
  }
  const provider = input.provider || {};
  if (!/^step-capacity[a-z0-9_.-]*$/.test(provider.instance || "") ||
      provider.target !== "capacity-vm" || provider.database !== "steps_tracker_capacity" ||
      !Number.isInteger(Number(provider.dbHostPort)) || Number(provider.dbHostPort) < 1024 ||
      Number(provider.dbHostPort) > 65535) throw new Error("manifest requires the approved capacity provider identity");
  const policy = {
    schema: HARNESS_POLICY.schema,
    reportVersion: REPORT_VERSION,
    startRate: positiveInteger(input.startRate ?? 2, "start rate", { minimum: 2 }),
    maxRate: positiveInteger(input.maxRate ?? 500, "max rate", { minimum: 2 }),
    ladderRates: [...LADDER_RATES], timings: TIMINGS, upperBounds: UPPER_BOUNDS,
  };
  if (policy.startRate > policy.maxRate) throw new Error("start rate cannot exceed max rate");
  policy.maximumChildren = maximumChildren({ mode: input.mode, ...policy,
    fromScanPassingCount: input.fromScanPassingCount });
  const unsigned = {
    schema: WORKFLOW_SCHEMA, workflowId: input.workflowId, mode: input.mode,
    createdAt: input.createdAt || new Date().toISOString(),
    commit: input.commit, sourceBundleHash: input.sourceBundleHash,
    snapshotHash: input.snapshotHash, scrubAttestationHash: input.scrubAttestationHash,
    parityHash: input.parityHash, resourceManifestHash: input.resourceManifestHash,
    effectiveEnvironmentHash: input.effectiveEnvironmentHash,
    configHash: input.configHash, snapshotMetadataHash: input.snapshotMetadataHash,
    provider: { ...provider, dbHostPort: Number(provider.dbHostPort) },
    profileVersion: input.profileVersion || "2.1.0", reportVersion: REPORT_VERSION,
    topologyHash: input.topologyHash || null, migrationHash: input.migrationHash || null,
    effectiveEnvironmentEvidencePath: input.effectiveEnvironmentEvidencePath || null,
    fromScan: input.fromScan || null, certificationLength: input.certificationLength === true,
    rate: input.rate == null ? null : positiveInteger(input.rate, "diagnostic rate"),
    policy,
  };
  unsigned.durationEstimate = durationEstimate(unsigned);
  return { ...unsigned, hash: hashObject(unsigned) };
}

function classifyChildOutcome({ report, stage, error, signal } = {}) {
  if (signal) return "interrupted";
  if (error) return ({ setup: "setup-failure", evidence: "evidence-failure",
    cleanup: "cleanup-failure" })[stage] || "setup-failure";
  if (report?.gates?.passed === true) return "pass";
  if (report?.gates?.passed === false) return "capacity-failure";
  return "evidence-failure";
}

function inferLikelyConstraint(report = {}) {
  const failures = (report.gates?.failures || []).map(String);
  const matches = [];
  const generator = report.generator || report.infrastructure?.generator || {};
  if (failures.some((value) => /generator|dropped iteration|observer overhead/i.test(value)) &&
      (Number(generator.cpuPeakPercent) >= 90 || Number(report.sessions?.dropped) > 0 ||
        generator.saturated === true)) matches.push("generator saturation");
  if (failures.some((value) => /pool|checkout|waiter/i.test(value)) &&
      report.infrastructure?.telemetryComplete === true &&
      (Number(report.infrastructure?.dbPoolWaitP99Ms) > 50 ||
        Number(report.infrastructure?.poolCheckoutFailures) > 0)) matches.push("database pool pressure");
  if (failures.some((value) => /queue|resolution/i.test(value)) &&
      report.resolutionEvidence?.terminalReconciled === true &&
      (Number(report.queue?.p95LagMs) > 30_000 || Number(report.queue?.backlogPeak) > 0)) {
    matches.push("resolution throughput");
  }
  if (failures.some((value) => /event.?loop|backend cpu|HTTP/i.test(value)) &&
      !matches.includes("generator saturation") &&
      (Number(report.infrastructure?.backendCpuPeakPercent) >= 90 ||
        Number(report.infrastructure?.maxEventLoopDelayMs) > 100)) matches.push("HTTP/backend saturation");
  if (matches.length > 1) return "multiple correlated constraints";
  return matches[0] || "inconclusive";
}

function boundaryMetrics(report = {}) {
  const endpoints = Object.entries(report.endpoints || {}).map(([name, value]) => ({ name,
    requests: Number(value.requests || 0), p50: value.latencyMs?.p50 ?? null,
    p95: value.latencyMs?.p95 ?? null, p99: value.latencyMs?.p99 ?? null }))
    .filter((row) => row.requests > 0).sort((left, right) => Number(right.p95) - Number(left.p95));
  const cpu = report.infrastructure?.containerPeakCpuPercent || {};
  const peakFor = (suffix) => {
    const values = Object.entries(cpu).filter(([name]) => name.endsWith(suffix)).map(([, value]) => Number(value));
    return values.length ? Math.max(...values) : null;
  };
  return {
    latency: { p50: report.sessions?.criticalHomeMs?.p50 ?? null,
      p95: report.sessions?.criticalHomeMs?.p95 ?? null,
      p99: report.sessions?.criticalHomeMs?.p99 ?? null },
    sessions: { averageConcurrent: report.sessions?.averageInFlight ?? null,
      peakConcurrent: report.sessions?.peakInFlight ?? null },
    errors: { rate: report.summary?.errorRate ?? null,
      droppedArrivals: report.sessions?.dropped ?? null },
    resourcePeaks: report.infrastructure || null,
    infrastructure: { backendCpuPeakPercent: peakFor("-backend"),
      databaseCpuPeakPercent: peakFor("-postgres"), redisCpuPeakPercent: peakFor("-redis"),
      dbPoolWaitP99Ms: report.infrastructure?.dbPoolWaitP99Ms ?? null,
      eventLoopDelayMs: report.infrastructure?.maxEventLoopDelayMs ?? null },
    queue: { peakDepth: report.queue?.peakDepth ?? null, p95LagMs: report.queue?.p95LagMs ?? null,
      drainSeconds: report.queue?.drainSeconds ?? null },
    failedGates: report.gates?.failures || [],
    endpointBreakdown: endpoints,
  };
}

function git(repository, args, options = {}) {
  return execFileSync("git", args, { cwd: repository, timeout: 60_000, killSignal: "SIGKILL", ...options });
}

function trackedHeadEntries(repository) {
  const raw = git(repository, ["ls-tree", "-rz", "--full-tree", "HEAD"]);
  return raw.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type, object] = row.slice(0, tab).split(" ");
    return { mode, type, object, name: row.slice(tab + 1) };
  });
}

function safeBundleMember(name) {
  if (!name || path.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe source bundle member: ${name}`);
  }
  return name;
}

function bundleDigest(entries) {
  const digest = crypto.createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    digest.update(entry.name); digest.update("\0"); digest.update(entry.mode); digest.update("\0");
    digest.update(String(entry.length)); digest.update("\0"); digest.update(entry.bytes); digest.update("\0");
  }
  return digest.digest("hex");
}

function createSourceBundle({ repository, output } = {}) {
  const root = path.resolve(repository || ".");
  const target = path.resolve(output || "");
  if (fs.existsSync(target)) throw new Error("immutable source bundle target already exists");
  const commit = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const treeEntries = trackedHeadEntries(root);
  const entries = [];
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  try {
    for (const row of treeEntries) {
      safeBundleMember(row.name);
      if (row.type !== "blob" || !["100644", "100755", "120000"].includes(row.mode)) {
        throw new Error(`unsupported tracked source member: ${row.name}`);
      }
      const bytes = git(root, ["cat-file", "blob", row.object]);
      const destination = path.join(target, row.name);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (row.mode === "120000") {
        const link = bytes.toString("utf8");
        const resolved = path.resolve(path.dirname(destination), link);
        if (path.isAbsolute(link) || resolved !== target && !resolved.startsWith(`${target}${path.sep}`)) {
          throw new Error(`tracked symlink escapes the repository: ${row.name}`);
        }
        fs.symlinkSync(link, destination);
      } else {
        fs.writeFileSync(destination, bytes, { flag: "wx", mode: row.mode === "100755" ? 0o500 : 0o400 });
      }
      entries.push({ name: row.name, mode: row.mode, length: bytes.length,
        contentHash: sha256(bytes), bytes });
    }
    if (entries.some((entry) => entry.name === "node_modules" || entry.name.startsWith("node_modules/"))) {
      throw new Error("tracked node_modules cannot be part of the immutable source bundle");
    }
    fs.mkdirSync(path.join(target, "node_modules"), { mode: 0o500 });
    for (const directory of [...new Set(entries.map((entry) => path.dirname(path.join(target, entry.name))))]
      .sort((left, right) => right.length - left.length)) fs.chmodSync(directory, 0o500);
    fs.chmodSync(target, 0o500);
  } catch (error) {
    fs.chmodSync(target, 0o700);
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return { schema: "home-capacity-source-bundle-v1", repository: root, path: target, commit,
    entries: entries.map(({ bytes, ...entry }) => entry), hash: bundleDigest(entries) };
}

function verifySourceBundle(bundle) {
  if (bundle?.schema !== "home-capacity-source-bundle-v1" || !path.isAbsolute(bundle.path) ||
      !Array.isArray(bundle.entries) || !/^[a-f0-9]{64}$/.test(bundle.hash || "")) {
    throw new Error("source bundle metadata is invalid");
  }
  const entries = bundle.entries.map((entry) => {
    safeBundleMember(entry.name);
    const absolute = path.join(bundle.path, entry.name);
    const stat = fs.lstatSync(absolute);
    let bytes;
    if (entry.mode === "120000") {
      if (!stat.isSymbolicLink()) throw new Error(`source bundle member changed: ${entry.name}`);
      bytes = Buffer.from(fs.readlinkSync(absolute));
    } else {
      if (!stat.isFile()) throw new Error(`source bundle member changed: ${entry.name}`);
      const expectedMode = entry.mode === "100755" ? 0o500 : 0o400;
      if ((stat.mode & 0o777) !== expectedMode) {
        throw new Error(`source bundle member hash/mode changed: ${entry.name}`);
      }
      bytes = fs.readFileSync(absolute);
    }
    if (bytes.length !== entry.length || sha256(bytes) !== entry.contentHash) {
      throw new Error(`source bundle member hash changed: ${entry.name}`);
    }
    return { ...entry, bytes };
  });
  const dependencyMountpoint = path.join(bundle.path, "node_modules");
  const mountStat = fs.lstatSync(dependencyMountpoint);
  if (!mountStat.isDirectory() || mountStat.isSymbolicLink() ||
      fs.readdirSync(dependencyMountpoint).length !== 0 || (mountStat.mode & 0o777) !== 0o500) {
    throw new Error("immutable source bundle dependency mountpoint changed");
  }
  if (bundleDigest(entries) !== bundle.hash) throw new Error("source bundle hash changed after confirmation");
  return { valid: true, hash: bundle.hash, files: entries.length };
}

function sourceSubsetHash(bundle, prefix) {
  const rows = bundle.entries.filter((entry) => entry.name === prefix || entry.name.startsWith(`${prefix}/`))
    .map((entry) => ({ name: entry.name, mode: entry.mode, length: entry.length,
      contentHash: entry.contentHash })).sort((left, right) => left.name.localeCompare(right.name));
  if (!rows.length) throw new Error(`source bundle is missing ${prefix}`);
  return hashObject(rows);
}

function validateSnapshotInputs({ config, localEnvironment }) {
  const metadataPath = path.resolve(config.snapshot || "");
  if (!fs.existsSync(metadataPath)) throw new Error("approved capacity snapshot metadata is missing");
  const snapshot = readJson(metadataPath);
  if (snapshot.schema !== "capacity-snapshot-v1" || !path.isAbsolute(snapshot.sourceSnapshotPath) ||
      !fs.existsSync(snapshot.sourceSnapshotPath) || sha256(fs.readFileSync(snapshot.sourceSnapshotPath)) !==
      snapshot.sourceSnapshotHash) throw new Error("capacity snapshot bytes do not match metadata");
  const attestationPath = path.resolve(path.dirname(metadataPath), snapshot.scrubAttestationPath || "");
  if (!fs.existsSync(attestationPath)) throw new Error("approved scrub attestation is missing");
  const attestation = readJson(attestationPath);
  assertSnapshotAttestation({ manifest: { snapshotHash: snapshot.snapshotHash }, attestation,
    secret: localEnvironment.CAPACITY_SCRUB_ATTESTATION_SECRET });
  if (attestation.snapshotHash !== snapshot.sourceSnapshotHash) {
    throw new Error("scrub attestation is not bound to the approved snapshot bytes");
  }
  if (!path.isAbsolute(config.live_manifest || "") || !fs.existsSync(config.live_manifest)) {
    throw new Error("approved live capacity resource manifest is missing");
  }
  const liveManifest = readJson(config.live_manifest);
  const comparison = compareLiveManifest(snapshot.approvedManifest, liveManifest);
  if (!comparison.ok) throw new Error(`capacity resource manifest drift: ${comparison.differences.map((row) => row.path).join(", ")}`);
  return { snapshot, metadataPath, attestation, attestationPath, liveManifest };
}

function buildEffectiveEnvironment({ capacity = {}, parity = {}, secrets = {}, hmacKey } = {}) {
  if (!String(hmacKey || "").trim()) throw new Error("secret fingerprint HMAC key is required");
  for (const name of Object.keys(capacity)) if (!CAPACITY_ENV_ALLOWLIST.has(name)) {
    throw new Error(`capacity environment name is not allowlisted: ${name}`);
  }
  for (const name of Object.keys(parity)) if (!PARITY_ENV_NAME.test(name)) {
    throw new Error(`parity environment name is not allowlisted: ${name}`);
  }
  for (const name of Object.keys(secrets)) if (!SECRET_ENV_ALLOWLIST.has(name)) {
    throw new Error(`secret environment name is not allowlisted: ${name}`);
  }
  const environment = Object.fromEntries([...Object.entries(parity), ...Object.entries(capacity),
    ...Object.entries(secrets)].map(([name, value]) => [name, String(value ?? "")]));
  const nonSecret = Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !SECRET_ENV_ALLOWLIST.has(name)).sort(([left], [right]) => left.localeCompare(right)));
  const secretFingerprints = Object.fromEntries(Object.entries(secrets).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, crypto.createHmac("sha256", String(hmacKey)).update(String(value)).digest("hex")]));
  return { environment, report: { schema: "home-capacity-effective-environment-v1",
    nonSecret, nonSecretHash: hashObject(nonSecret), secretFingerprints,
    hash: hashObject({ nonSecret, secretFingerprints }) } };
}

function eventDirectory(directory) { return path.join(path.resolve(directory), "events"); }

function readEvents(directory) {
  const root = eventDirectory(directory);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => /^\d{6}-[a-z0-9-]+\.json$/.test(name)).sort()
    .map((name) => ({ file: path.join(root, name), value: JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) }));
}

function validateSelectedChild(manifest, event) {
  if (event.type !== "child-selected") return;
  const { childId: selected, rate, kind, repeat, timings } = event.payload || {};
  if (!String(selected || "").startsWith(`${manifest.workflowId}-`) || !SAFE_ID.test(selected)) {
    throw new Error("journal child is not a confirmed workflow descendant");
  }
  const parsedRate = positiveInteger(rate, "journal child rate");
  if (parsedRate > manifest.policy.maxRate && parsedRate !== 1) throw new Error("journal child rate exceeds policy");
  const expectedTiming = kind === "smoke" ? TIMINGS.smoke : kind === "boundary" ? TIMINGS.certification :
    kind === "level" && manifest.certificationLength ? TIMINGS.certification : TIMINGS.scan;
  if (!expectedTiming || Number(timings?.warmupSeconds) !== expectedTiming.warmupSeconds ||
      Number(timings?.measurementSeconds) !== expectedTiming.measurementSeconds) {
    throw new Error("journal child timing is outside confirmed policy");
  }
  const escapedWorkflow = manifest.workflowId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameMatches = kind === "smoke" ? selected === `${manifest.workflowId}-smoke-r1` && parsedRate === 1 :
    kind === "discovery" ? new RegExp(`^${escapedWorkflow}-discovery-r${parsedRate}-n[1-9][0-9]*$`).test(selected) :
    kind === "boundary" ? selected === `${manifest.workflowId}-boundary-r${parsedRate}-p${repeat}` &&
      [1, 2, 3].includes(Number(repeat)) : kind === "level" ?
      selected === `${manifest.workflowId}-level-r${parsedRate}` : false;
  if (!nameMatches || manifest.mode === "scan" && !["smoke", "discovery"].includes(kind) ||
      manifest.mode === "certify" && !["smoke", "discovery", "boundary"].includes(kind) ||
      manifest.mode === "level" && !["smoke", "level"].includes(kind)) {
    throw new Error("journal child identity/mode is outside confirmed policy");
  }
}

function validateJournalTopology(events) {
  const selected = new Map();
  let planned = false; let confirmed = false; let prepared = false; let terminal = false;
  let activeChild = null;
  for (const event of events) {
    if (terminal) throw new Error("workflow journal contains an event after terminal");
    if (event.type === "planned") {
      if (planned || event.sequence !== 1) throw new Error("workflow journal has an invalid planned transition");
      planned = true;
    } else if (event.type === "confirmed") {
      if (!planned || confirmed) throw new Error("workflow journal has an invalid confirmation transition");
      confirmed = true;
    } else if (event.type === "prepared") {
      if (!confirmed || prepared) throw new Error("workflow journal has an invalid preparation transition");
      prepared = true;
    } else if (event.type === "child-selected") {
      const child = event.payload?.childId;
      if (!prepared || activeChild || selected.has(child)) {
        throw new Error("workflow journal has an invalid child selection transition");
      }
      selected.set(child, "selected");
    } else if (event.type === "child-started") {
      const child = event.payload?.childId;
      if (selected.get(child) !== "selected" || activeChild) {
        throw new Error("workflow journal has an invalid child start transition");
      }
      selected.set(child, "started"); activeChild = child;
    } else if (["child-completed", "child-failed"].includes(event.type)) {
      const child = event.payload?.childId;
      const state = selected.get(child);
      if (event.type === "child-completed" && (activeChild !== child || state !== "started") ||
          event.type === "child-failed" && !["selected", "started"].includes(state)) {
        throw new Error("workflow journal has an invalid child terminal transition");
      }
      selected.set(child, event.type); activeChild = null;
    } else if (event.type === "terminal") {
      if (!planned || activeChild || terminal) throw new Error("workflow journal has an invalid terminal transition");
      terminal = true;
    } else throw new Error(`workflow journal has unsupported event type: ${event.type}`);
  }
  return true;
}

function appendJournalEvent({ directory, manifest, type, payload = {}, at = new Date() } = {}) {
  if (manifest?.schema !== WORKFLOW_SCHEMA && !manifest?.workflowId) throw new Error("journal requires manifest");
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(type || "")) throw new Error("invalid journal event type");
  const existing = verifyJournal({ directory, manifest, allowEmpty: true }).events;
  const sequence = existing.length + 1;
  const unsigned = { schema: "home-capacity-workflow-event-v1", sequence, type,
    workflowId: manifest.workflowId, manifestHash: manifest.hash,
    previousHash: existing.at(-1)?.hash || null, at: new Date(at).toISOString(), payload };
  validateSelectedChild(manifest, unsigned);
  if (type === "child-selected" && existing.filter((event) => event.type === "child-selected").length >=
      Number(manifest.policy.maximumChildren)) throw new Error("confirmed maximum child count exceeded");
  const event = { ...unsigned, hash: hashObject(unsigned) };
  validateJournalTopology([...existing, event]);
  const root = eventDirectory(directory); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${String(sequence).padStart(6, "0")}-${type}.json`);
  fs.writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return event;
}

function verifyJournal({ directory, manifest, allowEmpty = false } = {}) {
  const rows = readEvents(directory);
  if (!allowEmpty && rows.length === 0) throw new Error("workflow journal is empty");
  let previousHash = null;
  for (let index = 0; index < rows.length; index += 1) {
    const event = rows[index].value;
    const { hash, ...unsigned } = event;
    if (event.sequence !== index + 1) throw new Error("workflow journal sequence gap or duplicate");
    if (event.workflowId !== manifest.workflowId || event.manifestHash !== manifest.hash) {
      throw new Error("workflow journal manifest binding changed");
    }
    if (event.previousHash !== previousHash) throw new Error("workflow journal previous hash is broken");
    if (hashObject(unsigned) !== hash) throw new Error("workflow journal event hash is altered");
    validateSelectedChild(manifest, event);
    previousHash = hash;
  }
  if (rows.filter((row) => row.value.type === "child-selected").length > Number(manifest.policy.maximumChildren)) {
    throw new Error("workflow journal exceeds confirmed child count");
  }
  validateJournalTopology(rows.map((row) => row.value));
  return { valid: true, events: rows.map((row) => row.value), terminalHash: previousHash };
}

function renderSummary(result = {}) {
  const lines = ["HOME CAPACITY WORKFLOW", "", `Mode: ${result.mode || "unknown"}`,
    `Classification: ${result.classification || "unknown"}`];
  if (result.mode === "scan") {
    lines.push(`Provisional passing rate: ${result.highestPass ?? "unknown"}/sec`);
    lines.push(`First observed failing rate: ${result.firstFailure ?? "unobserved"}${result.firstFailure == null ? "" : "/sec"}`);
    lines.push(`Likely capacity range: ${result.firstFailure == null
      ? `at least ${result.highestPass}/sec` : `[${result.highestPass}, ${result.firstFailure}]/sec`}`);
    lines.push(`Observed bottleneck: ${result.likelyConstraint || "inconclusive"}`);
  } else if (result.mode === "certify") {
    if (result.certifiedRate != null) lines.push(`Highest certified tested rate: ${result.certifiedRate}/sec`);
    if (result.certifiedRate != null) lines.push(`Certified throughput: ${result.certifiedRate * 60} opens/min`);
    if (result.lowerBound != null) lines.push(`Certified lower bound: at least ${result.lowerBound}/sec`);
    lines.push(`Failure bound: ${result.failureBound == null ? "unobserved" : `${result.failureBound}/sec`}`);
    lines.push(`70% operating ceiling: ${result.operatingCeiling == null ? "not established" : `${result.operatingCeiling}/sec`}`);
    lines.push(`Supporting runs: ${(result.supportingRuns || []).join(", ") || "none"}`);
  } else if (result.mode === "level") lines.push(`Diagnostic rate: ${result.rate ?? "unknown"}/sec`);
  if (result.latency) lines.push(`Home completion p50/p95/p99: ${result.latency.p50 ?? "unknown"}/${result.latency.p95 ?? "unknown"}/${result.latency.p99 ?? "unknown"} ms`);
  if (result.errors) lines.push(`HTTP error rate / dropped arrivals: ${result.errors.rate ?? "unknown"} / ${result.errors.droppedArrivals ?? "unknown"}`);
  lines.push(`Failed gates: ${(result.failedGates || result.gates?.failures || []).join("; ") || "none"}`);
  if (result.sessions) lines.push(`Average / peak concurrent Home sessions: ${result.sessions.averageConcurrent ?? "unknown"} / ${result.sessions.peakConcurrent ?? "unknown"}`);
  if (result.mode !== "scan" && result.likelyConstraint) lines.push(`Likely constraint: ${result.likelyConstraint}`);
  if (result.endpointBreakdown?.length) lines.push(`Slowest observed endpoint p95: ${result.endpointBreakdown[0].name} (${result.endpointBreakdown[0].p95 ?? "unknown"} ms)`);
  const passingInfra = result.passingEvidence?.infrastructure || result.infrastructure || {};
  const passingQueue = result.passingEvidence?.queue || result.queue || {};
  const failureInfra = result.failureEvidence?.infrastructure || {};
  const failureQueue = result.failureEvidence?.queue || {};
  lines.push(`Passing Backend/DB CPU peak / Redis CPU peak: ${passingInfra.backendCpuPeakPercent ?? passingInfra.backendCpuPeak ?? "unknown"}/${passingInfra.databaseCpuPeakPercent ?? passingInfra.databaseCpuPeak ?? "unknown"}/${passingInfra.redisCpuPeakPercent ?? "unknown"}%`);
  lines.push(`Passing Pool wait p99: ${passingInfra.dbPoolWaitP99Ms ?? "unknown"} ms`);
  lines.push(`Passing Queue peak/p95 lag: ${passingQueue.peakDepth ?? "unknown"}/${passingQueue.p95LagMs ?? "unknown"} ms`);
  lines.push(`Failing gates: ${(result.failureEvidence?.failedGates || []).join("; ") || "none observed"}`);
  lines.push(`Failing backend/DB/Redis CPU peak: ${failureInfra.backendCpuPeakPercent ?? "unknown"}/${failureInfra.databaseCpuPeakPercent ?? "unknown"}/${failureInfra.redisCpuPeakPercent ?? "unknown"}%`);
  lines.push(`Failing pool wait p99: ${failureInfra.dbPoolWaitP99Ms ?? "unknown"} ms`);
  lines.push(`Failing queue peak/p95 lag: ${failureQueue.peakDepth ?? "unknown"}/${failureQueue.p95LagMs ?? "unknown"} ms`);
  const phases = result.elapsed?.phases || {};
  lines.push(`Phase timings prepare/readiness/load/cleanup: ${phases.prepareSeconds ?? "unknown"}/${phases.readinessSeconds ?? "unknown"}/${phases.loadSeconds ?? "unknown"}/${phases.cleanupSeconds ?? "unknown"} seconds`);
  if (result.cleanup) lines.push(`Cleanup reset-data/stop/cache-retained: ${result.cleanup.resetData ?? "unknown"}/${result.cleanup.stopped ?? "unknown"}/${result.cleanup.cacheRetained ?? "unknown"}`);
  if (result.mode === "scan" && result.certificationCommand) {
    lines.push(`Certification command: ${result.certificationCommand}`);
  }
  return `${lines.join("\n")}\n`;
}

function durableAtomicWrite(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
  const directoryHandle = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
}

function resultWithHash(result) {
  const { resultHash: ignored, ...unsigned } = result;
  return { ...unsigned, resultHash: hashObject(unsigned) };
}

function writeTerminalArtifacts({ directory, result } = {}) {
  const root = path.resolve(directory); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const resultPath = path.join(root, "workflow-result.json");
  const summaryPath = path.join(root, "summary.txt");
  const stored = resultWithHash(result);
  if (fs.existsSync(resultPath) && fs.existsSync(summaryPath)) {
    throw new Error("immutable terminal artifacts already exist");
  }
  if (fs.existsSync(resultPath)) {
    const existing = readJson(resultPath); const { resultHash, ...unsigned } = existing;
    if (hashObject(unsigned) !== resultHash || canonical(existing) !== canonical(stored)) {
      throw new Error("immutable terminal result exists with different or invalid content");
    }
  } else {
    if (fs.existsSync(summaryPath)) fs.unlinkSync(summaryPath);
    durableAtomicWrite(resultPath, `${JSON.stringify(stored, null, 2)}\n`);
  }
  if (!fs.existsSync(summaryPath)) durableAtomicWrite(summaryPath, renderSummary(stored));
  else if (fs.readFileSync(summaryPath, "utf8") !== renderSummary(stored)) {
    throw new Error("immutable terminal summary exists with different content");
  }
  const latestPath = path.join(path.dirname(root), "latest.json");
  durableAtomicWrite(latestPath, `${JSON.stringify({ workflowId: path.basename(root), resultPath,
    resultHash: stored.resultHash, journalTerminalHash: stored.journalTerminalHash,
    completedAt: new Date().toISOString() }, null, 2)}\n`);
  return { resultPath, summaryPath, latestPath };
}

const COMPATIBILITY_FIELDS = Object.freeze(["commit", "sourceBundleHash", "profileVersion",
  "reportVersion", "snapshotHash", "scrubAttestationHash", "parityHash", "resourceManifestHash",
  "topologyHash", "effectiveEnvironmentHash", "configHash", "snapshotMetadataHash",
  "migrationHash", "timingPolicyHash", "rateBoundsHash"]);

function isScanCompatible(scan, binding) {
  return scan?.schema === RESULT_SCHEMA && scan.mode === "scan" && scan.completed === true &&
    COMPATIBILITY_FIELDS.every((field) => scan.binding?.[field] != null &&
      scan.binding[field] === binding?.[field]);
}

function verifyReusableScan({ resultPath, resultBytes = null, expectedBinding, expectedMaxRate } = {}) {
  const resolved = path.resolve(resultPath || "");
  if (path.basename(resolved) !== "workflow-result.json") throw new Error("scan reuse requires workflow-result.json");
  const directory = path.dirname(resolved);
  const manifest = readJson(path.join(directory, "confirmed-manifest.json"));
  const { hash: manifestHash, ...manifestUnsigned } = manifest;
  if (manifest.schema !== WORKFLOW_SCHEMA || manifest.mode !== "scan" || hashObject(manifestUnsigned) !== manifestHash) {
    throw new Error("scan manifest hash/mode is invalid");
  }
  if (Number(manifest.policy?.maxRate) !== Number(expectedMaxRate)) throw new Error("scan did not reach the confirmed maximum rate");
  const scan = JSON.parse((resultBytes == null ? fs.readFileSync(resolved) : resultBytes).toString("utf8"));
  const { resultHash, ...resultUnsigned } = scan;
  if (hashObject(resultUnsigned) !== resultHash || !isScanCompatible(scan, expectedBinding)) {
    throw new Error("scan terminal result hash/binding is invalid");
  }
  const journal = verifyJournal({ directory, manifest });
  const terminal = journal.events.at(-1);
  if (terminal?.type !== "terminal" || journal.terminalHash !== scan.journalTerminalHash ||
      terminal.payload?.completed !== true || terminal.payload?.cleanup?.resetData !== true) {
    throw new Error("scan result is not bound to a complete clean terminal journal");
  }
  if (terminal.payload.classification !== scan.classification || scan.completed !== true ||
      canonical(terminal.payload.cleanup) !== canonical(scan.cleanup)) {
    throw new Error("scan terminal result classification/cleanup differs from its journal");
  }
  const { resultHash: ignoredResultHash, resultPayloadHash, journalTerminalHash, ...payloadResult } = scan;
  if (hashObject(payloadResult) !== resultPayloadHash || terminal.payload.resultPayloadHash !== resultPayloadHash) {
    throw new Error("scan terminal journal does not bind the terminal result payload hash");
  }
  const selected = new Map(journal.events.filter((event) => event.type === "child-selected")
    .map((event) => [event.payload.childId, event.payload]));
  const observations = [];
  for (const event of journal.events.filter((row) => ["child-completed", "child-failed"].includes(row.type))) {
    const choice = selected.get(event.payload?.childId);
    if (!choice || choice.kind === "smoke") continue;
    if (!event.payload.reportPath || !event.payload.reportHash) throw new Error("scan child lacks journal-bound report evidence");
    const report = path.resolve(event.payload.reportPath);
    if (report !== directory && !report.startsWith(`${directory}${path.sep}`)) throw new Error("scan report path escapes workflow directory");
    if (!fs.existsSync(report) || reportHash(report) !== event.payload.reportHash) throw new Error("scan child report hash is invalid");
    const value = readJson(report);
    const passed = event.payload.classification === "pass";
    if (value.schema !== "home-open-capacity-result-v1" || value.provenance?.runId !== choice.childId ||
        Number(value.parameters?.arrivalRatePerSecond) !== Number(choice.rate) ||
        value.gates?.passed !== passed) throw new Error("scan child report classification/provenance is invalid");
    observations.push({ rate: Number(choice.rate), passed, kind: choice.kind, runId: choice.childId });
  }
  const passes = observations.filter((row) => row.passed).map((row) => row.rate);
  const highestPass = passes.length ? Math.max(...passes) : 1;
  const firstFailure = observations.filter((row) => !row.passed && row.rate > highestPass)
    .map((row) => row.rate).sort((a, b) => a - b)[0] ?? null;
  if (scan.highestPass !== highestPass || scan.firstFailure !== firstFailure ||
      firstFailure == null && highestPass !== Number(expectedMaxRate) ||
      firstFailure != null && firstFailure - highestPass > scanBracketTolerance(highestPass)) {
    throw new Error("scan terminal bounds do not match verified child reports or maximum reached");
  }
  return { result: scan, manifest, journal, observations };
}

function workflowExitCode(result) {
  if (!result?.completed) return 1;
  if (result.mode === "level") return result.classification === "diagnostic-pass" ? 0 : 1;
  if (result.mode === "certify") return ["certified", "certified-lower-bound"].includes(result.classification) ? 0 : 1;
  return result.mode === "scan" && ["scan-range", "scan-lower-bound"].includes(result.classification) ? 0 : 1;
}

function assertCleanSource(repository, expectedCommit = null) {
  const root = path.resolve(repository);
  const commit = git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (status) throw new Error(`capacity workflow requires a clean checkout; first change: ${status.split("\n")[0]}`);
  if (expectedCommit && expectedCommit !== commit) throw new Error(`--expect-commit does not equal current HEAD (${commit})`);
  if (!expectedCommit) {
    const branch = git(root, ["branch", "--show-current"], { encoding: "utf8" }).trim();
    const main = git(root, ["rev-parse", "main"], { encoding: "utf8" }).trim();
    if (branch !== "main" || main !== commit) throw new Error("capacity workflow defaults to a clean checkout of local main HEAD");
  }
  return commit;
}

function loadLocalEnvironment(repository) {
  const file = path.join(repository, ".env.capacity.local");
  if (!fs.existsSync(file)) throw new Error("missing local capacity secrets: .env.capacity.local");
  return dotenv.parse(fs.readFileSync(file));
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }

function prerequisitePath(names) {
  const directories = names.map((name) => {
    let executable;
    try { executable = execFileSync("which", [name], { encoding: "utf8", timeout: 10_000,
      killSignal: "SIGKILL" }).trim(); }
    catch { throw new Error(`missing capacity prerequisite: ${name}`); }
    if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
      throw new Error(`capacity prerequisite did not resolve safely: ${name}`);
    }
    return path.dirname(executable);
  });
  return [...new Set([...directories, path.dirname(process.execPath), "/usr/bin", "/bin"])].join(":");
}

function confirmationPrompt(manifest, output = process.stdout) {
  const estimate = manifest.durationEstimate;
  output.write(`Workflow ${manifest.workflowId}\n`);
  output.write(`Manifest ${manifest.hash}\n`);
  output.write(`Commit/source ${manifest.commit} / ${manifest.sourceBundleHash}\n`);
  output.write(`Snapshot/scrub ${manifest.snapshotHash} / ${manifest.scrubAttestationHash}\n`);
  output.write(`Provider ${manifest.provider.instance} ${manifest.provider.target} database=${manifest.provider.database}\n`);
  output.write("Hardware 7-vCPU/12-GiB VM; backend 4-vCPU/8-GiB; Postgres 1-vCPU/2-GiB; Redis 1-vCPU/256-MiB\n");
  output.write(`Resources ${manifest.resourceManifestHash} topology=${manifest.topologyHash}\n`);
  output.write(`Rates ${manifest.policy.startRate}-${manifest.policy.maxRate}/sec timings=${hashObject(manifest.policy.timings)}\n`);
  output.write(`Estimated duration: ${Math.ceil(estimate.bestCaseSeconds / 60)}-${Math.ceil(estimate.worstCaseSeconds / 60)} minutes (estimate, not a deadline)\n`);
  output.write(`Maximum child runs: ${manifest.policy.maximumChildren}\n`);
  output.write(`Type START ${manifest.workflowId} ${manifest.hash} to continue: `);
  return `START ${manifest.workflowId} ${manifest.hash}`;
}

async function confirmManifest(manifest, { input = null, interactive = process.stdin.isTTY,
  output = process.stdout } = {}) {
  const expected = confirmationPrompt(manifest, output);
  let answer = input;
  if (answer == null) {
    if (!interactive) throw new Error("capacity workflow requires exact interactive confirmation");
    const interface_ = readline.createInterface({ input: process.stdin, output: process.stdout });
    answer = await new Promise((resolve) => interface_.question("", resolve)); interface_.close();
  }
  if (String(answer).trim() !== expected) throw new Error("capacity workflow confirmation did not match manifest identity");
  return true;
}

function spawnPromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || 20 * 60_000);
    const { timeoutMs: ignored, ...spawnOptions } = options;
    const child = spawn(command, args, spawnOptions);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref?.();
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); code === 0 ? resolve({ code, signal }) :
      reject(Object.assign(new Error(`${command} exited ${signal || code}${signal === "SIGKILL" ? " after finite timeout" : ""}`), { code, signal })); });
  });
}

function resultPathFor({ root, runId, mode, rate }) {
  return path.join(root, runId, `${runId}.home-open.${mode}.${rate}.json`);
}

async function executeHomeChild({ repository, configPath, child, workflowManifestPath,
  childEventPath, outputRoot, environment, immutableRepository, hostCredentialPath }, dependencies = {}) {
  const run = dependencies.run || spawnPromise;
  const childConfig = readJson(configPath);
  const confirmedRepository = path.resolve(immutableRepository || "");
  if (path.resolve(childConfig.repository || "") !== confirmedRepository) {
    throw new Error("child config attempted to mount a source other than the confirmed immutable bundle");
  }
  const args = [path.join(confirmedRepository, "scripts", "k6-home-open.js"), "--config", configPath,
    "--run-id", child.runId, "--mode", child.k6Mode, "--rate", String(child.rate),
    "--warmup-seconds", String(child.warmupSeconds), "--measurement-seconds",
    String(child.measurementSeconds), "--warmup-rate", String(child.warmupRate),
    "--repeat", String(child.repeat || 1), "--output-dir", path.join(outputRoot, child.runId),
    "--workflow-manifest", workflowManifestPath, "--workflow-child-event", childEventPath];
  const credentialPath = path.resolve(required(hostCredentialPath, "host credential temporary path"));
  if (!credentialPath.startsWith(`${os.tmpdir()}${path.sep}home-open-`) || !fs.existsSync(credentialPath)) {
    throw new Error("host credential temporary path is not an exact safe allocated directory");
  }
  let processError = null;
  try { await run(process.execPath, args, { cwd: confirmedRepository, stdio: "inherit",
    env: { ...environment, HOME_OPEN_CREDENTIAL_TEMP_DIR: credentialPath },
    timeoutMs: (child.warmupSeconds + child.measurementSeconds + UPPER_BOUNDS.resetSeconds +
      UPPER_BOUNDS.drainSeconds) * 1000 }); }
  catch (error) { processError = error; }
  finally { fs.rmSync(credentialPath, { recursive: true, force: true }); }
  if (fs.existsSync(credentialPath)) throw Object.assign(
    new Error("host credential path remained after child exit"), { stage: "cleanup" });
  const reportPath = resultPathFor({ root: outputRoot, runId: child.runId,
    mode: child.k6Mode, rate: child.rate });
  if (!fs.existsSync(reportPath)) throw Object.assign(processError ||
    new Error("verified per-level report is missing"), { stage: "evidence" });
  const report = readJson(reportPath);
  if (report?.schema !== "home-open-capacity-result-v1" || report.provenance?.runId !== child.runId ||
      typeof report.gates?.passed !== "boolean") throw Object.assign(
    new Error("verified per-level report is invalid"), { stage: "evidence" });
  const cleanupPath = reportPath.replace(/\.json$/, ".cleanup.json");
  if (!fs.existsSync(cleanupPath)) throw Object.assign(new Error("host credential cleanup evidence is missing"),
    { stage: "cleanup" });
  const credentialCleanup = readJson(cleanupPath);
  if (credentialCleanup.credentialsRetained !== false ||
      !Array.isArray(credentialCleanup.temporaryPaths) || credentialCleanup.temporaryPaths.some((item) =>
        typeof item !== "string" || !path.resolve(item).startsWith(`${os.tmpdir()}${path.sep}home-open-`) ||
        fs.existsSync(path.resolve(item)))) throw Object.assign(
    new Error("host credential temporary path cleanup was not proven"), { stage: "cleanup" });
  return { report, reportPath, processError, credentialPaths: credentialCleanup.temporaryPaths,
    credentialCleanupPath: cleanupPath };
}

function childTiming(kind, certificationLength = false) {
  if (kind === "smoke") return TIMINGS.smoke;
  return certificationLength || kind === "boundary" ? TIMINGS.certification : TIMINGS.scan;
}

function selectedChild({ manifest, kind, rate, ordinal = null, repeat = null, low = 1 }) {
  const timings = childTiming(kind, manifest.certificationLength);
  return { runId: childId(manifest.workflowId, { kind, rate, ordinal, repeat }), kind, rate,
    ordinal, repeat: repeat || 1, k6Mode: kind === "smoke" ? "smoke" : kind === "boundary" ? "boundary" : "level",
    warmupRate: Math.max(1, Math.min(rate - 1, low)), ...timings };
}

function reportHash(file) { return sha256(fs.readFileSync(file)); }

async function orchestrateConfirmedWorkflow({ manifest, directory, repository, configPath,
  sourceBundle, environment, fromScan = null, providerLock = null }, dependencies = {}) {
  const lima = dependencies.lima || require("./lima-capacity");
  const aggregate = dependencies.aggregate || require("./k6-home-open").aggregateHomeOpenLadder;
  const execute = dependencies.executeChild || executeHomeChild;
  const outputRoot = path.join(directory, "children");
  const manifestPath = path.join(directory, "confirmed-manifest.json");
  const workflowStartedAt = Date.now();
  const output = dependencies.output || process.stdout;
  let progress = { phase: "prepare", rate: null, nextAction: "prepare immutable environment" };
  const emitProgress = () => {
    const elapsedSeconds = Math.floor((Date.now() - workflowStartedAt) / 1000);
    const resetSamples = childArtifacts.map((row) => Number(row.resetSeconds)).filter(Number.isFinite);
    const drainSamples = childArtifacts.map((row) => Number(row.drainSeconds)).filter(Number.isFinite);
    const observedResetDrainSeconds = (resetSamples.length ? resetSamples.reduce((a, b) => a + b, 0) / resetSamples.length : UPPER_BOUNDS.resetSeconds) +
      (drainSamples.length ? drainSamples.reduce((a, b) => a + b, 0) / drainSamples.length : UPPER_BOUNDS.drainSeconds);
    const remainingChildren = Math.max(0, manifest.policy.maximumChildren - childArtifacts.length);
    const observedEstimate = remainingChildren * (TIMINGS.certification.warmupSeconds +
      TIMINGS.certification.measurementSeconds + observedResetDrainSeconds) + UPPER_BOUNDS.terminalCleanupSeconds;
    output.write(`${JSON.stringify({ event: "home_capacity_workflow_progress",
    workflowId: manifest.workflowId, ...progress, elapsedSeconds,
    estimatedRemainingSeconds: Math.max(0, Math.min(
      manifest.durationEstimate.worstCaseSeconds - elapsedSeconds, observedEstimate)),
    estimateUpdatedFromObservedResetDrain: childArtifacts.length > 0,
    observedResetDrainSeconds,
    offered: null, completed: null, failed: null, p95Ms: null, httpErrorRate: null,
    backendCpu: null, databaseCpu: null, poolPressure: null, resolutionQueue: null })}\n`);
  };
  const progressTimer = setInterval(emitProgress, 60_000); progressTimer.unref?.();
  const observations = [];
  const childArtifacts = [];
  let preparationEvidence = null;
  const phases = { prepareSeconds: 0, readinessSeconds: 0, loadSeconds: 0, cleanupSeconds: 0 };
  let signal = null;
  let activeChild = null;
  const interrupt = () => { signal = "SIGINT"; };
  process.once("SIGINT", interrupt);
  const runChild = async (child, selectingEvidence) => {
    if (signal) throw Object.assign(new Error("workflow interrupted"), { signal });
    verifySourceBundle(sourceBundle);
    const selectedEvent = appendJournalEvent({ directory, manifest, type: "child-selected",
      payload: { childId: child.runId, rate: child.rate, kind: child.kind, repeat: child.repeat,
        timings: { warmupSeconds: child.warmupSeconds, measurementSeconds: child.measurementSeconds },
        selectingEvidence } });
    const eventPath = path.join(eventDirectory(directory), `${String(selectedEvent.sequence).padStart(6, "0")}-child-selected.json`);
    activeChild = child;
    const childStartedAt = Date.now();
    progress = { phase: "reset", rate: child.rate, nextAction: `restore fresh state for ${child.runId}` };
    let resetEvidence;
    let hostCredentialPath = null;
    try {
      resetEvidence = await lima.resetWorkflowChild({ configPath, manifest, child,
        sourceBundle, environment, previousChild: childArtifacts.at(-1)?.child || null, providerLock });
      phases.readinessSeconds += Number(resetEvidence.resetDurationSeconds || 0);
      hostCredentialPath = fs.mkdtempSync(path.join(os.tmpdir(), `home-open-${child.runId}-`));
      appendJournalEvent({ directory, manifest, type: "child-started", payload: {
        childId: child.runId, childConfigHash: resetEvidence.childConfigHash,
        resetEvidenceHash: hashObject(resetEvidence), credentialPaths: [hostCredentialPath] } });
      progress = { phase: "load", rate: child.rate, nextAction: `run ${child.kind} load` };
      const executed = await execute({ repository, configPath: resetEvidence.configPath || configPath,
        child, workflowManifestPath: manifestPath, childEventPath: eventPath, outputRoot, environment,
        immutableRepository: sourceBundle.path, hostCredentialPath }, dependencies);
      fs.rmSync(hostCredentialPath, { recursive: true, force: true });
      if (fs.existsSync(hostCredentialPath)) throw Object.assign(
        new Error("host credential temporary path cleanup was not proven"), { stage: "cleanup" });
      phases.loadSeconds += Math.max(0, (Date.now() - childStartedAt) / 1000 -
        Number(resetEvidence.resetDurationSeconds || 0));
      const classification = classifyChildOutcome({ report: executed.report,
        signal: signal || executed.processError?.signal });
      const artifact = { child, classification, reportPath: executed.reportPath,
        reportHash: reportHash(executed.reportPath), resetEvidence, report: executed.report,
        credentialPaths: [...new Set([hostCredentialPath, ...(executed.credentialPaths || [])])],
        credentialCleanupPath: executed.credentialCleanupPath || null,
        elapsedSeconds: (Date.now() - childStartedAt) / 1000,
        resetSeconds: resetEvidence.resetDurationSeconds ?? null,
        drainSeconds: executed.report.queue?.drainSeconds ?? null };
      childArtifacts.push(artifact); observations.push({ rate: child.rate,
        passed: classification === "pass", kind: child.kind, runId: child.runId });
      appendJournalEvent({ directory, manifest,
        type: classification === "interrupted" ? "child-failed" : "child-completed", payload: {
          childId: child.runId, classification, reportPath: executed.reportPath,
          reportHash: artifact.reportHash, credentialPaths: artifact.credentialPaths,
          credentialCleanupPath: artifact.credentialCleanupPath } });
      if (classification === "interrupted") {
        throw Object.assign(new Error("workflow interrupted"), { signal: signal || executed.processError.signal,
          classification, journaled: true });
      }
      activeChild = null;
      return artifact;
    } catch (error) {
      if (hostCredentialPath) fs.rmSync(hostCredentialPath, { recursive: true, force: true });
      const classification = classifyChildOutcome({ stage: error.stage || "setup", error,
        signal: signal || error.signal });
      if (!error.journaled) appendJournalEvent({ directory, manifest, type: "child-failed", payload: {
        childId: child.runId, classification, message: error.message } });
      throw Object.assign(error, { classification });
    }
  };
  let result;
  let cleanup = { resetData: false, stopped: false, cacheRetained: false };
  try {
    verifySourceBundle(sourceBundle);
    const prepareStartedAt = Date.now();
    preparationEvidence = await lima.prepareWorkflowEnvironment({ configPath, manifest, sourceBundle,
      environment, providerLock });
    appendJournalEvent({ directory, manifest, type: "prepared", payload: preparationEvidence });
    phases.prepareSeconds = (Date.now() - prepareStartedAt) / 1000;
    const smoke = await runChild(selectedChild({ manifest, kind: "smoke", rate: 1 }), "required smoke");
    if (smoke.classification !== "pass") throw Object.assign(new Error("Home capacity smoke failed"),
      { classification: "capacity-failure" });
    if (manifest.mode === "level") {
      const level = await runChild(selectedChild({ manifest, kind: "level", rate: manifest.rate ||
        manifest.policy.startRate, ordinal: 1, low: 1 }), "requested diagnostic level");
      result = { schema: RESULT_SCHEMA, mode: "level", completed: true,
        classification: level.classification === "pass" ? "diagnostic-pass" : "capacity-failure",
        rate: level.child.rate, childArtifacts };
    } else {
      let low = 1; let high = null; let ordinal = 0;
      const reusable = fromScan?.observations || null;
      if (manifest.mode === "certify" && reusable) observations.push(...reusable);
      if (!reusable) {
        for (const rate of buildInitialRates(manifest.policy)) {
          ordinal += 1;
          const artifact = await runChild(selectedChild({ manifest, kind: "discovery", rate,
            ordinal, low }), { algorithm: "initial", low, high });
          if (artifact.classification === "pass") low = rate;
          else { high = rate; break; }
        }
        while (high != null) {
          const rate = nextBracketRate({ low, high });
          if (rate == null) break;
          ordinal += 1;
          const artifact = await runChild(selectedChild({ manifest, kind: "discovery", rate,
            ordinal, low }), { algorithm: "midpoint", low, high });
          if (artifact.classification === "pass") low = rate; else high = rate;
        }
      } else {
        low = Math.max(...observations.filter((row) => row.passed).map((row) => row.rate));
        high = observations.filter((row) => !row.passed).map((row) => row.rate)
          .filter((rate) => rate > low).sort((left, right) => left - right)[0] || null;
      }
      if (manifest.mode === "scan") result = { schema: RESULT_SCHEMA, mode: "scan", completed: true,
        classification: high == null ? "scan-lower-bound" : "scan-range", highestPass: low,
        firstFailure: high, observations, childArtifacts,
        likelyConstraint: inferLikelyConstraint(childArtifacts.find((row) =>
          row.child.rate === high && row.classification === "capacity-failure")?.report),
        passingEvidence: boundaryMetrics(childArtifacts.filter((row) => row.classification === "pass").at(-1)?.report),
        failureEvidence: high == null ? null : boundaryMetrics(childArtifacts.find((row) =>
          row.child.rate === high && row.classification === "capacity-failure")?.report),
        certificationCommand: `npm run capacity:home -- certify --from-scan ${path.join(directory, "workflow-result.json")}`,
        ...boundaryMetrics(childArtifacts.filter((row) => row.classification === "pass").at(-1)?.report) };
      else {
        let certified = null; let supporting = [];
        for (const candidate of certificationCandidates(observations)) {
          const repeats = [];
          for (let repeat = 1; repeat <= 3; repeat += 1) {
            const artifact = await runChild(selectedChild({ manifest, kind: "boundary",
              rate: candidate, repeat, low: Math.max(1, candidate - 1) }),
            { algorithm: "certification", candidate, repeat });
            if (artifact.classification !== "pass") { high = high == null ? candidate : Math.min(high, candidate); break; }
            repeats.push(artifact);
          }
          if (repeats.length === 3) { certified = candidate; supporting = repeats; break; }
        }
        if (certified == null) throw Object.assign(new Error("no discovery candidate passed three fresh repeats"),
          { classification: "capacity-failure" });
        const failureArtifact = childArtifacts.find((row) =>
          row.child.rate === high && row.classification === "capacity-failure");
        const aggregation = aggregate(supporting.map((row) => row.report), {
          failureBound: high, maxRate: manifest.policy.maxRate,
          failureReport: failureArtifact?.report || null,
        });
        result = { schema: RESULT_SCHEMA, mode: "certify", completed: true,
          classification: high == null && certified === manifest.policy.maxRate ? "certified-lower-bound" : "certified",
          certifiedRate: certified, lowerBound: high == null ? certified : null,
          operatingCeiling: high == null ? null : Math.floor(certified * 0.7),
          failureBound: high, supportingRuns: supporting.map((row) => row.child.runId),
          aggregation, observations, childArtifacts,
          passingEvidence: aggregation.passingEvidence,
          failureEvidence: aggregation.failureEvidence,
          ...boundaryMetrics(supporting.at(-1)?.report),
          likelyConstraint: inferLikelyConstraint(failureArtifact?.report) };
      }
    }
  } catch (error) {
    result = { schema: RESULT_SCHEMA, mode: manifest.mode, completed: false,
      classification: error.classification || (signal ? "interrupted" : "setup-failure"),
      interruption: signal, error: error.message, observations, childArtifacts,
      staleCleanupCommand: activeChild ? `node scripts/lima-capacity.js reset-data --config ${JSON.stringify(configPath)} --workflow-manifest ${JSON.stringify(manifestPath)}` : null };
  } finally {
    progress = { phase: "cleanup", rate: activeChild?.rate || null,
      nextAction: "delete disposable data and stop VM" };
    const cleanupStartedAt = Date.now();
    try { cleanup = await lima.cleanupWorkflowEnvironment({ configPath, manifest,
      children: childArtifacts.map((row) => row.child), activeChild, retainCache: true,
      providerLock, credentialPaths: childArtifacts.flatMap((row) => row.credentialPaths || []),
      cacheVolume: preparationEvidence?.cacheVolume || null,
      cacheBindingHash: preparationEvidence?.binding?.hash || null }); }
    catch (error) { cleanup = { ...cleanup, error: error.message }; result.completed = false;
      result.classification = "cleanup-failure"; }
    phases.cleanupSeconds = (Date.now() - cleanupStartedAt) / 1000;
    process.removeListener("SIGINT", interrupt);
  }
  clearInterval(progressTimer);
  result = { ...result, workflowId: manifest.workflowId, manifestHash: manifest.hash,
    commit: manifest.commit, sourceBundleHash: manifest.sourceBundleHash,
    cleanup, elapsed: { totalSeconds: (Date.now() - workflowStartedAt) / 1000,
      phases,
      children: childArtifacts.map((row) => ({ runId: row.child.runId,
        seconds: row.elapsedSeconds, resetSeconds: row.resetSeconds,
        drainSeconds: row.drainSeconds })) },
    binding: { commit: manifest.commit, sourceBundleHash: manifest.sourceBundleHash,
      profileVersion: manifest.profileVersion, reportVersion: manifest.reportVersion,
      snapshotHash: manifest.snapshotHash, scrubAttestationHash: manifest.scrubAttestationHash,
      parityHash: manifest.parityHash, resourceManifestHash: manifest.resourceManifestHash,
      topologyHash: manifest.topologyHash, effectiveEnvironmentHash: manifest.effectiveEnvironmentHash,
      configHash: manifest.configHash, snapshotMetadataHash: manifest.snapshotMetadataHash,
      migrationHash: manifest.migrationHash, timingPolicyHash: hashObject(manifest.policy.timings),
      rateBoundsHash: hashObject({ startRate: manifest.policy.startRate, maxRate: manifest.policy.maxRate }) } };
  result.childArtifacts = childArtifacts.map(({ report, ...artifact }) => artifact);
  if (cleanup.resetData === true) result.staleCleanupCommand = null;
  else result.staleCleanupCommand = `node scripts/lima-capacity.js reset-data --config ${JSON.stringify(configPath)} --workflow-manifest ${JSON.stringify(manifestPath)}`;
  const resultPayloadHash = hashObject(result);
  const terminal = appendJournalEvent({ directory, manifest, type: "terminal", payload: {
    classification: result.classification, completed: result.completed, cleanup, resultPayloadHash } });
  result = { ...result, resultPayloadHash, journalTerminalHash: terminal.hash };
  writeTerminalArtifacts({ directory, result });
  return result;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const repository = path.resolve(__dirname, "..");
  const configPath = path.resolve(repository, cli.config);
  const config = readJson(configPath);
  if (config.target !== "capacity-vm" || config.db_name !== "steps_tracker_capacity" ||
      config.provider !== "lima" || path.resolve(config.repository || "") !== repository) {
    throw new Error("Home capacity only accepts the approved disposable Lima target and current repository");
  }
  const requiredShape = { backendVcpu: 4, backendRamGb: 8, diskGb: 160,
    databaseVcpu: 1, databaseRamGb: 2, databaseDiskGib: 30, connectionLimit: 47 };
  const actualShape = { backendVcpu: Number(config.vps_specs?.vcpu),
    backendRamGb: Number(config.vps_specs?.ram_gb), diskGb: Number(config.vps_specs?.disk_gb),
    databaseVcpu: Number(config.database_specs?.vcpu),
    databaseRamGb: Number(config.database_specs?.ram_gb),
    databaseDiskGib: Number(config.database_specs?.disk_gib),
    connectionLimit: Number(config.database_specs?.connection_limit) };
  if (canonical(actualShape) !== canonical(requiredShape)) {
    throw new Error("Home capacity config does not match the approved production-shaped resources");
  }
  const local = loadLocalEnvironment(repository);
  for (const name of SECRET_ENV_ALLOWLIST) if (!String(local[name] || "").trim()) {
    throw new Error(`missing local capacity secret: ${name}`);
  }
  const environment = { ...local, CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_GLOBAL_EVENT_PROFILE: "home-open", CAPACITY_DATABASE_POOL_PROFILE: "role-budget" };
  const commit = assertCleanSource(repository, cli.expectCommit);
  const childPath = prerequisitePath(["k6", "limactl", "pg_restore", "psql"]);
  for (const command of [["k6", ["version"]], ["limactl", ["--version"]]]) {
    try { execFileSync(command[0], command[1], { stdio: "ignore", timeout: 10_000,
      killSignal: "SIGKILL" }); }
    catch { throw new Error(`missing capacity prerequisite: ${command[0]}`); }
  }
  const verifiedInputs = validateSnapshotInputs({ config, localEnvironment: local });
  const workflowsRoot = path.join(repository, "results", "capacity", "home-open", "workflows");
  fs.mkdirSync(workflowsRoot, { recursive: true, mode: 0o700 });
  const workflowId = uniqueWorkflowId(generateWorkflowId({ commit }), workflowsRoot);
  const directory = path.join(workflowsRoot, workflowId);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const sourceBundle = createSourceBundle({ repository, output: path.join(directory, "source") });
  const snapshot = verifiedInputs.snapshot;
  const parityPath = path.join(repository, ".env.capacity-prod-flags");
  if (!fs.existsSync(parityPath)) throw new Error("missing production parity overlay");
  const parity = dotenv.parse(fs.readFileSync(parityPath));
  assertHomeCapacityParityOverlay(parity);
  const effective = buildEffectiveEnvironment({ capacity: {
    CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_GLOBAL_EVENT_PROFILE: "home-open", CAPACITY_DATABASE_POOL_PROFILE: "role-budget",
    NODE_ENV: "production", PATH: childPath,
  }, parity, secrets: Object.fromEntries([...SECRET_ENV_ALLOWLIST].filter((name) => local[name] != null)
    .map((name) => [name, local[name]])), hmacKey: local.CAPACITY_SCRUB_ATTESTATION_SECRET });
  const effectiveEnvironmentEvidencePath = path.join(directory, "effective-environment.json");
  durableAtomicWrite(effectiveEnvironmentEvidencePath, `${JSON.stringify(effective.report, null, 2)}\n`);
  let scan = null;
  let scanBytes = null;
  let fromScanPassingCount = null;
  if (cli.fromScan) {
    scanBytes = fs.readFileSync(path.resolve(cli.fromScan));
    const candidate = JSON.parse(scanBytes.toString("utf8"));
    fromScanPassingCount = certificationCandidates(candidate.observations || []).length;
  }
  const manifest = buildWorkflowManifest({ workflowId, mode: cli.mode, commit,
    sourceBundleHash: sourceBundle.hash, snapshotHash: snapshot.snapshotHash,
    scrubAttestationHash: sha256(fs.readFileSync(verifiedInputs.attestationPath)),
    parityHash: sha256(fs.readFileSync(parityPath)),
    resourceManifestHash: hashObject(verifiedInputs.liveManifest),
    effectiveEnvironmentHash: effective.report.hash, configHash: sha256(fs.readFileSync(configPath)),
    effectiveEnvironmentEvidencePath,
    snapshotMetadataHash: sha256(fs.readFileSync(verifiedInputs.metadataPath)),
    startRate: cli.startRate, maxRate: cli.maxRate,
    provider: { instance: config.lima_instance, target: config.target,
      database: config.db_name, dbHostPort: Number(config.db_host_port) },
    fromScan: scanBytes ? sha256(scanBytes) : null,
    fromScanPassingCount, certificationLength: cli.certificationLength, rate: cli.rate,
    migrationHash: sourceSubsetHash(sourceBundle, "prisma/migrations"),
    topologyHash: hashObject({ processes: { http: 2, resolution: 1, cron: 1 },
      pools: { http0: 10, http1: 10, resolution: 8, cron: 4 },
      resolutionConcurrency: 2 }),
  });
  const binding = { commit: manifest.commit, sourceBundleHash: manifest.sourceBundleHash,
    profileVersion: manifest.profileVersion, reportVersion: manifest.reportVersion,
    snapshotHash: manifest.snapshotHash, scrubAttestationHash: manifest.scrubAttestationHash,
    parityHash: manifest.parityHash, resourceManifestHash: manifest.resourceManifestHash,
    topologyHash: manifest.topologyHash, effectiveEnvironmentHash: manifest.effectiveEnvironmentHash,
    configHash: manifest.configHash, snapshotMetadataHash: manifest.snapshotMetadataHash,
    migrationHash: manifest.migrationHash, timingPolicyHash: hashObject(manifest.policy.timings),
    rateBoundsHash: hashObject({ startRate: manifest.policy.startRate, maxRate: manifest.policy.maxRate }) };
  if (cli.fromScan) {
    scan = verifyReusableScan({ resultPath: cli.fromScan, resultBytes: scanBytes, expectedBinding: binding,
      expectedMaxRate: cli.maxRate });
    fromScanPassingCount = certificationCandidates(scan.observations).length;
    if (manifest.policy.maximumChildren !== maximumChildren({ mode: manifest.mode,
      startRate: manifest.policy.startRate, maxRate: manifest.policy.maxRate, fromScanPassingCount })) {
      throw new Error("scan candidate count changed after manifest confirmation");
    }
  }
  fs.writeFileSync(path.join(directory, "confirmed-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  const lima = require("./lima-capacity");
  let result;
  try {
    result = await lima.withProviderLock({ directory: workflowsRoot,
      instance: config.lima_instance, workflowId,
      resourceCensus: lima.providerResourceCensus }, async (providerLock) => {
      lima.assertProviderIsolation({ configPath, workflowId });
      await confirmManifest(manifest);
      appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
      const workflowResult = await orchestrateConfirmedWorkflow({ manifest, directory, repository, configPath,
        sourceBundle, environment: { ...effective.environment,
          CAPACITY_WORKFLOW_MANIFEST: path.join(directory, "confirmed-manifest.json") },
        fromScan: scan?.result ? scan : null, providerLock });
      if (workflowResult.cleanup?.resetData !== true) throw Object.assign(
        new Error(`workflow cleanup incomplete\nExact stale-workflow cleanup: ${workflowResult.staleCleanupCommand}`),
        { retainProviderLock: true });
      return workflowResult;
    });
  } catch (error) {
    const lockFile = path.join(workflowsRoot, `${config.lima_instance}.provider.lock.json`);
    let cleanup = null;
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      const existingManifest = path.join(workflowsRoot, owner.workflowId, "confirmed-manifest.json");
      if (fs.existsSync(existingManifest)) cleanup =
        `node scripts/lima-capacity.js reset-data --config ${JSON.stringify(configPath)} --workflow-manifest ${JSON.stringify(existingManifest)}`;
    } catch {}
    throw new Error(cleanup ? `${error.message}\nExact stale-workflow cleanup: ${cleanup}` : error.message);
  }
  process.stdout.write(renderSummary(result));
  process.exitCode = workflowExitCode(result);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1;
});

module.exports = {
  HARNESS_POLICY,
  appendJournalEvent,
  assertCleanSource,
  buildEffectiveEnvironment,
  buildInitialRates,
  buildWorkflowManifest,
  canonical,
  certificationCandidates,
  classifyChildOutcome,
  confirmManifest,
  createSourceBundle,
  durationEstimate,
  executeHomeChild,
  generateWorkflowId,
  hashObject,
  inferLikelyConstraint,
  isScanCompatible,
  nextBracketRate,
  orchestrateConfirmedWorkflow,
  parseCli,
  renderSummary,
  scanBracketTolerance,
  uniqueWorkflowId,
  verifyJournal,
  verifyReusableScan,
  verifySourceBundle,
  validateSnapshotInputs,
  writeTerminalArtifacts,
  workflowExitCode,
};
