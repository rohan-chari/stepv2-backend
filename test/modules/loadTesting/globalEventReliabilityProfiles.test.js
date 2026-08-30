const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PROFILES,
  parseLoadParameters,
  validateProfileRegistry,
} = require("../../../src/modules/loadTesting/contract");
const {
  assertGlobalEventCapacityGates,
  assertSustainedBackgroundLoad,
  installationCountForUser,
  providerResultForAttempt,
  raceCountForUser,
  buildCapacityProviderSender,
  globalEventFixtureCensus,
  aggregateGlobalEventCapacityEvidence,
} = require("../../../src/modules/loadTesting/globalEventReliabilityProfiles");
const {
  BACKGROUND_NODE_EXEC_ARGV,
  capacityPoolLimits,
  capacityPoolProfile,
  roleChildEnvironment,
} = require("../../../scripts/capacity-cluster");
const { capacityRunId, globalEventProfile } = require("../../../scripts/lima-capacity");
const { applyProvider: applyCapacityProvider } = require("../../../scripts/capacity");
const { logicalOwnerIdForProcess } = require("../../../src/modules/steps/models/globalStepEventGeneration");
const { normalizeGlobalEventInfrastructure } = require("../../../src/modules/loadTesting/globalEventInfrastructure");
const {
  assertGlobalEventArtifactSet,
  capacityResolutionJobInput,
  runPacedBackgroundProducer,
  selectSyntheticFixtureLifecycle,
  writeImmutableArtifact,
} = require("../../../src/modules/loadTesting/runner");
const { assertCapacityRunProfile } = require("../../../src/modules/loadTesting/lifecycle");
const { writeImmutable: writeImmutableMetrics } = require("../../../scripts/capacity-metrics");
const { observeChildExit } = require("../../../src/modules/loadTesting/metricsProcess");
const { writeCapacityOperatorMarker } = require("../../../src/modules/loadTesting/capacityDatabaseMarker");
const { capacityLoadParameter } = require("../../../src/modules/loadTesting/profileParameters");
const {
  capacityRaceParticipantRows,
  cleanupSyntheticRun,
  createGlobalEventReliabilityFixtures,
  resetGlobalEventDerivedState,
  selectProvisioningParent,
} = require("../../../src/modules/loadTesting/globalEventReliabilityFixtures");
const {
  cleanupSyntheticRun: cleanupGenericSyntheticRun,
  createSyntheticFixtures,
} = require("../../../src/modules/loadTesting/fixtures");
const { collectGlobalEventCapacityEvidence } = require("../../../src/modules/loadTesting/globalEventReliabilityEvidence");

const PROFILE_NAMES = [
  "event_provisioning_10000",
  "event_boundary_10000",
  "event_provider_outage_10000",
];

test("global-event capacity profiles lock the approved 2m/10m/3-repeat contract", () => {
  assert.equal(validateProfileRegistry(), true);
  for (const name of PROFILE_NAMES) {
    const profile = PROFILES[name];
    assert.equal(profile.eventReliability.fixtureUsers, 10_000);
    assert.equal(profile.eventReliability.warmupSeconds, 120);
    assert.equal(profile.eventReliability.measurementSeconds, 600);
    assert.equal(profile.eventReliability.repetitions, 3);
    assert.equal(profile.eventReliability.background.authenticatedHttpPerSecond, 25);
    assert.equal(profile.eventReliability.background.resolutionJobsPerSecond, 50);
    assert.equal(profile.defaults.users, 10_000);
    assert.equal(profile.limits.maxUsers, 10_000);
    assert.equal(profile.defaults.duration, "720s");
    assert.equal(profile.limits.maxDurationSeconds, 720);
    assert.equal(profile.defaults.arrivalRatePerSecond, 75);
    assert.equal(profile.fixtureRaces, 3);
    assert.deepEqual(profile.entries.map((item) => item.weight), [1]);
  }
  assert.equal(parseLoadParameters({ profile: "event_boundary_10000" }).users, 10_000);
  assert.equal(PROFILES.event_boundary_10000.limits.maxUsers, 10_000);
  assert.equal(PROFILES.home.limits.maxUsers, 5_000);
  assert.equal(PROFILES.event_provisioning_10000.eventReliability.deadlineSeconds, 600);
  assert.equal(PROFILES.event_provisioning_10000.eventReliability.projectionDeadlineSeconds, 300);
  assert.equal(PROFILES.event_provisioning_10000.eventReliability.minimumLeadSeconds, 43_200);
  assert.equal(PROFILES.event_provisioning_10000.eventReliability.planningHorizonSeconds, 129_600);
  assert.equal(PROFILES.event_provider_outage_10000.eventReliability.outageSeconds, 60);
});

