const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  HARNESS_POLICY,
  appendJournalEvent,
  buildEffectiveEnvironment,
  buildInitialRates,
  buildWorkflowManifest,
  certificationCandidates,
  classifyChildOutcome,
  createSourceBundle,
  durationEstimate,
  generateWorkflowId,
  hashObject,
  isScanCompatible,
  verifyReusableScan,
  scanBracketTolerance,
  inferLikelyConstraint,
  nextBracketRate,
  orchestrateConfirmedWorkflow,
  parseCli,
  renderSummary,
  verifyJournal,
  verifySourceBundle,
  writeTerminalArtifacts,
  workflowExitCode,
} = require("../../../scripts/home-capacity-workflow");
const {
  PROVIDER_OPERATION_TIMEOUT_MS,
  assertProviderIsolation,
  assertProviderLock,
  assertDeleteVmConfirmation,
  assertLegacyProviderAvailable,
  assertOwnedResource,
  providerResourceNames,
  removeOwnedResource,
  removeHostCredentialPaths,
  normalizedEnvironmentBinding,
  validateAppliedMigrations,
  validatedWorkflowRoot,
  withProviderLock,
} = require("../../../scripts/lima-capacity");
const { executeHomeOpenLevel } = require("../../../scripts/k6-home-open");
const { aggregateHomeOpenLadder } = require("../../../scripts/k6-home-open");
const { HOME_CAPACITY_PARITY_ENV_NAMES,
  assertHomeCapacityParityOverlay } = require("../../../src/modules/loadTesting/homeCapacityEnvironment");

function temporary(context, prefix = "home-capacity-workflow-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("home capacity CLI locks scan, certify, and level as the only public modes", () => {
  assert.deepEqual(parseCli(["scan"]), {
    mode: "scan", config: "docs/capacity-load.config.json", expectCommit: null,
    startRate: 2, maxRate: 500, fromScan: null, rate: null,
    certificationLength: false,
  });
  assert.deepEqual(parseCli(["certify", "--start-rate", "5", "--max-rate", "100",
    "--from-scan", "/tmp/scan.json"]), {
    mode: "certify", config: "docs/capacity-load.config.json", expectCommit: null,
    startRate: 5, maxRate: 100, fromScan: "/tmp/scan.json", rate: null,
    certificationLength: false,
  });
  assert.equal(parseCli(["level", "--rate", "24", "--certification-length"]).rate, 24);
  for (const argv of [[], ["other"], ["scan", "--target", "prod"],
    ["scan", "--start-rate", "1"], ["scan", "--max-rate", "501"],
    ["scan", "--start-rate", "30", "--max-rate", "20"], ["level"],
    ["scan", "--rate", "2"], ["level", "--from-scan", "x"]]) {
    assert.throws(() => parseCli(argv), /usage|unsupported|rate|requires|only/i, argv.join(" "));
  }
});

test("workflow and child IDs are deterministic descendants, safe, and bounded", () => {
  const id = generateWorkflowId({ now: new Date("2026-09-01T20:44:05Z"), commit: "52ac28a9" });
  assert.equal(id, "home-20260901t204405-52ac28a");
  assert.match(HARNESS_POLICY.childId(id, { kind: "discovery", rate: 24, ordinal: 3 }),
    /^home-20260901t204405-52ac28a-discovery-r24-n3$/);
  assert.match(HARNESS_POLICY.childId(id, { kind: "boundary", rate: 24, repeat: 2 }),
    /-boundary-r24-p2$/);
  assert.throws(() => HARNESS_POLICY.childId(id, { kind: "boundary", rate: 501, repeat: 1 }), /rate/);
  assert.ok(HARNESS_POLICY.childId(id, { kind: "smoke", rate: 1 }).length <= 64);
});

test("adaptive rate selection follows the confirmed deterministic policy", () => {
  assert.deepEqual(buildInitialRates({ startRate: 2, maxRate: 24 }), [2, 5, 10, 20, 24]);
  assert.deepEqual(buildInitialRates({ startRate: 7, maxRate: 7 }), [7]);
  assert.equal(nextBracketRate({ low: 20, high: 30 }), 25);
  assert.equal(nextBracketRate({ low: 24, high: 26 }), null);
  assert.equal(nextBracketRate({ low: 1, high: 2 }), null);
  assert.deepEqual(certificationCandidates([
    { rate: 1, passed: true, kind: "smoke" }, { rate: 10, passed: true },
    { rate: 20, passed: false }, { rate: 15, passed: true },
  ]), [15, 10, 1]);
});

test("manifest binds exact policy, finite duration estimate, and maximum child budget", () => {
  const common = {
    workflowId: "home-20260901t204405-52ac28a", mode: "certify",
    commit: "a".repeat(40), sourceBundleHash: "b".repeat(64),
    snapshotHash: "c".repeat(64), scrubAttestationHash: "d".repeat(64),
    parityHash: "e".repeat(64), resourceManifestHash: "f".repeat(64),
    effectiveEnvironmentHash: "1".repeat(64), configHash: "2".repeat(64),
    snapshotMetadataHash: "3".repeat(64), startRate: 2, maxRate: 100,
    provider: { instance: "step-capacity", target: "capacity-vm",
      database: "steps_tracker_capacity", dbHostPort: 55433 },
  };
  const manifest = buildWorkflowManifest(common);
  assert.equal(manifest.schema, "home-capacity-workflow-manifest-v1");
  assert.equal(manifest.policy.timings.scan.warmupSeconds, 30);
  assert.equal(manifest.policy.timings.scan.measurementSeconds, 120);
  assert.equal(manifest.policy.timings.certification.measurementSeconds, 600);
  assert.equal(manifest.policy.timings.smoke.measurementSeconds, 60);
  assert.ok(manifest.policy.maximumChildren >= 1);
  assert.ok(manifest.durationEstimate.bestCaseSeconds > 0);
  assert.ok(manifest.durationEstimate.worstCaseSeconds >= manifest.durationEstimate.bestCaseSeconds);
  assert.equal(durationEstimate(manifest).bounded, true);
  assert.match(manifest.hash, /^[a-f0-9]{64}$/);
});

