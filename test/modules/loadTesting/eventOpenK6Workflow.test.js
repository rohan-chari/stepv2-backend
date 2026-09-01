const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const {
  applyGuardedCapacityEnvironment,
  checkoutFingerprint,
  eventOpenPrimaryRaceId,
  k6LoadUsers,
  observedPoolBudget,
  prewarmEventOpenRaceSnapshots,
  validateArtifactProvenance,
} = require("../../../scripts/k6-event-open");
const {
  assertCapacityDatabase,
  capacityAuthSecret,
  capacityIdentity,
} = require("../../../src/localCapacitySafety");

const root = path.resolve(__dirname, "../../..");

test("genuine k6 event-open script uses constant arrival rates and the complete session graph", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6/event-open-surge.js"), "utf8");
  assert.match(source, /from ["']k6\/http["']/);
  assert.match(source, /constant-arrival-rate/);
  assert.match(source, /noVUConnectionReuse:\s*true/);
  assert.match(source, /K6_SCENARIO/);
  for (const route of [
    "/auth/session", "/notifications/device-token", "/analytics/activation-events",
    "/steps", "/steps/samples", "/steps/sync-v2", "/home/race-card",
    "/races/discovery-summary", "/races", "/inbox/alerts", "/progress", "/bootstrap",
  ]) assert.match(source, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(source, /rate<0\.001/);
  assert.match(source, /p\(95\)<500/);
  assert.match(source, /p\(99\)<1000/);
  assert.match(source, /bucket\s*<\s*36[\s\S]*\/progress[\s\S]*:\s*request\([\s\S]*\/bootstrap\?view=participants-v1/);
  assert.match(source, /\/home\/race-card\?view=shell-v1&homeActiveRaces=1&localDate=\$\{today\}&homePersistedTotals=1/);
  assert.match(source, /\/races\?view=compact-v1/);
  assert.match(source, /race_participants_paging/);
  assert.match(source, /const legacyClient = bucket < 36/);
  assert.match(source, /legacyClient\s*\?\s*\[\]\s*:\s*\[request\("GET", "\/inbox\/alerts"/);
  assert.match(source, /function canonicalIdempotencyKey/);
  assert.match(source, /Idempotency-Key": canonicalIdempotencyKey\(user\.idempotencyPrefix, sequence\)/);
  assert.match(source, /\/auth\/session\?view=shell-v1/);
  assert.match(source, /sequence % 10 === 0/);
  assert.match(source, /sequence % 100 === 0/);
  assert.match(source, /http\.batch\(backgroundWrites\)/);
  assert.match(source, /const stepResponse = http\.request/);
  assert.match(source, /http\.batch\(primaryReads\)/);
  assert.match(source, /sleep\(0\.25\)/);
  assert.match(source, /http\.batch\(secondaryReads\)/);
  assert.doesNotMatch(source, /const requests = \[/);
  assert.doesNotMatch(source, /request\("GET", `\/races\/\$\{user\.raceId\}\/progress`[\s\S]*request\("GET", `\/races\/\$\{user\.raceId\}\/bootstrap`/);
});

test("event-open setup publishes one warm shared snapshot per existing race", async () => {
  const calls = [];
  const races = [{ id: "race-b" }, { id: "race-a" }];
  await prewarmEventOpenRaceSnapshots({
    races,
    computeSnapshot: async ({ raceId }) => ({ raceId }),
    writeSnapshot: async (raceId, snapshot) => calls.push({ raceId, snapshot }),
  });
  assert.deepEqual(calls, [
    { raceId: "race-a", snapshot: { raceId: "race-a" } },
    { raceId: "race-b", snapshot: { raceId: "race-b" } },
  ]);
});

test("every event-open session targets the primary race shared by all fixture users", () => {
  const races = [{ id: "primary-race" }, { id: "second-race" }, { id: "third-race" }];
  assert.equal(eventOpenPrimaryRaceId(races), "primary-race");
  assert.throws(() => eventOpenPrimaryRaceId([]), /primary race/);
});

test("k6 orchestrator is pinned to the disposable Lima environment and exact 10/10/8/4 pool budget", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6-event-open.js"), "utf8");
  assert.match(source, /grafana\/k6:0\.54\.0/);
  assert.match(source, /CAPACITY_MODE/);
  assert.match(source, /steps_tracker_capacity/);
  assert.match(source, /http0:\s*10/);
  assert.match(source, /http1:\s*10/);
  assert.match(source, /resolution:\s*8/);
  assert.match(source, /cron:\s*4/);
  assert.match(source, /event-open-surge/);
  assert.match(source, /assertCapacityRunProfile\(state,\s*"event-open-surge"\)/);
  assert.match(source, /K6_SUMMARY_PATH=\/k6-output\/summary\.json/);
  assert.match(source, /"-m",\s*"777",\s*vmOutputDir/);
  assert.match(source, /\/results:ro/);
  assert.match(source, /fs\.writeFileSync\(summaryPath,[\s\S]*flag:\s*"wx"/);
  assert.match(source, /\.fault\.json/);
  assert.match(source, /docker pull \$\{K6_IMAGE\}/);
  assert.ok(source.indexOf("applyGuardedCapacityEnvironment") < source.indexOf("require(\"../src/db\")"));
  assert.ok(
    source.indexOf('docker pull ${K6_IMAGE}') < source.indexOf("createGlobalEventReliabilityFixtures({"),
    "the pinned image must be present before the time-bound fixture is created",
  );
});

test("k6 orchestration binds the disposable database before loading db and excludes zero-install users", () => {
  const env = {
    CAPACITY_MODE: "true", CAPACITY_OUTBOUND_DISABLED: "true",
    CAPACITY_DB_PASSWORD: "disposable-password",
    CAPACITY_REDIS_PASSWORD: "disposable-redis-password",
    CAPACITY_DB_MARKER: "run-bound-marker-material",
    CAPACITY_AUTH_SECRET: "capacity-auth-secret-with-at-least-32-characters",
  };
  applyGuardedCapacityEnvironment({ db_name: "steps_tracker_capacity", db_host_port: 55433 }, "run-k6-safe", env);
  assert.equal(env.CAPACITY_RUN_ID, "run-k6-safe");
  assert.equal(env.CAPACITY_GLOBAL_EVENT_PROFILE, "event-open-surge");
  assert.equal(env.DATABASE_URL, "postgresql://capacity:disposable-password@127.0.0.1:55433/steps_tracker_capacity");
  assert.equal(env.REDIS_URL, "redis://:disposable-redis-password@127.0.0.1:6379/0");
  assert.equal(env.CACHE_ENV_PREFIX, "capacity:run-k6-safe:");
  assert.equal(capacityIdentity(env).runId, "run-k6-safe");
  assert.equal(capacityAuthSecret(env), env.CAPACITY_AUTH_SECRET);
  assert.equal(assertCapacityDatabase(env.DATABASE_URL, env).database, "steps_tracker_capacity");
  const users = Array.from({ length: 10_000 }, (_, userIndex) => ({ id: String(userIndex), userIndex }));
  assert.equal(k6LoadUsers(users).length, 8_000);
  assert.equal(k6LoadUsers(users)[0].userIndex, 2_000);
});

test("k6 gate observes exact pool roles and validates artifact provenance", () => {
  const checkout = checkoutFingerprint(root);
  assert.match(checkout.commit, /^[0-9a-f]{40}$/);
  if (checkout.dirty) assert.match(checkout.dirtyTreeHash, /^[0-9a-f]{64}$/);
  const capacity = (role, instance, max) => ({
    runId: "run-observed", globalEventProfile: "event-open-surge",
    process: { role, instance }, dbPool: { max },
  });
  const metrics = { samples: [{ health: {
    http: { capacity: capacity("http", 0, 10) },
    httpPeer: { capacity: capacity("http", 1, 10) },
    resolution: { capacity: capacity("resolution", 0, 8) },
    cron: { capacity: capacity("cron", 0, 4) },
  } }] };
  assert.deepEqual(observedPoolBudget(metrics, "run-observed"), {
    http0: 10, http1: 10, resolution: 8, cron: 4, total: 32,
  });
  assert.throws(() => observedPoolBudget({ samples: [] }, "run-observed"), /pool census/);
  const capacityBinding = {
    schema: "event-open-capacity-binding-v1", profile: "event-open-surge",
    snapshotHash: "snapshot", sourceSnapshotHash: "source", scrubAttestationHash: "scrub",
    approvedManifestHash: "approved", liveManifestHash: "live",
    checkout: { schema: "capacity-checkout-fingerprint-v1", commit: "a".repeat(40), dirty: false, dirtyTreeHash: null },
    poolBudget: { http0: 10, http1: 10, resolution: 8, cron: 4, total: 32 },
  };
  assert.equal(validateArtifactProvenance({
    faultEvidence: { schema: "capacity-fault-v1", runId: "run-observed", scenario: "redis-outage" },
    headroomEvidence: { schema: "event-open-k6-verification-v1", runId: "different-headroom-run", scenario: "headroom", capacityBinding },
    fault: "redis-outage", runId: "run-observed", requireHeadroom: true, capacityBinding,
  }), true);
  assert.throws(() => validateArtifactProvenance({
    faultEvidence: { schema: "capacity-fault-v1", runId: "run-observed", scenario: "redis-outage" },
    headroomEvidence: { schema: "event-open-k6-verification-v1", runId: "different-headroom-run", scenario: "headroom", capacityBinding: { ...capacityBinding, checkout: { ...capacityBinding.checkout, commit: "b".repeat(40) } } },
    fault: "redis-outage", runId: "run-observed", requireHeadroom: true, capacityBinding,
  }), /headroom artifact provenance/);
  assert.throws(() => validateArtifactProvenance({
    faultEvidence: { schema: "capacity-fault-v1", runId: "other", scenario: "redis-outage" },
    fault: "redis-outage", runId: "run-observed", requireHeadroom: false,
  }), /provenance/);
});

test("checkout binding ignores runtime results but changes for source edits", (context) => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "k6-checkout-binding-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "capacity-test@synthetic.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Capacity Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "source.js"), "module.exports = 1;\n");
  execFileSync("git", ["add", "source.js"], { cwd: repository });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repository });
  const before = checkoutFingerprint(repository);
  fs.mkdirSync(path.join(repository, "results"));
  fs.writeFileSync(path.join(repository, "results", "run.verification.json"), "{}\n");
  assert.deepEqual(checkoutFingerprint(repository), before);
  fs.writeFileSync(path.join(repository, "source.js"), "module.exports = 2;\n");
  const changed = checkoutFingerprint(repository);
  assert.equal(changed.commit, before.commit);
  assert.notEqual(changed.dirtyTreeHash, before.dirtyTreeHash);
});