test("capacity background resolution uses a real participant-scoped production envelope", () => {
  const at = new Date("2026-08-26T12:00:00.000Z");
  const fixture = { resolutionTargetGroups: [
    [
      { raceId: "race-1", userId: "user-1", participantId: "participant-1" },
      { raceId: "race-1", userId: "user-3", participantId: "participant-3" },
    ],
    [
      { raceId: "race-2", userId: "user-2", participantId: "participant-2" },
      { raceId: "race-2", userId: "user-4", participantId: "participant-4" },
    ],
  ] };
  assert.deepEqual(capacityResolutionJobInput({ fixture, sequence: 3, at }), {
    raceId: "race-2",
    userId: "user-4",
    participantId: "participant-4",
    at,
    dirtyEnvelope: {
      reason: "STEP_SYNC",
      dirtyUserIds: ["user-4"],
      dirtyParticipantIds: ["participant-4"],
      powerupTypes: [],
      priority: "COALESCE",
    },
  });
  assert.throws(
    () => capacityResolutionJobInput({ fixture: {}, sequence: 0, at }),
    /resolution targets/,
  );
});

test("capacity race participants carry the committed source state required by STEP_SYNC", () => {
  const startedAt = new Date("2026-08-26T11:00:00.000Z");
  const totalsUpdatedAt = new Date("2026-08-26T12:00:00.000Z");
  const rows = capacityRaceParticipantRows({
    userRows: Array.from({ length: 10_000 }, (_, index) => ({ id: `user-${index}` })),
    races: [{ id: "race-1" }, { id: "race-2" }, { id: "race-3" }],
    users: 10_000,
    startedAt,
    totalsUpdatedAt,
  });

  assert.equal(rows.length, 14_000);
  assert.ok(rows.every((row) => row.rawSteps === 1_000));
  assert.ok(rows.every((row) => row.totalSteps === 1_000));
  assert.ok(rows.every((row) => row.totalsUpdatedAt === totalsUpdatedAt));
});

test("event profiles do not inherit generic tuning from the shared config", () => {
  const args = { profile: "event_provisioning_10000" };
  const config = { users: 5_000, arrival_rate: 5, duration: "5m", concurrency: 1_000 };
  for (const name of ["users", "arrival_rate", "duration", "concurrency"]) {
    assert.equal(capacityLoadParameter({ args, config, profile: args.profile, name }), undefined);
  }
  assert.equal(capacityLoadParameter({
    args: { ...args, users: "10000" }, config, profile: args.profile, name: "users",
  }), "10000");
  assert.equal(capacityLoadParameter({
    args: {}, config, profile: "full-app", name: "users",
  }), 5_000);
});

test("provisioning reuses a suitable cloned local parent without taking cleanup ownership", async () => {
  const parent = {
    id: "cloned-parent", scheduleMode: "LOCAL_ENTITLEMENTS",
    eventDay: "2026-08-28", localStartMinute: 600, durationMinutes: 30,
  };
  const prisma = { globalStepEvent: { findMany: async () => [parent] } };
  const selected = await selectProvisioningParent(prisma, new Date("2026-08-26T12:00:00.000Z"));
  assert.equal(selected.event, parent);
  assert.equal(selected.owned, false);
  assert.ok(selected.window.startsAt.getTime() - new Date("2026-08-26T12:00:00.000Z").getTime() >= 43_200_000);
});

test("provisioning evidence excludes cloned users on a borrowed parent", async () => {
  const calls = [];
  const prisma = { $queryRawUnsafe: async (...input) => {
    calls.push(input);
    return [{ entitlements: 2, domainEvents: 2, schedules: 2,
      completedSeconds: 1, minimumLeadSeconds: 50_000, maxProjectionDelaySeconds: 1 }];
  } };
  await collectGlobalEventCapacityEvidence({
    prisma,
    fixture: { event: { id: "borrowed" }, manifest: { ids: {
      users: Array.from({ length: 10_000 }, (_, index) => `user-${index}`),
    } } },
    profile: "event_provisioning_10000",
    infrastructure: { processCeilingsOk: true },
  });
  assert.match(calls[0][0], /user_id::text = ANY\(\$2::text\[\]\)/i);
  assert.equal(calls[0][2].length, 10_000);
});

test("capacity fixture reset removes only derived global-event notification state", async () => {
  const statements = [];
  const tx = { $executeRawUnsafe: async (sql) => { statements.push(sql); } };
  await resetGlobalEventDerivedState({ $transaction: async (work) => work(tx) });
  const sql = statements.join("\n");
  for (const table of [
    "notification_schedules", "inbox_alerts", "domain_event_outbox",
    "global_event_user_summaries", "global_event_race_impacts",
    "global_step_event_boundary_cursors", "global_step_event_entitlements",
    "global_step_events", "global_step_event_operational_snapshots",
    "global_step_event_operational_counters",
  ]) assert.match(sql, new RegExp(`DELETE FROM ${table}`, "i"));
  for (const protectedTable of ["users", "races", "race_participants", "steps", "step_samples"]) {
    assert.doesNotMatch(sql, new RegExp(`DELETE FROM ${protectedTable}(?:\\s|$)`, "i"));
  }
});