test("outcome classifications never turn setup, evidence, cleanup, or interruption into capacity", () => {
  assert.equal(classifyChildOutcome({ report: { gates: { passed: true } } }), "pass");
  assert.equal(classifyChildOutcome({ report: { gates: { passed: false } } }), "capacity-failure");
  assert.equal(classifyChildOutcome({ stage: "setup", error: new Error("x") }), "setup-failure");
  assert.equal(classifyChildOutcome({ stage: "evidence", error: new Error("x") }), "evidence-failure");
  assert.equal(classifyChildOutcome({ stage: "cleanup", error: new Error("x") }), "cleanup-failure");
  assert.equal(classifyChildOutcome({ signal: "SIGINT" }), "interrupted");
});

test("immutable source bundle includes tracked HEAD only and rejects checkout drift and escaping symlinks", (context) => {
  const repository = temporary(context, "home-capacity-source-");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "capacity-test@synthetic.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Capacity Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "tracked.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repository, ".gitignore"), ".env*\nresults/\n");
  execFileSync("git", ["add", ".gitignore", "tracked.js"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  fs.writeFileSync(path.join(repository, ".env.capacity.local"), "SECRET=nope\n");
  fs.mkdirSync(path.join(repository, "results"));
  fs.writeFileSync(path.join(repository, "results", "live.json"), "{}\n");
  const output = path.join(temporary(context), "source");
  const bundle = createSourceBundle({ repository, output });
  assert.equal(fs.readFileSync(path.join(output, "tracked.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(fs.existsSync(path.join(output, ".env.capacity.local")), false);
  assert.equal(fs.existsSync(path.join(output, "results")), false);
  assert.equal(fs.statSync(path.join(output, "node_modules")).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(output, "node_modules")), []);
  assert.equal(verifySourceBundle(bundle).valid, true);
  fs.writeFileSync(path.join(repository, "tracked.js"), "module.exports = 2;\n");
  assert.equal(verifySourceBundle(bundle).valid, true, "live-checkout edits cannot affect the bundle");
  fs.chmodSync(output, 0o700); fs.chmodSync(path.join(output, "tracked.js"), 0o600);
  fs.writeFileSync(path.join(output, "tracked.js"), "tampered\n");
  assert.throws(() => verifySourceBundle(bundle), /bundle.*changed|hash/i);

  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: repository });
  fs.symlinkSync("/etc/passwd", path.join(repository, "escape"));
  execFileSync("git", ["add", "escape"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "escape"], { cwd: repository });
  assert.throws(() => createSourceBundle({ repository, output: path.join(temporary(context), "bad") }),
    /symlink.*escapes|escaping symlink/i);
});

test("child environments are allowlisted and secrets are HMAC fingerprinted, never reported", () => {
  const first = buildEffectiveEnvironment({
    capacity: { CAPACITY_MODE: "true", CAPACITY_RUN_ID: "run-safe", NODE_ENV: "production" },
    parity: { RACE_RESOLVE_DEBOUNCE_MS: "1000" },
    secrets: { CAPACITY_DB_PASSWORD: "secret-one", CAPACITY_AUTH_SECRET: "auth-one" },
    hmacKey: "test-fingerprint-key-material",
  });
  const second = buildEffectiveEnvironment({
    capacity: { CAPACITY_MODE: "true", CAPACITY_RUN_ID: "run-safe", NODE_ENV: "production" },
    parity: { RACE_RESOLVE_DEBOUNCE_MS: "1000" },
    secrets: { CAPACITY_DB_PASSWORD: "secret-two", CAPACITY_AUTH_SECRET: "auth-one" },
    hmacKey: "test-fingerprint-key-material",
  });
  assert.equal(first.environment.CAPACITY_MODE, "true");
  assert.equal(first.environment.HOME, undefined);
  assert.equal(JSON.stringify(first.report).includes("secret-one"), false);
  assert.notEqual(first.report.secretFingerprints.CAPACITY_DB_PASSWORD,
    second.report.secretFingerprints.CAPACITY_DB_PASSWORD);
});

test("production parity injection is an exact non-secret allowlist", () => {
  const overlay = Object.fromEntries(HOME_CAPACITY_PARITY_ENV_NAMES.map((name) => [name, "safe"]));
  assert.equal(assertHomeCapacityParityOverlay(overlay), true);
  assert.throws(() => assertHomeCapacityParityOverlay({ ...overlay,
    DATABASE_URL: "postgresql://prod" }), /unknown: DATABASE_URL/);
  const missing = { ...overlay }; delete missing.NODE_ENV;
  assert.throws(() => assertHomeCapacityParityOverlay(missing), /missing: NODE_ENV/);
});

test("journal is immutable, hash-linked, and rejects gaps, mutation, and unconfirmed children", (context) => {
  const directory = temporary(context);
  const manifest = { workflowId: "home-20260901t204405-52ac28a", hash: "a".repeat(64),
    policy: { maximumChildren: 2, startRate: 2, maxRate: 20 } };
  const first = appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
  appendJournalEvent({ directory, manifest, type: "prepared", payload: {} });
  const second = appendJournalEvent({ directory, manifest, type: "child-selected",
    payload: { childId: "home-20260901t204405-52ac28a-discovery-r10-n1", rate: 10,
      kind: "discovery", repeat: 1, timings: { warmupSeconds: 30, measurementSeconds: 120 } } });
  assert.notEqual(second.previousHash, first.hash);
  assert.equal(verifyJournal({ directory, manifest }).events.length, 4);
  assert.throws(() => appendJournalEvent({ directory, manifest, type: "child-selected",
    payload: { childId: "foreign", rate: 10, kind: "discovery", repeat: 1,
      timings: { warmupSeconds: 30, measurementSeconds: 120 } } }), /descendant|child/i);
  const file = path.join(directory, "events", "000004-child-selected.json");
  const changed = JSON.parse(fs.readFileSync(file)); changed.payload.rate = 11;
  fs.writeFileSync(file, `${JSON.stringify(changed)}\n`);
  assert.throws(() => verifyJournal({ directory, manifest }), /hash|altered/i);
});