test("capacity global-event cleanup locks and removes only owned parents before generic cleanup", async () => {
  const ownedEventId = "11111111-1111-4111-8111-111111111111";
  const otherEventId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const tx = {
    $queryRawUnsafe: async (sql, ids) => {
      calls.push({ kind: "query", sql, ids });
      return [{ id: ownedEventId }];
    },
    $executeRawUnsafe: async (sql, ids) => {
      calls.push({ kind: "execute", sql, ids });
      return 1;
    },
  };
  const prisma = {
    $transaction: async (work) => {
      calls.push({ kind: "transaction-start" });
      const result = await work(tx);
      calls.push({ kind: "transaction-commit" });
      return result;
    },
  };
  const manifest = {
    schema: "synthetic-load-manifest-v1",
    runId: "event-cleanup-run",
    baseline: {},
    ids: {
      users: ["33333333-3333-4333-8333-333333333333"],
      races: ["44444444-4444-4444-8444-444444444444"],
      globalEvents: [ownedEventId, "not-a-uuid", "------------------------------------"],
    },
  };
  const genericCleanup = async (input) => {
    calls.push({ kind: "generic-cleanup", input });
    return { cleaned: true, baselineUnchanged: true };
  };

  await cleanupSyntheticRun({ prisma, manifest, genericCleanup });

  assert.equal(calls[0].kind, "transaction-start");
  assert.equal(calls[1].kind, "query");
  assert.match(calls[1].sql, /UPDATE global_step_events[\s\S]*schedule_mode='CAPACITY_CLEANUP'/i);
  assert.deepEqual(calls[1].ids, [ownedEventId]);
  assert.equal(calls[2].kind, "transaction-commit");
  assert.equal(calls[3].kind, "transaction-start");
  assert.match(calls[4].sql, /FROM global_step_events[\s\S]*FOR UPDATE/i);
  assert.deepEqual(calls[4].ids, [ownedEventId]);
  assert.match(calls[5].sql, /FROM global_step_event_entitlements[\s\S]*FOR UPDATE/i);
  assert.deepEqual(calls[5].ids, [ownedEventId]);
  const deletes = calls.filter((call) => call.kind === "execute");
  for (const table of [
    "notification_schedules", "inbox_alerts", "domain_event_outbox",
    "global_event_user_summaries", "global_event_race_impacts",
    "global_step_event_boundary_cursors", "global_step_event_entitlements",
    "global_step_events",
  ]) {
    assert.ok(deletes.some((call) => new RegExp(`DELETE FROM ${table}`, "i").test(call.sql)));
  }
  for (const deletion of deletes) {
    assert.match(deletion.sql, /WHERE/i);
    assert.deepEqual(deletion.ids, [ownedEventId]);
    assert.equal(deletion.sql.includes(otherEventId), false);
  }
  const parentDelete = calls.findIndex((call) =>
    call.kind === "execute" && /DELETE FROM global_step_events/i.test(call.sql));
  const commit = calls.findIndex((call, index) =>
    index > parentDelete && call.kind === "transaction-commit");
  const generic = calls.findIndex((call) => call.kind === "generic-cleanup");
  assert.ok(parentDelete > 4);
  assert.ok(commit > parentDelete);
  assert.ok(generic > commit);
  assert.deepEqual(calls[generic].input.manifest.ids.globalEvents, []);
});

test("capacity global-event cleanup rejects an invalid manifest before opening a transaction", async () => {
  let transactionStarted = false;
  await assert.rejects(
    cleanupSyntheticRun({
      prisma: { $transaction: async () => { transactionStarted = true; } },
      manifest: {
        schema: "untrusted-manifest",
        runId: "event-cleanup-run",
        ids: { globalEvents: ["11111111-1111-4111-8111-111111111111"] },
      },
      genericCleanup: async () => {},
    }),
    /valid run manifest/i,
  );
  assert.equal(transactionStarted, false);
});

test("event load profiles select event-specific setup and cleanup together", () => {
  const lifecycle = selectSyntheticFixtureLifecycle({
    eventReliability: true,
    fixtureFactory: createSyntheticFixtures,
    cleanup: cleanupGenericSyntheticRun,
  });
  assert.equal(lifecycle.fixtureFactory, createGlobalEventReliabilityFixtures);
  assert.equal(lifecycle.cleanup, cleanupSyntheticRun);

  const customFactory = async () => {};
  const customCleanup = async () => {};
  assert.deepEqual(selectSyntheticFixtureLifecycle({
    eventReliability: true,
    fixtureFactory: customFactory,
    cleanup: customCleanup,
  }), { fixtureFactory: customFactory, cleanup: customCleanup });
});

test("event cleanup reports unrelated baseline drift but never hides a synthetic leak", async () => {
  const manifest = {
    schema: "synthetic-load-manifest-v1",
    runId: "event-cleanup-drift",
    baseline: {},
    ids: { globalEvents: [] },
  };
  const drift = await cleanupSyntheticRun({
    prisma: {},
    manifest,
    genericCleanup: async () => {
      throw new Error("baseline integrity changed during synthetic cleanup");
    },
  });
  assert.deepEqual(drift, {
    cleaned: true,
    baselineUnchanged: false,
    baselineDriftObserved: true,
  });
  await assert.rejects(cleanupSyntheticRun({
    prisma: {},
    manifest,
    genericCleanup: async () => { throw new Error("synthetic cleanup leaked rows in steps"); },
  }), /leaked rows/);
});

test("executable fixture census accounts for every race membership and installation", () => {
  assert.deepEqual(globalEventFixtureCensus(), {
    users: 10_000,
    races: 3,
    participants: 14_000,
    installations: 12_000,
    usersByRaceCount: { 1: 7_000, 2: 2_000, 3: 1_000 },
    usersByInstallationCount: { 0: 2_000, 1: 6_000, 2: 1_500, 5: 400, 10: 100 },
  });
});

test("production-shaped capacity roles advertise the exact four-owner census", () => {
  const limits = capacityPoolLimits("role-budget");
  const resolution = roleChildEnvironment({}, "resolution", "3010", limits);
  const cron = roleChildEnvironment({}, "cron", "3011", limits);
  const owners = [
    logicalOwnerIdForProcess({ STEPS_PROCESS_ROLE: "http", NODE_APP_INSTANCE: "0" }),
    logicalOwnerIdForProcess({ STEPS_PROCESS_ROLE: "http", NODE_APP_INSTANCE: "1" }),
    logicalOwnerIdForProcess(resolution),
    logicalOwnerIdForProcess(cron),
  ];
  assert.deepEqual(owners, ["http:0", "http:1", "resolution:0", "cron:0"]);
  assert.deepEqual(BACKGROUND_NODE_EXEC_ARGV, [
    "--max-old-space-size=320",
    "--max-semi-space-size=8",
  ]);
  assert.equal(resolution.DB_POOL_MAX, "8");
  assert.equal(cron.DB_POOL_MAX, "4");
  const clusterSource = fs.readFileSync(
    path.join(__dirname, "../../../scripts/capacity-cluster.js"),
    "utf8",
  );
  assert.match(clusterSource, /capacityPoolLimits\(capacityPoolProfile\(process\.env\)\)/);
  assert.match(clusterSource, /STEPS_PROCESS_ROLE: "http"[\s\S]*DB_POOL_MAX: limits\.http/);
});

test("capacity pool profile reproducibly selects legacy baseline or role-budget candidate", () => {
  assert.equal(capacityPoolProfile({ database_pool_profile: "legacy20" }), "legacy20");
  assert.equal(capacityPoolProfile({ database_pool_profile: "role-budget" }), "role-budget");
  assert.throws(() => capacityPoolProfile({}), /database_pool_profile/);
  assert.throws(() => capacityPoolProfile({ database_pool_profile: "other" }), /legacy20 or role-budget/);
  assert.deepEqual(capacityPoolLimits("legacy20"), { http: "20", resolution: "20", cron: "20" });
  assert.deepEqual(capacityPoolLimits("role-budget"), { http: "10", resolution: "8", cron: "4" });
});

test("the command-line event profile reaches the Lima backend start hook", () => {
  assert.equal(globalEventProfile(
    { profile: "full_app" },
    { CAPACITY_GLOBAL_EVENT_PROFILE: "event_boundary_10000" },
  ), "event_boundary_10000");
  assert.equal(globalEventProfile({ profile: "event_provisioning_10000" }, {}), "event_provisioning_10000");

  const environment = {};
  applyCapacityProvider({
    provider: "lima",
    profile: "event_provider_outage_10000",
    run_id: "cli-run",
    base_url: "http://127.0.0.1:3000",
    live_manifest: "docs/capacity-lima.manifest.json",
  }, "docs/capacity-load.config.json", environment);
  assert.equal(environment.CAPACITY_GLOBAL_EVENT_PROFILE, "event_provider_outage_10000");
  assert.equal(environment.CAPACITY_RUN_ID, "cli-run");
  assert.match(environment.CAPACITY_START_HOOK, /lima-capacity\.js.*start/);
  assert.equal(capacityRunId(
    { run_id: "config-run" },
    { CAPACITY_RUN_ID: "cli-run" },
  ), "cli-run");
});