test("provider deletion requires safe names, exact labels, and an exclusive live-owner lock", async (context) => {
  const workflowId = "home-20260901t204405-52ac28a";
  const childId = `${workflowId}-discovery-r10-n1`;
  const names = providerResourceNames({ instance: "step-capacity", workflowId, childId });
  assert.match(names.postgresContainer, /^step-capacity-home-/);
  assert.notEqual(names.postgresContainer, names.redisContainer);
  const labels = { "com.bara.capacity.workflow": workflowId,
    "com.bara.capacity.child": childId, "com.bara.capacity.owner": "home-capacity-workflow-v1" };
  assert.equal(assertOwnedResource({ name: names.postgresContainer, labels, workflowId, childId }), true);
  assert.throws(() => assertOwnedResource({ name: names.postgresContainer,
    labels: { ...labels, "com.bara.capacity.child": "other" }, workflowId, childId }), /ownership/);
  assert.throws(() => providerResourceNames({ instance: "../../prod", workflowId, childId }), /safe/);

  const lockDirectory = temporary(context);
  let release;
  const active = withProviderLock({ directory: lockDirectory, instance: "step-capacity", workflowId },
    () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(withProviderLock({ directory: lockDirectory, instance: "step-capacity",
    workflowId: `${workflowId}-other` }, async () => {}), /locked/);
  release(); await active;

  const lockFile = path.join(lockDirectory, "step-capacity.provider.lock.json");
  fs.writeFileSync(lockFile, `${JSON.stringify({ workflowId, instance: "step-capacity", token: "right" })}\n`);
  assert.throws(() => assertProviderLock({ file: lockFile, workflowId,
    instance: "step-capacity", token: "wrong" }), /lock.*changed|token/i);
  assert.equal(assertProviderLock({ file: lockFile, workflowId,
    instance: "step-capacity", token: "right" }), true);
  let deleted = false;
  assert.throws(() => removeOwnedResource({}, { type: "container", name: names.postgresContainer,
    workflowId, childId }, { inspect: () => labels, mutate: () => { deleted = true; } }), /lock/i);
  assert.equal(deleted, false);
  let present = true;
  assert.equal(removeOwnedResource({}, { type: "container", name: names.postgresContainer,
    workflowId, childId, providerLock: { file: lockFile, workflowId,
      instance: "step-capacity", token: "right" } }, {
    inspect: () => present ? (present = false, labels) : null,
    mutate: () => { deleted = true; },
  }).removed, true);
  assert.throws(() => assertLegacyProviderAvailable({ instance: "step-capacity",
    directory: lockDirectory }), /workflow owns provider/i);
});

test("host credential cleanup removes only exact home-open temporary paths and proves absence", (context) => {
  assert.ok(Number.isFinite(PROVIDER_OPERATION_TIMEOUT_MS));
  assert.ok(PROVIDER_OPERATION_TIMEOUT_MS > 0);
  const credentialPath = temporary(context, "home-open-credentials-");
  fs.writeFileSync(path.join(credentialPath, "fixture.json"), "token\n");
  assert.deepEqual(removeHostCredentialPaths([credentialPath]), {
    credentialPathsRemoved: 1, credentialsRetained: false });
  assert.equal(fs.existsSync(credentialPath), false);
  assert.throws(() => removeHostCredentialPaths([path.join(os.tmpdir(), "foreign-capacity")]), /unsafe/);
});

test("cleanup proves the retained cache while Lima is running, then stops it last", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const body = source.slice(source.indexOf("function cleanupWorkflowEnvironment"),
    source.indexOf("async function recoverWorkflowData"));
  assert.ok(body.indexOf(".home-capacity-cache-ready") < body.indexOf("[\"stop\", \"--force\""));
});

test("first dependency preparation can populate an empty cache over the network", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const body = source.slice(source.indexOf("function prepareWorkflowEnvironment"),
    source.indexOf("function workflowChildEnvironment"));
  assert.match(body, /npm ci --ignore-scripts/);
  assert.doesNotMatch(body, /docker run --rm --network none/);
});

test("scan reuse requires exact bindings and terminal reporting is immutable and terminology-safe", (context) => {
  const binding = Object.fromEntries(["commit", "sourceBundleHash", "profileVersion", "reportVersion",
    "snapshotHash", "scrubAttestationHash", "parityHash", "resourceManifestHash", "topologyHash",
    "effectiveEnvironmentHash", "configHash", "snapshotMetadataHash", "migrationHash",
    "timingPolicyHash", "rateBoundsHash"]
    .map((name) => [name, crypto.createHash("sha256").update(name).digest("hex")]));
  const scan = { schema: "home-capacity-workflow-result-v1", mode: "scan", completed: true, binding };
  assert.equal(isScanCompatible(scan, binding), true);
  assert.equal(isScanCompatible(scan, { ...binding, sourceBundleHash: "other" }), false);
  const directory = temporary(context);
  const result = { schema: "home-capacity-workflow-result-v1", mode: "scan", completed: true,
    classification: "scan-range", highestPass: 20, firstFailure: 30, binding,
    cleanup: { resetData: true, stopped: true, cacheRetained: true } };
  const written = writeTerminalArtifacts({ directory, result });
  const summary = fs.readFileSync(written.summaryPath, "utf8");
  assert.match(summary, /Provisional passing rate: 20\/sec/);
  assert.match(summary, /First observed failing rate: 30\/sec/);
  assert.doesNotMatch(summary, /supported ceiling|certified maximum/i);
  assert.throws(() => writeTerminalArtifacts({ directory, result }), /exists|immutable/i);
  assert.equal(renderSummary({ ...result, mode: "certify", classification: "certified",
    certifiedRate: 20, operatingCeiling: 14, supportingRuns: ["a", "b", "c"] })
    .includes("Highest certified tested rate: 20/sec"), true);
  assert.equal(workflowExitCode({ mode: "level", completed: true,
    classification: "capacity-failure" }), 1);
  assert.equal(workflowExitCode({ mode: "level", completed: true,
    classification: "diagnostic-pass" }), 0);
});

test("scan reuse accepts only the approved absolute-or-10-percent bracket tolerance", () => {
  assert.equal(scanBracketTolerance(10), 2);
  assert.equal(scanBracketTolerance(40), 4);
  assert.equal(scanBracketTolerance(101), 11);
});