test("capacity metrics normalize every infrastructure gate and reject a missing artifact", () => {
  const eventStartsAt = new Date("2098-08-26T10:02:00.000Z");
  const providerCensus = {
    profile: "event_boundary_10000", attemptCount: 12_000, totalCalls: 12_084,
    initialCycle: { total: 12_000, accepted: 11_904, throttled: 60, transient: 24, invalid: 12 },
  };
  const processHealth = (role, instance, rss) => ({ status: "ok", capacity: {
    process: { role, instance }, memory: { rss },
    globalEventProfile: "event_boundary_10000",
    runId: "capacity-metrics-run",
    dbPool: { waitMsP99: 12, connectionFailures: 0 },
    eventLoop: { maxMs: 20 },
    providerCensus: role === "cron" ? providerCensus : null,
  } });
  const windowStart = eventStartsAt.getTime() - 120_000;
  const metrics = {
    schema: "capacity-metrics-v2",
    runId: "capacity-metrics-run",
    profile: "event_boundary_10000",
    repeat: 2,
    samples: Array.from({ length: 720 }, (_, index) => ({
      at: new Date(windowStart + index * 1_000).toISOString(),
      lockWaitMs: [index < 120 ? 5 : 7],
      resolutionQueueLagMs: index < 120 ? 10 : 15,
      health: {
        http: processHealth("http", String(index % 2), 100),
        resolution: processHealth("resolution", "0", 100),
        cron: processHealth("cron", "0", 100),
      },
    })),
  };
  const evidence = normalizeGlobalEventInfrastructure({
    metrics, eventStartsAt, expectedProfile: "event_boundary_10000",
    expectedRunId: "capacity-metrics-run", expectedRepeat: 2,
    requestSamples: [
      { completedAtMs: eventStartsAt.getTime() - 1_000, latencyMs: 100 },
      { completedAtMs: eventStartsAt.getTime() + 1_000, latencyMs: 110 },
    ],
  });
  assert.equal(evidence.processCeilingsOk, true);
  assert.equal(evidence.cronRssBytes, 100);
  assert.equal(evidence.lockWaitP99Ms, 7);
  assert.equal(evidence.warmupHttpP95Ms, 100);
  assert.equal(evidence.measuredHttpP95Ms, 110);
  assert.equal(evidence.unrelatedQueueLagIncreaseMs, 5);
  assert.equal(evidence.sawtoothDetected, false);
  assert.deepEqual(evidence.providerCensus, providerCensus);
  assert.throws(() => normalizeGlobalEventInfrastructure({
    metrics: null, requestSamples: [], eventStartsAt, expectedProfile: "event_boundary_10000",
    expectedRunId: "capacity-metrics-run", expectedRepeat: 2,
  }), /capacity-metrics-v2/i);
  const wrongWiring = structuredClone(metrics);
  wrongWiring.samples[300].health.cron.capacity.globalEventProfile = "event_provider_outage_10000";
  assert.throws(() => normalizeGlobalEventInfrastructure({
    metrics: wrongWiring, requestSamples: [], eventStartsAt,
    expectedProfile: "event_boundary_10000", expectedRunId: "capacity-metrics-run", expectedRepeat: 2,
  }), /run\/profile wiring/i);
  const missingInterval = structuredClone(metrics);
  missingInterval.samples.splice(300, 2);
  assert.throws(() => normalizeGlobalEventInfrastructure({
    metrics: missingInterval, requestSamples: [], eventStartsAt,
    expectedProfile: "event_boundary_10000", expectedRunId: "capacity-metrics-run", expectedRepeat: 2,
  }), /missing interval/i);
  const failedRole = structuredClone(metrics);
  failedRole.samples[300].health.resolution = { error: "connection refused" };
  assert.throws(() => normalizeGlobalEventInfrastructure({
    metrics: failedRole, requestSamples: [], eventStartsAt,
    expectedProfile: "event_boundary_10000", expectedRunId: "capacity-metrics-run", expectedRepeat: 2,
  }), /resolution health telemetry failed/i);
});

test("capacity metrics query the mapped PostgreSQL race-resolution enum values", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../scripts/capacity-metrics.js"), "utf8");
  assert.match(source, /state IN \('queued','running'\)/);
  assert.doesNotMatch(source, /state IN \('QUEUED','RUNNING'\)/);
  assert.doesNotMatch(source, /execFileSync/);
  assert.match(source, /Promise\.allSettled\(\[\.\.\.inFlight\]\)/);
});

test("load traffic cannot use a profile different from the started capacity run", () => {
  assert.equal(assertCapacityRunProfile({ profile: "event_boundary_10000" }, "event_boundary_10000"), true);
  assert.throws(() => assertCapacityRunProfile(
    { profile: "full-app" },
    "event_boundary_10000",
  ), /profile mismatch/i);
});

test("capacity evidence and metrics artifacts cannot be overwritten", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-capacity-artifacts-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, "repeat.json");
  writeImmutableArtifact(evidence, "first\n");
  assert.throws(() => writeImmutableArtifact(evidence, "second\n"), /already exists/i);
  assert.equal(fs.readFileSync(evidence, "utf8"), "first\n");

  const metrics = path.join(directory, "repeat.metrics.json");
  writeImmutableMetrics(metrics, { schema: "capacity-metrics-v2", samples: [] });
  assert.throws(() => writeImmutableMetrics(metrics, { schema: "capacity-metrics-v2", samples: [] }), /already exists/i);
});

test("aggregate publication requires every repeat artifact with matching provenance", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "event-capacity-complete-set-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runId = "capacity-complete-set";
  const profile = "event_boundary_10000";
  for (const repeat of [1, 2, 3]) {
    const evidence = passingEvidence(profile, repeat);
    evidence.runId = runId;
    evidence.infrastructure.metricsProvenance.runId = runId;
    fs.writeFileSync(path.join(directory, `${runId}.event-repeat-${repeat}.json`), JSON.stringify(evidence));
    fs.writeFileSync(path.join(directory, `${runId}.repeat-${repeat}.metrics.json`), JSON.stringify({
      schema: "capacity-metrics-v2", runId, profile, repeat, samples: [],
    }));
    fs.writeFileSync(path.join(directory, `${runId}.repeat-${repeat}.json`), JSON.stringify({
      runId, profile, eventReliability: { repeat, evidence },
    }));
    fs.writeFileSync(path.join(directory, `${runId}.repeat-${repeat}.txt`),
      `run=${runId} target=capacity-vm profile=${profile}@phase2 repeat=${repeat}\n`);
  }
  assert.equal(assertGlobalEventArtifactSet({ outputDir: directory, runId, profile }).length, 3);
  fs.rmSync(path.join(directory, `${runId}.repeat-2.txt`));
  assert.throws(() => assertGlobalEventArtifactSet({ outputDir: directory, runId, profile }),
    /complete artifact set/i);
});

test("metrics child exit is observed even before finalization begins", async () => {
  const child = new (require("node:events").EventEmitter)();
  const observed = observeChildExit(child);
  child.exitCode = 17;
  child.emit("exit", 17, null);
  assert.deepEqual(await observed, { code: 17, signal: null, error: null });
});

test("capacity scrub writes the run-bound marker consumed at startup", async () => {
  const calls = [];
  const client = { query: async (...args) => { calls.push(args); } };
  await writeCapacityOperatorMarker(client, {
    runId: "capacity-marker-run",
    markerHash: "a".repeat(64),
  });
  assert.match(calls[0][0], /CREATE TABLE IF NOT EXISTS capacity_operator_runs/i);
  assert.match(calls[1][0], /INSERT INTO capacity_operator_runs/i);
  assert.deepEqual(calls[1][1], ["capacity-marker-run", "a".repeat(64)]);
});

test("one repeat cannot be represented as the approved three-repeat evidence", () => {
  const evidence = passingEvidence();
  evidence.repetitions = 1;
  assert.throws(() => assertGlobalEventCapacityGates(evidence), /repetitions/i);
});

test("three-repeat aggregation fails closed and preserves each worst stage", () => {
  assert.throws(() => aggregateGlobalEventCapacityEvidence([passingEvidence()]), /three clean repetitions/i);
  const repetitions = [1, 2, 3].map((repeat) => passingEvidence("event_boundary_10000", repeat));
  repetitions[1].stages.activationMs.p99 = 4_999;
  repetitions[2].infrastructure.cronRssBytes = 511.5 * 1024 * 1024;
  const aggregate = aggregateGlobalEventCapacityEvidence(repetitions);
  assert.equal(aggregate.repetitions, 3);
  assert.equal(aggregate.stages.activationMs.p99, 4_999);
  assert.equal(aggregate.infrastructure.cronRssBytes, 511.5 * 1024 * 1024);
  assert.equal(assertGlobalEventCapacityGates(aggregate), true);
});