test("normalized repeat environment excludes only intentional child identity values", () => {
  const one = normalizedEnvironmentBinding({ CAPACITY_RUN_ID: "child-1",
    CACHE_ENV_PREFIX: "capacity:child-1:", DATABASE_URL: "postgresql://db/child",
    NODE_ENV: "production", ASYNC_RACE_RESOLUTION_CONCURRENCY: "2" });
  const two = normalizedEnvironmentBinding({ CAPACITY_RUN_ID: "child-2",
    CACHE_ENV_PREFIX: "capacity:child-2:", DATABASE_URL: "postgresql://db/child",
    NODE_ENV: "production", ASYNC_RACE_RESOLUTION_CONCURRENCY: "2" });
  assert.equal(one.hash, two.hash);
  assert.notEqual(one.childHash, two.childHash);
  assert.notEqual(one.hash, normalizedEnvironmentBinding({ CAPACITY_RUN_ID: "child-3",
    CACHE_ENV_PREFIX: "capacity:child-3:", DATABASE_URL: "postgresql://db/child",
    NODE_ENV: "production", ASYNC_RACE_RESOLUTION_CONCURRENCY: "3" }).hash);
});

test("applied migration evidence is exact, successful, and timestamp-independent", () => {
  const expected = ["001_first", "002_second"];
  const rows = expected.map((migration_name, index) => ({ migration_name,
    checksum: String(index + 1).repeat(64), finished_at: `2026-09-01T00:00:0${index}Z`, rolled_back_at: null }));
  const expectedChecksums = Object.fromEntries(rows.map((row) => [row.migration_name, row.checksum]));
  const first = validateAppliedMigrations(expected, rows, { expectedChecksums });
  const later = validateAppliedMigrations(expected, rows.map((row) => ({ ...row,
    finished_at: "2026-09-02T00:00:00Z" })), { expectedChecksums });
  assert.equal(first.hash, later.hash);
  for (const invalid of [[...rows, { ...rows[0], migration_name: "003_extra" }],
    rows.map((row, index) => index ? row : { ...row, finished_at: null }),
    rows.map((row, index) => index ? row : { ...row, rolled_back_at: "2026-09-02" })]) {
    assert.throws(() => validateAppliedMigrations(expected, invalid), /exact|successful|rolled/i);
  }
  assert.throws(() => validateAppliedMigrations(expected,
    [...rows, { migration_name: "003_extra", checksum: "sum-extra",
      finished_at: null, rolled_back_at: "2026-09-02" }]), (error) => {
    assert.match(error.message, /003_extra/);
    assert.match(error.message, /rolled-back/);
    return true;
  });
});

test("migration evidence preserves resolved historical rollbacks and rejects unresolved ledger rows", () => {
  const expected = ["001_first", "002_second"];
  const successful = expected.map((migration_name, index) => ({ migration_name,
    checksum: String(index + 1).repeat(64), finished_at: `2026-09-01T00:00:0${index}Z`,
    rolled_back_at: null }));
  const expectedChecksums = Object.fromEntries(successful.map((row) =>
    [row.migration_name, row.checksum]));
  const rollback = { migration_name: "001_first", checksum: "a".repeat(64),
    finished_at: null, rolled_back_at: "2026-08-31T00:00:00Z" };
  const evidence = validateAppliedMigrations(expected, [...successful, rollback],
    { expectedChecksums });
  assert.deepEqual(evidence.historicalRollbacks.names, ["001_first"]);
  assert.equal(evidence.historicalRollbacks.count, 1);
  assert.match(evidence.historicalRollbacks.hash, /^[a-f0-9]{64}$/);
  assert.equal(evidence.historicalRollbacks.hash,
    validateAppliedMigrations(expected, [...successful, { ...rollback,
      rolled_back_at: "2026-09-02T00:00:00Z" }], { expectedChecksums })
      .historicalRollbacks.hash);
  for (const invalid of [
    [...successful, { ...rollback, migration_name: "003_removed" }],
    [...successful, { ...rollback, finished_at: "2026-09-01T00:00:00Z" }],
    [...successful, { ...rollback, rolled_back_at: null }],
    [successful[1], rollback],
  ]) assert.throws(() => validateAppliedMigrations(expected, invalid,
    { expectedChecksums }), /migration|rollback|unresolved|checksum|successful/i);
  const historicalSourceEdit = validateAppliedMigrations(expected,
    successful.map((row, index) => index ? row : { ...row, checksum: "f".repeat(64) }),
    { expectedChecksums });
  assert.deepEqual(historicalSourceEdit.checksumDrift.names, ["001_first"]);
  assert.match(historicalSourceEdit.checksumDrift.hash, /^[a-f0-9]{64}$/);
  const beforeDeploy = validateAppliedMigrations(expected, [successful[0], rollback],
    { expectedChecksums, requireExactSuccessful: false });
  assert.equal(beforeDeploy.historicalRollbacks.hash, evidence.historicalRollbacks.hash);
});

test("legacy lifecycle lock root comes only from the validated repository", (context) => {
  const repository = path.resolve(__dirname, "../../..");
  const configPath = path.join(repository, "docs", "capacity-load.config.json");
  const expected = path.join(repository, "results", "capacity", "home-open", "workflows");
  assert.equal(validatedWorkflowRoot({ repository, configPath }), expected);
  const alternate = temporary(context);
  const alternateConfig = path.join(alternate, "capacity.json");
  fs.writeFileSync(alternateConfig, `${JSON.stringify({ repository: alternate })}\n`);
  assert.throws(() => validatedWorkflowRoot({ repository: alternate, configPath: alternateConfig }),
    /canonical repository/i);
  assert.throws(() => validatedWorkflowRoot({ repository, configPath: alternateConfig }),
    /canonical repository/i);
  assert.equal(assertDeleteVmConfirmation({ instance: "step-capacity-home", confirmation:
    "DELETE step-capacity-home" }), true);
  assert.throws(() => assertDeleteVmConfirmation({ instance: "production", confirmation:
    "DELETE production" }), /step-capacity/i);
  assert.throws(() => assertDeleteVmConfirmation({ instance: "step-capacity-home", confirmation:
    "yes" }), /confirmation/i);
});