test("event boundary fixtures exactly model approved race and installation distributions", () => {
  const raceCounts = new Map();
  const installationCounts = new Map();
  for (let index = 0; index < 10_000; index += 1) {
    const races = raceCountForUser(index, 10_000);
    const installations = installationCountForUser(index, 10_000);
    raceCounts.set(races, (raceCounts.get(races) || 0) + 1);
    installationCounts.set(installations, (installationCounts.get(installations) || 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(raceCounts), { 1: 7000, 2: 2000, 3: 1000 });
  assert.deepEqual(Object.fromEntries(installationCounts), {
    0: 2000, 1: 6000, 2: 1500, 5: 400, 10: 100,
  });
});

test("healthy provider stub has exact deterministic latency and failure census", () => {
  const counts = new Map();
  const latencies = [];
  for (let index = 0; index < 10_000; index += 1) {
    const result = providerResultForAttempt({
      profile: "event_boundary_10000",
      attemptIndex: index,
      attemptCount: 10_000,
      elapsedMs: 70_000,
    });
    counts.set(result.kind, (counts.get(result.kind) || 0) + 1);
    latencies.push(result.latencyMs);
  }
  assert.deepEqual(Object.fromEntries(counts), {
    THROTTLED: 50, TRANSIENT: 20, INVALID: 10, ACCEPTED: 9920,
  });
  latencies.sort((a, b) => a - b);
  assert.equal(latencies[4999], 40);
  assert.equal(latencies[9499], 120);
  assert.equal(latencies[9899], 300);
  assert.equal(providerResultForAttempt({
    profile: "event_boundary_10000", attemptIndex: 0, attemptCount: 10_000,
  }).retryAfterMs, 250);
});

test("provider outage profile fails transiently for 60 seconds then recovers", () => {
  assert.deepEqual(providerResultForAttempt({
    profile: "event_provider_outage_10000", attemptIndex: 500,
    attemptCount: 10_000, elapsedMs: 59_999,
  }), {
    kind: "TRANSIENT", latencyMs: 40, reason: "CAPACITY_PROVIDER_OUTAGE",
  });
  assert.notEqual(providerResultForAttempt({
    profile: "event_provider_outage_10000", attemptIndex: 500,
    attemptCount: 10_000, elapsedMs: 60_000,
  }).reason, "CAPACITY_PROVIDER_OUTAGE");
});

test("capacity provider sender exposes real adapter dispositions after deterministic latency", async () => {
  const delays = [];
  let current = 0;
  const send = buildCapacityProviderSender({
    profile: "event_boundary_10000",
    attemptCount: 10_000,
    elapsedMs: () => 70_000,
    sleep: async (delay) => { delays.push(delay); },
    nextAttemptIndex: () => current++,
  });
  assert.deepEqual(await send(), {
    success: false,
    statusCode: 429,
    reason: "HTTP_429",
    retryAfterMs: 250,
    environment: "capacity",
  });
  current = 80;
  assert.deepEqual(await send(), {
    success: true,
    providerMessageId: "capacity-80",
    environment: "capacity",
  });
  current = 50;
  assert.deepEqual(await send(), {
    success: false,
    statusCode: 503,
    reason: "HTTP_503",
    environment: "capacity",
  });
  current = 70;
  const outage = buildCapacityProviderSender({
    profile: "event_provider_outage_10000",
    attemptCount: 10_000,
    elapsedMs: () => 59_999,
    sleep: async () => {},
    nextAttemptIndex: () => current++,
  });
  assert.equal((await outage()).statusCode, 503);
  assert.deepEqual(delays, [40, 40, 40]);
});

function passingEvidence(profile = "event_boundary_10000", repeat = 1) {
  return {
    profile,
    runId: "capacity-test-run",
    repeat,
    fixtureUsers: 10_000,
    repetitions: 3,
    background: {
      authenticatedHttp: { buckets: Array.from({ length: 720 }, (_, second) => ({ second, offered: 25, completedSuccessful: 25, failed: 0 })) },
      resolutionJobs: { buckets: Array.from({ length: 720 }, (_, second) => ({ second, offered: 50, completedSuccessful: 50, failed: 0 })) },
    },
    provisioning: {
      entitlements: 10_000,
      domainEvents: 10_000,
      schedules: 10_000,
      completedSeconds: 500,
      maxProjectionDelaySeconds: 240,
      minimumLeadSeconds: 44_000,
    },
    stages: {
      activationMs: { p95: 1900, p99: 4900 },
      materializationMs: { p95: 900, p99: 2900 },
      submissionMs: { p95: 4900, p99: 9900 },
      adapterMs: { p95: 499, p99: 1999 },
      acceptanceMs: { p95: 4900, p99: 9900 },
    },
    completeness: {
      eligible: 10_000, materializedSchedules: 10_000,
      alerts: 10_000, outboxes: 10_000, cancelledEligible: 0,
      snappedTargets: 12_000, terminalTargets: 12_000,
      rowLocalFailures: 0, oldestPendingMs: 29_999,
    },
    providerCensus: {
      profile: "event_boundary_10000", attemptCount: 12_000, totalCalls: 12_084,
      initialCycle: { total: 12_000, accepted: 11_904, throttled: 60, transient: 24, invalid: 12 },
    },
    infrastructure: {
      cronRssBytes: 511 * 1024 * 1024,
      processCeilingsOk: true,
      dbPoolWaitP99Ms: 100,
      lockWaitP99Ms: 100,
      warmupHttpP95Ms: 100,
      measuredHttpP95Ms: 120,
      unrelatedQueueLagIncreaseMs: 2000,
      poolExhaustions: 0,
      maxEventLoopStallMs: 250,
      sawtoothDetected: false,
      metricsProvenance: { runId: "capacity-test-run", profile, repeat },
    },
    outage: { recovered: true, expiredExplicitly: 0 },
  };
}

test("event capacity gates fail closed on every approved infrastructure and completeness boundary", () => {
  assert.equal(assertGlobalEventCapacityGates(passingEvidence()), true);
  const missing = passingEvidence();
  delete missing.infrastructure.lockWaitP99Ms;
  assert.throws(() => assertGlobalEventCapacityGates(missing), /infrastructure telemetry/i);
  const nullInfrastructure = passingEvidence();
  nullInfrastructure.infrastructure.lockWaitP99Ms = null;
  assert.throws(() => assertGlobalEventCapacityGates(nullInfrastructure), /infrastructure telemetry/i);
  for (const [path, value, message] of [
    ["cronRssBytes", 512 * 1024 * 1024, /RSS/i],
    ["dbPoolWaitP99Ms", 101, /pool wait/i],
    ["lockWaitP99Ms", 101, /lock wait/i],
    ["measuredHttpP95Ms", 121, /HTTP p95/i],
    ["unrelatedQueueLagIncreaseMs", 2001, /queue lag/i],
    ["poolExhaustions", 1, /pool exhaustion/i],
    ["maxEventLoopStallMs", 251, /event-loop/i],
    ["sawtoothDetected", true, /sawtooth/i],
  ]) {
    const evidence = passingEvidence();
    evidence.infrastructure[path] = value;
    assert.throws(() => assertGlobalEventCapacityGates(evidence), message);
  }
  const incomplete = passingEvidence();
  incomplete.completeness.terminalTargets -= 1;
  assert.throws(() => assertGlobalEventCapacityGates(incomplete), /target completeness/i);
  const missingEligible = passingEvidence();
  missingEligible.completeness.eligible -= 1;
  missingEligible.completeness.materializedSchedules -= 1;
  missingEligible.completeness.alerts -= 1;
  missingEligible.completeness.outboxes -= 1;
  assert.throws(() => assertGlobalEventCapacityGates(missingEligible), /eligible census/i);
  const missingTarget = passingEvidence();
  missingTarget.completeness.snappedTargets -= 1;
  missingTarget.completeness.terminalTargets -= 1;
  assert.throws(() => assertGlobalEventCapacityGates(missingTarget), /target census/i);
  const stale = passingEvidence();
  stale.completeness.oldestPendingMs = 30_001;
  assert.throws(() => assertGlobalEventCapacityGates(stale), /oldest pending/i);
  for (const key of ["materializedSchedules", "alerts", "outboxes"]) {
    const incompleteRelationship = passingEvidence();
    incompleteRelationship.completeness[key] -= 1;
    assert.throws(() => assertGlobalEventCapacityGates(incompleteRelationship), /completeness/i);
  }
  const cancelled = passingEvidence();
  cancelled.completeness.cancelledEligible = 1;
  assert.throws(() => assertGlobalEventCapacityGates(cancelled), /cancellation/i);
  const missingLatency = passingEvidence();
  missingLatency.stages.activationMs.p99 = null;
  assert.throws(() => assertGlobalEventCapacityGates(missingLatency), /activation latency/i);
  const missingProviderDisposition = passingEvidence();
  missingProviderDisposition.providerCensus.initialCycle.accepted -= 1;
  assert.throws(() => assertGlobalEventCapacityGates(missingProviderDisposition), /provider disposition census/i);
});

test("three-repeat aggregation rejects mixed or duplicate provenance", () => {
  const duplicate = [1, 1, 3].map((repeat) => passingEvidence("event_boundary_10000", repeat));
  assert.throws(() => aggregateGlobalEventCapacityEvidence(duplicate), /run\/repeat provenance/i);
  const mixed = [1, 2, 3].map((repeat) => passingEvidence("event_boundary_10000", repeat));
  mixed[2].infrastructure.metricsProvenance.runId = "different-run";
  assert.throws(() => aggregateGlobalEventCapacityEvidence(mixed), /metrics provenance/i);
});

test("background evidence fails on an unsuccessful or under-rate second", () => {
  const evidence = passingEvidence().background;
  assert.equal(assertSustainedBackgroundLoad(evidence), true);
  evidence.authenticatedHttp.buckets[17].completedSuccessful = 24;
  assert.throws(() => assertSustainedBackgroundLoad(evidence), /authenticatedHttp second 17/i);
});

test("paced background producer records successful work in every offered second", async () => {
  let currentMs = 0;
  const result = await runPacedBackgroundProducer({
    rate: 2,
    durationSeconds: 2,
    startedAtMs: 0,
    clock: () => currentMs,
    wait: async (delay) => { currentMs += delay; },
    runOne: async () => true,
  });
  assert.deepEqual(result.buckets, [
    { second: 0, offered: 2, completedSuccessful: 2, failed: 0 },
    { second: 1, offered: 2, completedSuccessful: 2, failed: 0 },
  ]);
});

test("provisioning gate requires every entitlement, domain event, and schedule", () => {
  const evidence = passingEvidence("event_provisioning_10000");
  assert.equal(assertGlobalEventCapacityGates(evidence), true);
  for (const key of ["entitlements", "domainEvents", "schedules"]) {
    const incomplete = passingEvidence("event_provisioning_10000");
    incomplete.provisioning[key] -= 1;
    assert.throws(() => assertGlobalEventCapacityGates(incomplete), /provisioning census/i);
  }
});

test("outage gate requires durable recovery but does not claim healthy acceptance SLO", () => {
  const evidence = passingEvidence("event_provider_outage_10000");
  evidence.stages.adapterMs = null;
  evidence.stages.acceptanceMs = null;
  assert.equal(assertGlobalEventCapacityGates(evidence), true);
  evidence.outage.recovered = false;
  assert.throws(() => assertGlobalEventCapacityGates(evidence), /outage recovery/i);
});