test("provider isolation rejects unlabeled legacy resources before workflow mutation", (context) => {
  const configPath = path.join(temporary(context), "capacity.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ lima_instance: "step-capacity" })}\n`);
  const listed = {
    container: ["step-capacity-postgres", "step-capacity-home-owned-backend"],
    volume: ["step-capacity-postgres-data"],
  };
  const labels = {
    "step-capacity-postgres": {},
    "step-capacity-home-owned-backend": {
      "com.bara.capacity.owner": "home-capacity-workflow-v1",
      "com.bara.capacity.workflow": "workflow-owned",
    },
    "step-capacity-postgres-data": null,
  };
  assert.throws(() => assertProviderIsolation({ configPath, workflowId: "workflow-owned" }, {
    present: () => true,
    running: () => true,
    list: (type) => listed[type],
    inspect: (_type, name) => labels[name],
  }), /foreign or unlabeled capacity container.*step-capacity-postgres/i);
  assert.deepEqual(assertProviderIsolation({ configPath, workflowId: "workflow-owned" }, {
    present: () => true, running: () => false,
  }), { isolated: true, deferredUntilVmStart: true, resources: [] });
});

test("provider rehearsal asserts isolation under its lock before preparation", () => {
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../integration/home-capacity-provider.test.js"), "utf8");
  assert.ok(source.indexOf("assertProviderIsolation({") > source.indexOf("withProviderLock({"));
  assert.ok(source.indexOf("assertProviderIsolation({") < source.indexOf("prepareWorkflowEnvironment({"));
});

test("child reset evidence binds actual Postgres, Redis, and backend container identities", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const body = source.slice(source.indexOf("function resetWorkflowChild"),
    source.indexOf("function cleanupWorkflowEnvironment"));
  assert.match(body, /containerIdentities/);
  for (const role of ["postgres", "redis", "backend"]) {
    assert.match(body, new RegExp(`${role}Container`));
  }
  assert.match(body, /docker inspect --format/);
  assert.match(body, /:\/var\/lib\/postgresql postgres:18/);
  assert.doesNotMatch(body, /:\/var\/lib\/postgresql\/data postgres:18/);
  assert.doesNotMatch(body, /run\("node", \[path\.join\(sourceBundle\.path/);
  assert.doesNotMatch(body, /run\(process\.execPath, \[path\.join\(sourceBundle\.path/);
  assert.match(body, /run\("pg_restore"/);
  assert.match(body, /preparedNodeHelperCommand\(\{ bundle: sourceBundle\.path, cacheVolume/);
  assert.match(body, /"--snapshot-hash", manifest\.snapshotHash/);
  for (const name of ["PROD_DATABASE_URL", "STAGING_DATABASE_URL", "PEER_DATABASE_URL",
    "APNS_KEY_PATH", "APNS_SIGNING_KEY", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID",
    "FCM_SERVICE_ACCOUNT", "FCM_SERVICE_ACCOUNT_PATH", "GOOGLE_APPLICATION_CREDENTIALS",
    "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN"]) {
    assert.match(body, new RegExp(`${name}: ""`), name);
  }
  assert.match(body, /postgresql@18\/bin/);
  assert.match(body, /process\.env\.PATH/);
});

test("preparation repeats deferred isolation after VM start and before Docker mutation", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const body = source.slice(source.indexOf("function prepareWorkflowEnvironment"),
    source.indexOf("function workflowChildEnvironment"));
  assert.ok(body.indexOf("ensureVmResources(settings)") < body.indexOf("assertProviderIsolation({"));
  assert.ok(body.indexOf("assertProviderIsolation({") < body.indexOf("docker volume create"));
});

test("terminal artifacts bind the terminal journal and recover one-sided partial writes", (context) => {
  const directory = temporary(context);
  const result = { schema: "home-capacity-workflow-result-v1", mode: "level", completed: true,
    classification: "diagnostic-pass", journalTerminalHash: "a".repeat(64), rate: 2 };
  fs.writeFileSync(path.join(directory, "summary.txt"), "partial\n");
  const written = writeTerminalArtifacts({ directory, result });
  const stored = JSON.parse(fs.readFileSync(written.resultPath, "utf8"));
  assert.equal(stored.journalTerminalHash, result.journalTerminalHash);
  assert.equal(stored.resultHash.length, 64);
  assert.match(fs.readFileSync(written.summaryPath, "utf8"), /Diagnostic rate: 2\/sec/);
});

test("reusable scan is reconstructed only from terminal-journal-bound report hashes", (context) => {
  const directory = temporary(context);
  const manifestUnsigned = { schema: "home-capacity-workflow-manifest-v1",
    workflowId: "home-20260901t204405-aaaaaaa", mode: "scan",
    policy: { maximumChildren: 2, startRate: 2, maxRate: 2 } };
  const manifest = { ...manifestUnsigned, hash: hashObject(manifestUnsigned) };
  fs.writeFileSync(path.join(directory, "confirmed-manifest.json"), `${JSON.stringify(manifest)}\n`);
  appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
  appendJournalEvent({ directory, manifest, type: "prepared", payload: {} });
  const childId = `${manifest.workflowId}-discovery-r2-n1`;
  appendJournalEvent({ directory, manifest, type: "child-selected", payload: { childId,
    rate: 2, kind: "discovery", repeat: 1,
    timings: { warmupSeconds: 30, measurementSeconds: 120 } } });
  appendJournalEvent({ directory, manifest, type: "child-started", payload: { childId } });
  const reportPath = path.join(directory, "child.json");
  fs.writeFileSync(reportPath, JSON.stringify({ schema: "home-open-capacity-result-v1",
    provenance: { runId: childId }, parameters: { arrivalRatePerSecond: 2 }, gates: { passed: true } }));
  appendJournalEvent({ directory, manifest, type: "child-completed", payload: { childId,
    classification: "pass", reportPath, reportHash: crypto.createHash("sha256")
      .update(fs.readFileSync(reportPath)).digest("hex") } });
  const binding = Object.fromEntries(["commit", "sourceBundleHash", "profileVersion", "reportVersion",
    "snapshotHash", "scrubAttestationHash", "parityHash", "resourceManifestHash", "topologyHash",
    "effectiveEnvironmentHash", "configHash", "snapshotMetadataHash", "migrationHash",
    "timingPolicyHash", "rateBoundsHash"].map((name) => [name, name]));
  const payloadResult = { schema: "home-capacity-workflow-result-v1", mode: "scan", completed: true,
    classification: "scan-lower-bound", binding, cleanup: { resetData: true },
    highestPass: 2, firstFailure: null };
  const resultPayloadHash = hashObject(payloadResult);
  const terminal = appendJournalEvent({ directory, manifest, type: "terminal", payload: {
    classification: "scan-lower-bound", completed: true, cleanup: { resetData: true },
    resultPayloadHash } });
  const unsigned = { ...payloadResult, resultPayloadHash, journalTerminalHash: terminal.hash };
  const result = { ...unsigned, resultHash: hashObject(unsigned) };
  const resultPath = path.join(directory, "workflow-result.json"); fs.writeFileSync(resultPath, JSON.stringify(result));
  const reused = verifyReusableScan({ resultPath, expectedBinding: binding, expectedMaxRate: 2 });
  assert.deepEqual(reused.observations, [{ rate: 2, passed: true, kind: "discovery", runId: childId }]);
  fs.writeFileSync(reportPath, "{}\n");
  assert.throws(() => verifyReusableScan({ resultPath, expectedBinding: binding,
    expectedMaxRate: 2 }), /report hash/i);
});

test("single-level executor is dependency-injectable without weakening report gates", async () => {
  const calls = [];
  const report = await executeHomeOpenLevel({ runId: "run-safe", mode: "level", rate: 10,
    warmupSeconds: 30, measurementSeconds: 120 }, {
    execute: async (input) => { calls.push(input); return { schema: "home-open-capacity-result-v1",
      provenance: { runId: input.runId }, parameters: { arrivalRatePerSecond: input.rate },
      gates: { passed: true } }; },
  });
  assert.equal(report.gates.passed, true);
  assert.equal(calls.length, 1);
  await assert.rejects(executeHomeOpenLevel({ runId: "run-safe", mode: "level", rate: 10,
    warmupSeconds: 30, measurementSeconds: 120 }, {
    execute: async () => ({ schema: "home-open-capacity-result-v1", gates: {} }),
  }), /verified per-level report/);
});

test("stale provider locks require positive process and resource absence proof", async (context) => {
  const directory = temporary(context);
  const file = path.join(directory, "step-capacity.provider.lock.json");
  const stale = { schema: "home-capacity-provider-lock-v1", pid: 99999999,
    processStartIdentity: "definitely gone", workflowId: "home-20260901t204405-aaaaaaa",
    instance: "step-capacity", token: "stale", acquiredAt: new Date(0).toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(stale)}\n`);
  await assert.rejects(withProviderLock({ directory, instance: "step-capacity",
    workflowId: "home-20260901t204405-bbbbbbb" }, async () => {}), /resource proof/);
  await assert.rejects(withProviderLock({ directory, instance: "step-capacity",
    workflowId: "home-20260901t204405-bbbbbbb", resourceCensus: async () => [{ name: "still-live" }] },
  async () => {}), /still has workflow resources/);
  let entered = false;
  await withProviderLock({ directory, instance: "step-capacity",
    workflowId: "home-20260901t204405-bbbbbbb", resourceCensus: async () => [] },
  async () => { entered = true; });
  assert.equal(entered, true);
  assert.ok(fs.readdirSync(directory).some((name) => name.endsWith(".recovery.json")));
});

test("workflow aggregation enforces full-length matching certification provenance", () => {
  const report = (repeat) => ({
    schema: "home-open-capacity-result-v1",
    parameters: { arrivalRatePerSecond: 20, warmupSeconds: 120, measurementSeconds: 600 },
    provenance: { mode: "boundary", repeat, runId: `boundary-${repeat}`,
      backendCommit: "a".repeat(40), profileVersion: "2.1.0", scrubAttestationHash: "b".repeat(64),
      sourceTreeHash: "c".repeat(64), snapshotHash: "d".repeat(64), manifestHash: "e".repeat(64),
      liveManifestHash: "f".repeat(64), resources: { vmCpu: 7 }, actualVmResources: { cpu: 7 },
      workflowManifestHash: "1".repeat(64), sourceBundleHash: "2".repeat(64), reportVersion: "1.0.0",
      parityHash: "3".repeat(64), resourceManifestHash: "4".repeat(64), topologyHash: "5".repeat(64),
      effectiveEnvironmentHash: "6".repeat(64), migrationHash: "7".repeat(64),
      appliedMigrationHash: "8".repeat(64), schemaFingerprint: "9".repeat(64),
      migrationChecksumDriftHash: "b".repeat(64),
      historicalRollbackHash: "a".repeat(64),
      childEffectiveEnvironmentHash: String(repeat).repeat(64).slice(0, 64),
      normalizedEffectiveEnvironmentHash: "0".repeat(64) },
    gates: { passed: true }, sessions: { averageInFlight: 4, peakInFlight: 8,
      criticalHomeMs: { p95: 500 }, allHomeMs: { p95: 700 } },
    endpoints: { "GET /auth/me": { requests: 20, latencyMs: { p95: 100 } } },
    infrastructure: { dbPoolWaitP99Ms: 2, maxEventLoopDelayMs: 3 },
  });
  const result = aggregateHomeOpenLadder([report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100 });
  assert.equal(result.highestCertifiedTestedRate, 20);
  assert.deepEqual(result.unresolvedBracket, [20, 24]);
  assert.equal(result.safeOperatingCeilingHomeOpensPerSecond, 14);
  const short = report(3); short.parameters.measurementSeconds = 120;
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(2), short],
    { failureBound: 24, maxRate: 100 }), /timing/);
  const noFailure = aggregateHomeOpenLadder([report(1), report(2), report(3)], { maxRate: 20 });
  assert.equal(noFailure.lowerBound, 20); assert.equal(noFailure.safeOperatingCeilingHomeOpensPerSecond, null);
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100 }), /exactly three|repeat/i);
  const failing = { ...report(1), parameters: { ...report(1).parameters,
    arrivalRatePerSecond: 24 }, gates: {
      passed: false, failures: ["queue lag"] }, queue: { peakDepth: 91, p95LagMs: 5000 },
      infrastructure: { ...report(1).infrastructure,
        containerPeakCpuPercent: { "x-backend": 81, "x-postgres": 72, "x-redis": 63 } } };
  const resultWithFailure = aggregateHomeOpenLadder([report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100, failureReport: failing });
  assert.deepEqual(resultWithFailure.failureEvidence.failedGates, ["queue lag"]);
  assert.equal(resultWithFailure.failureEvidence.queue.peakDepth, 91);
  assert.equal(resultWithFailure.failureEvidence.infrastructure.redisCpuPeakPercent, 63);
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100, failureReport: { ...failing,
      gates: { passed: true, failures: [] } } }), /failure report.*failed/i);
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100, failureReport: { ...failing,
      parameters: { ...failing.parameters, arrivalRatePerSecond: 25 } } }), /failure report.*bound/i);
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(2), report(3)],
    { failureBound: 24, maxRate: 100, failureReport: { ...failing,
      provenance: { ...failing.provenance, migrationHash: "f".repeat(64) } } }),
  /failure report.*binding/i);
  const mismatchedRollback = report(3);
  mismatchedRollback.provenance.historicalRollbackHash = "b".repeat(64);
  assert.throws(() => aggregateHomeOpenLadder([report(1), report(2), mismatchedRollback],
    { failureBound: 24, maxRate: 100 }), /provenance|binding|workflow/i);
});

test("workflow reset and report provenance bind preserved migration rollback history", () => {
  const limaSource = fs.readFileSync(path.resolve(__dirname, "../../../scripts/lima-capacity.js"), "utf8");
  const k6Source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/k6-home-open.js"), "utf8");
  assert.match(limaSource, /historicalRollbackHash/);
  assert.match(k6Source, /historicalRollbackHash/);
  assert.match(k6Source, /historicalRollbackHash: workflow\?\.reset\?\.historicalRollbackHash/);
  assert.match(limaSource, /set -o pipefail; docker exec/);
  assert.match(limaSource, /--restrict-key=homecapacityschemafingerprintv1/);
});

test("human summary includes capacity, gates, infrastructure, queue, and phase timing evidence", () => {
  const text = renderSummary({ mode: "certify", classification: "certified", certifiedRate: 10,
    failureBound: 12, operatingCeiling: 7, supportingRuns: ["a", "b", "c"],
    failedGates: ["http errors"], errors: { rate: 0.01, droppedArrivals: 2 },
    infrastructure: { backendCpuPeak: 90, databaseCpuPeak: 80, dbPoolWaitP99Ms: 12 },
    queue: { peakDepth: 30, p95LagMs: 4000 },
    elapsed: { phases: { prepareSeconds: 3, readinessSeconds: 5, loadSeconds: 600,
      cleanupSeconds: 4 } } });
  for (const expected of ["600 opens/min", "Failure bound: 12/sec", "Failed gates: http errors",
    "Backend/DB CPU peak", "Pool wait p99", "Queue peak/p95 lag", "Phase timings"])
    assert.match(text, new RegExp(expected));
});

test("conservative bottleneck rules require correlated complete evidence", () => {
  assert.equal(inferLikelyConstraint({ gates: { failures: ["resolution queue lag"] },
    queue: { p95LagMs: 45_000 }, resolutionEvidence: { terminalReconciled: true } }),
  "resolution throughput");
  assert.equal(inferLikelyConstraint({ gates: { failures: ["slow SQL statement"] },
    infrastructure: { dbPoolWaitP99Ms: 100 } }), "inconclusive");
  assert.equal(inferLikelyConstraint({ gates: { failures: ["generator dropped iteration", "DB pool waiters"] },
    sessions: { dropped: 2 }, generator: { saturated: true },
    infrastructure: { telemetryComplete: true, dbPoolWaitP99Ms: 80 } }),
  "multiple correlated constraints");
});

test("public scan orchestration treats a measured failure as a range and resets every child", async (context) => {
  const repository = temporary(context, "home-capacity-orchestration-source-");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "capacity-test@synthetic.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Capacity Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.js"), "module.exports = 1;\n");
  execFileSync("git", ["add", "source.js"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const directory = temporary(context, "home-capacity-orchestration-result-");
  const sourceBundle = createSourceBundle({ repository,
    output: path.join(directory, "immutable-source") });
  const workflowId = generateWorkflowId({ now: new Date("2026-09-01T20:44:05Z"),
    commit: sourceBundle.commit });
  const manifest = buildWorkflowManifest({ workflowId, mode: "scan", commit: sourceBundle.commit,
    sourceBundleHash: sourceBundle.hash, snapshotHash: "a".repeat(64),
    scrubAttestationHash: "b".repeat(64), parityHash: "c".repeat(64),
    resourceManifestHash: "d".repeat(64), effectiveEnvironmentHash: "e".repeat(64),
    configHash: "f".repeat(64), snapshotMetadataHash: "1".repeat(64),
    migrationHash: "2".repeat(64), topologyHash: "3".repeat(64), startRate: 2, maxRate: 2,
    provider: { instance: "step-capacity", target: "capacity-vm",
      database: "steps_tracker_capacity", dbHostPort: 55433 } });
  fs.writeFileSync(path.join(directory, "confirmed-manifest.json"), `${JSON.stringify(manifest)}\n`);
  appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
  const resets = [];
  const lima = {
    prepareWorkflowEnvironment: async () => ({ cacheHit: true }),
    resetWorkflowChild: async ({ child }) => { resets.push(child.runId); return { configPath: "/unused" }; },
    cleanupWorkflowEnvironment: async () => ({ resetData: true, stopped: true, cacheRetained: true }),
  };
  const executeChild = async ({ child, outputRoot }) => {
    const passed = child.kind === "smoke";
    const report = { schema: "home-open-capacity-result-v1",
      provenance: { runId: child.runId }, parameters: { arrivalRatePerSecond: child.rate },
      gates: { passed, failures: passed ? [] : ["resolution queue lag"] },
      sessions: { criticalHomeMs: { p50: 100, p95: 200, p99: 300 }, dropped: 0,
        averageInFlight: 1, peakInFlight: 2 }, summary: { errorRate: 0 },
      queue: { p95LagMs: passed ? 0 : 45_000 },
      resolutionEvidence: { terminalReconciled: true }, infrastructure: {}, endpoints: {} };
    const reportPath = path.join(outputRoot, `${child.runId}.json`);
    fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report));
    return { report, reportPath };
  };
  const result = await orchestrateConfirmedWorkflow({ manifest, directory, repository,
    configPath: "/unused", sourceBundle, environment: {} }, { lima, executeChild });
  assert.equal(result.completed, true, JSON.stringify(result)); assert.equal(result.classification, "scan-range");
  assert.equal(result.highestPass, 1); assert.equal(result.firstFailure, 2);
  assert.equal(result.likelyConstraint, "resolution throughput");
  assert.equal(resets.length, 2); assert.equal(new Set(resets).size, 2);
  assert.equal(result.childArtifacts.every((row) => row.report == null), true);
  fs.chmodSync(sourceBundle.path, 0o700);
});

test("fake-provider workflow integration proves fresh restore/Redis/migrations, cache reuse, and certification fallback", async (context) => {
  const repository = temporary(context, "home-capacity-fake-provider-source-");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "capacity-test@synthetic.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Capacity Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.js"), "module.exports = 1;\n");
  execFileSync("git", ["add", "source.js"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const directory = temporary(context, "home-capacity-fake-provider-result-");
  const sourceBundle = createSourceBundle({ repository, output: path.join(directory, "source") });
  const workflowId = generateWorkflowId({ now: new Date("2026-09-01T20:45:05Z"), commit: sourceBundle.commit });
  const manifest = buildWorkflowManifest({ workflowId, mode: "certify", commit: sourceBundle.commit,
    sourceBundleHash: sourceBundle.hash, snapshotHash: "a".repeat(64),
    scrubAttestationHash: "b".repeat(64), parityHash: "c".repeat(64),
    resourceManifestHash: "d".repeat(64), effectiveEnvironmentHash: "e".repeat(64),
    configHash: "f".repeat(64), snapshotMetadataHash: "1".repeat(64),
    migrationHash: "2".repeat(64), topologyHash: "3".repeat(64), startRate: 2, maxRate: 2,
    provider: { instance: "step-capacity", target: "capacity-vm",
      database: "steps_tracker_capacity", dbHostPort: 55433 } });
  fs.writeFileSync(path.join(directory, "confirmed-manifest.json"), `${JSON.stringify(manifest)}\n`);
  appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
  const resets = [];
  const fakeProvider = {
    prepareWorkflowEnvironment: async () => ({ cacheHit: true, cacheVolume: "preseeded-cache",
      binding: { hash: sourceBundle.hash }, preparationDurationSeconds: 0.01 }),
    resetWorkflowChild: async ({ child, previousChild }) => {
      assert.equal(previousChild?.runId || null, resets.at(-1)?.runId || null);
      const evidence = { schema: "home-capacity-child-reset-v1", childConfigHash: hashObject(child),
        resetDurationSeconds: 0.01, restoredSnapshot: true, redisKeysBeforeBackend: 0,
        appliedMigrationHash: "4".repeat(64), schemaFingerprint: "5".repeat(64) };
      resets.push(child); return evidence;
    },
    cleanupWorkflowEnvironment: async () => ({ resetData: true, stopped: true,
      cacheRetained: true, credentialsRetained: false }),
  };
  const executeChild = async ({ child, outputRoot }) => {
    const passed = child.kind !== "boundary" || child.rate === 1;
    const report = { schema: "home-open-capacity-result-v1", provenance: { runId: child.runId },
      parameters: { arrivalRatePerSecond: child.rate }, gates: { passed,
        failures: passed ? [] : ["capacity gate"] }, sessions: {}, infrastructure: {}, endpoints: {} };
    const reportPath = path.join(outputRoot, `${child.runId}.json`);
    fs.mkdirSync(outputRoot, { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report));
    return { report, reportPath, credentialPaths: [] };
  };
  const result = await orchestrateConfirmedWorkflow({ manifest, directory, repository,
    configPath: "/unused", sourceBundle, environment: {} }, { lima: fakeProvider, executeChild,
    aggregate: (reports) => ({ repeats: reports.length }) });
  assert.equal(result.classification, "certified", JSON.stringify(result));
  assert.equal(result.certifiedRate, 1);
  assert.equal(result.failureBound, 2);
  assert.equal(result.aggregation.repeats, 3);
  assert.equal(resets.every((child) => child.runId.startsWith(workflowId)), true);
  assert.equal(result.cleanup.cacheRetained, true);
  fs.chmodSync(sourceBundle.path, 0o700);
});

test("reset or cleanup failure always produces exact recovery guidance", async (context) => {
  const repository = temporary(context, "home-capacity-recovery-source-");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "capacity-test@synthetic.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Capacity Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.js"), "x\n");
  execFileSync("git", ["add", "source.js"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const directory = temporary(context, "home-capacity-recovery-result-");
  const sourceBundle = createSourceBundle({ repository, output: path.join(directory, "source") });
  const workflowId = generateWorkflowId({ now: new Date("2026-09-01T20:46:05Z"), commit: sourceBundle.commit });
  const manifest = buildWorkflowManifest({ workflowId, mode: "level", rate: 2,
    commit: sourceBundle.commit, sourceBundleHash: sourceBundle.hash,
    snapshotHash: "a".repeat(64), scrubAttestationHash: "b".repeat(64),
    parityHash: "c".repeat(64), resourceManifestHash: "d".repeat(64),
    effectiveEnvironmentHash: "e".repeat(64), configHash: "f".repeat(64),
    snapshotMetadataHash: "1".repeat(64), migrationHash: "2".repeat(64),
    topologyHash: "3".repeat(64), startRate: 2, maxRate: 2,
    provider: { instance: "step-capacity", target: "capacity-vm",
      database: "steps_tracker_capacity", dbHostPort: 55433 } });
  fs.writeFileSync(path.join(directory, "confirmed-manifest.json"), `${JSON.stringify(manifest)}\n`);
  appendJournalEvent({ directory, manifest, type: "planned", payload: {} });
  appendJournalEvent({ directory, manifest, type: "confirmed", payload: {} });
  const result = await orchestrateConfirmedWorkflow({ manifest, directory, repository,
    configPath: "/tmp/capacity.json", sourceBundle, environment: {} }, { lima: {
      prepareWorkflowEnvironment: async () => ({ cacheHit: false }),
      resetWorkflowChild: async () => { throw new Error("restore interrupted"); },
      cleanupWorkflowEnvironment: async () => ({ resetData: false, stopped: false,
        cacheRetained: false, credentialsRetained: false }),
    }, executeChild: async () => { throw new Error("unreachable"); } });
  assert.equal(result.completed, false);
  assert.match(result.staleCleanupCommand, /reset-data.*workflow-manifest/);
  assert.equal(result.cleanup.resetData, false);
  fs.chmodSync(sourceBundle.path, 0o700);
});
