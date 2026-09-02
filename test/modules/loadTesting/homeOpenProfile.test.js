const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const { PROFILES, validateProfileRegistry } = require("../../../src/modules/loadTesting/contract");
const {
  assertHomeOpenGates,
  classifyHomeRaceCard,
  classifyHomeSyncV2,
  runHomeOpenSession,
} = require("../../../src/modules/loadTesting/runner");
const { capacityResourcePlan, ensureVmResources } = require("../../../scripts/lima-capacity");
const { aggregateHomeOpenLadder, executionBundleHash, normalizeInfrastructure,
  createInFlightTracker, progressFromMetricsRows, resolutionEvidenceFromLog, waitFor,
  resetCapacityDbPoolMeasurements, waitForResolutionQueueQuiescence,
  waitForResolutionWorkerReady } = require("../../../scripts/k6-home-open");
const { homeStepPayload, scaleHomeTopology } = require("../../../src/modules/loadTesting/homeOpenFixtures");
const { baselineIntegrityDiff } = require("../../../src/modules/loadTesting/fixtures");
const { buildRaceResolutionWorkerV2 } = require("../../../src/modules/races/jobs/raceResolutionQueueV2");

const root = path.resolve(__dirname, "../../..");

test("home-open aggregates identifier-free resolution phase evidence", () => {
  const log = [
    { event: "race_resolution_v2_claim", schemaVersion: 2,
      observedAt: "2026-09-01T11:59:59.000Z", queuePriority: "LIVE", queueLagMs: 5 },
    { event: "race_resolution_v2", outcome: "commit", resolutionPlan: "STEP_SYNC_INCREMENTAL",
      schemaVersion: 2, observedAt: "2026-09-01T12:00:00.000Z", queuePriority: "LIVE",
      coreMs: 20, queueLagMs: 5, phaseMs: { compute: 8, transaction: 4 },
      computePhaseMs: { raceLoad: 6 } },
    { event: "race_resolution_v2_claim", schemaVersion: 2,
      observedAt: "2026-09-01T12:00:00.500Z", queuePriority: "LIVE", queueLagMs: 15 },
    { event: "race_resolution_v2", outcome: "commit", resolutionPlan: "STEP_SYNC_INCREMENTAL",
      schemaVersion: 2, observedAt: "2026-09-01T12:00:01.000Z", queuePriority: "LIVE",
      coreMs: 40, queueLagMs: 15, phaseMs: { compute: 16, transaction: 8 },
      computePhaseMs: { raceLoad: 12 } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(resolutionEvidenceFromLog(log), {
    schema: "home-open-resolution-evidence-v2",
    jobs: 2,
    claims: 2,
    terminalCount: 2,
    terminalReconciled: true,
    outcomes: { commit: 2 },
    plans: { STEP_SYNC_INCREMENTAL: 2 },
    priorities: { LIVE: 2 },
    coreMs: { p50: 20, p95: 40, p99: 40 },
    queueLagMs: { p50: 5, p95: 15, p99: 15 },
    phases: {
      compute: { p50: 8, p95: 16, p99: 16 },
      "compute.raceLoad": { p50: 6, p95: 12, p99: 12 },
    },
    attribution: { excludesOverlappingTransactionAggregate: true,
      computeBreakdownIsNested: true, cumulativeTopLevelMs: { compute: 24 },
      cumulativeCoreMs: 60, clockToleranceMs: 50, unattributedMs: 36 },
  });
  assert.equal(JSON.stringify(resolutionEvidenceFromLog(log)).includes("raceId"), false);
  assert.throws(() => resolutionEvidenceFromLog(JSON.stringify({
    event: "race_resolution_v2", outcome: "failed",
  })), /incomplete/);
  assert.throws(() => resolutionEvidenceFromLog(JSON.stringify({
    event: "race_resolution_v2_claim", schemaVersion: 2,
    observedAt: "2026-09-01T12:00:00.000Z", queuePriority: "LIVE", queueLagMs: 1,
  })), /do not reconcile/);
  const overAttributed = [
    { event: "race_resolution_v2_claim", schemaVersion: 2,
      observedAt: "2026-09-01T12:00:00.000Z", queuePriority: "LIVE", queueLagMs: 1 },
    { event: "race_resolution_v2", schemaVersion: 2,
      observedAt: "2026-09-01T12:00:01.000Z", queuePriority: "LIVE", outcome: "commit",
      coreMs: 10, queueLagMs: 1, phaseMs: { compute: 100 } },
  ].map(JSON.stringify).join("\n");
  assert.throws(() => resolutionEvidenceFromLog(overAttributed), /exceed/);
});

test("home-open locks the versioned coherent-session contract without changing home", () => {
  assert.equal(validateProfileRegistry(), true);
  assert.equal(PROFILES.home.version, "1.0.0");
  const profile = PROFILES["home-open"];
  assert.equal(profile.schema, "load-profile-v1");
  assert.equal(profile.version, "2.1.0");
  assert.deepEqual(profile.defaults, {
    users: 5000,
    duration: "600s",
    arrivalRatePerSecond: 1,
    concurrency: 5000,
  });
  assert.deepEqual(profile.ladder, {
    smoke: { rate: 1, seconds: 120 },
    warmupSeconds: 120,
    measurementSeconds: 600,
    rates: [2, 5, 10, 20, 30, 40, 60, 80, 100, 150, 225, 340, 500],
    hardCap: 500,
    boundaryRepeats: 3,
  });
  assert.equal(profile.homeOpen.schema, "home-open-session-v1");
  assert.equal(profile.homeOpen.clientHeaderProfile, "current-home-2.3.11-ios-v1");
  assert.ok(profile.homeOpen.clientFeatures.includes("race_payout_flat_50"));
  assert.equal(profile.homeOpen.arrivalBucketMs, 1000);
  assert.equal(profile.homeOpen.allSettledDeadlineMs, 15000);
  assert.deepEqual(profile.homeOpen.resolutionPollWaitMs, [750, 1500, 3000, 5000]);
  assert.deepEqual(profile.homeOpen.criticalEndpoints, [
    "POST /steps/sync-v2", "POST /steps", "GET /home/race-card",
    "GET /races", "GET /shop/catalog", "GET /friends", "GET /auth/me",
  ]);
  const endpoints = profile.entries.map((row) => `${row.method} ${row.path}`);
  assert.deepEqual(endpoints, [
    "POST /steps/sync-v2", "POST /steps", "POST /steps/samples",
    "GET /home/race-card", "GET /races", "GET /home/suggested-races",
    "GET /shop/catalog", "GET /friends", "GET /auth/me",
    "GET /assets/manifest", "GET /steps/race-resolution/:jobId",
  ]);
  assert.equal(profile.entries[0].headers["X-Step-Sync-Intent"], undefined);
});

test("home-open response classifiers fail closed on malformed and cooldown responses", () => {
  assert.deepEqual(classifyHomeSyncV2({ status: 202, body: {
    uploaderReconciliation: { state: "CURRENT" },
    raceResolution: { jobId: "job-1", generation: 7 },
  } }), { persisted: true, usePersistedHome: true, retry: false, legacy: false,
    job: { id: "job-1", generation: 7 }, decision: "current" });
  assert.equal(classifyHomeSyncV2({ status: 503, body: { code: "ASYNC_DISABLED" } }).legacy, true);
  assert.equal(classifyHomeSyncV2({ status: 503, body: { code: "OVERLOADED" } }).retry, true);
  assert.equal(classifyHomeSyncV2({ status: 429, body: { code: "STEP_SYNC_COOLDOWN" } }).persisted, false);
  assert.equal(classifyHomeSyncV2({ status: 409, body: {} }).persisted, true);
  assert.equal(classifyHomeSyncV2({ status: 400, body: {} }).persisted, false);

  assert.deepEqual(classifyHomeRaceCard({
    contract: "home-shell-v1", resolved: { presentation: true, friends: true },
    presentation: { equipped: {}, coins: 4, cape: null },
    friends: { friends: [], pending: { incoming: [], outgoing: [] } },
  }), { presentationResolved: true, friendsResolved: true });
  assert.deepEqual(classifyHomeRaceCard({ contract: "wrong" }), {
    presentationResolved: false, friendsResolved: false,
  });
  for (const malformed of [[], { contract: "home-shell-v1", resolved: [],
    presentation: { equipped: [], coins: 4, cape: null } },
  { contract: "home-shell-v1", resolved: { presentation: true },
    presentation: { equipped: {}, coins: 4, cape: [] } }]) {
    assert.equal(classifyHomeRaceCard(malformed).presentationResolved, false);
  }
  assert.equal(classifyHomeRaceCard({
    contract: "home-shell-v1", resolved: { friends: true },
    friends: { friends: [[]], pending: { incoming: [], outgoing: [] } },
  }).friendsResolved, false);
});

test("home-open shared runner rejects malformed critical maps and takes valid fallbacks", async () => {
  const response = (status, body) => ({ status, body, timeout: false, unexpectedStatus: false, latencyMs: 1 });
  const run = (malformedPath, malformedBody) => runHomeOpenSession({
    context: { today: "2026-09-01", runId: "malformed", userIndex: 1 }, sequence: 1,
    requestOne: async ({ entry }) => {
      if (entry.path === "/steps/sync-v2") return response(202, { uploaderReconciliation: { state: "CURRENT" } });
      if (entry.path === malformedPath) return response(200, malformedBody);
      if (entry.path === "/home/race-card") return response(200, {
        contract: "home-shell-v1", resolved: { presentation: false, friends: false },
      });
      if (entry.path === "/shop/catalog") return response(200, { coins: 1, equipped: {}, items: [] });
      if (entry.path === "/friends") return response(200, { friends: [], pending: { incoming: [], outgoing: [] } });
      if (entry.path === "/auth/me") return response(200, { user: { id: "user-1" } });
      if (entry.path === "/races") return response(200, { active: [], pending: [], completed: [] });
      return response(200, {});
    },
  });
  for (const [endpoint, body] of [["/auth/me", { user: [] }], ["/friends", { friends: {}, pending: {} }],
    ["/races", []], ["/shop/catalog", { coins: 1, equipped: [], items: [] }]]) {
    assert.equal((await run(endpoint, body)).criticalComplete, false, endpoint);
  }
  const fallback = await run("/home/race-card", []);
  assert.equal(fallback.decisions.raceCardPresentationFallback, 1);
  assert.equal(fallback.decisions.raceCardFriendsFallback, 1);
  assert.equal(fallback.criticalComplete, false, "malformed race-card must not become a successful critical response");
  const legacy = await runHomeOpenSession({
    context: { today: "2026-09-01", runId: "malformed-legacy", userIndex: 1 }, sequence: 1,
    wait: async () => {}, requestOne: async ({ entry }) => {
      if (entry.path === "/steps/sync-v2") return response(404, { code: "NOT_FOUND" });
      if (entry.path === "/steps") return response(200, []);
      if (entry.path === "/home/race-card") return response(200, { contract: "legacy" });
      if (entry.path === "/shop/catalog") return response(200, { coins: 1, equipped: {}, items: [] });
      if (entry.path === "/friends") return response(200, { friends: [], pending: { incoming: [], outgoing: [] } });
      if (entry.path === "/auth/me") return response(200, { user: {} });
      if (entry.path === "/races") return response(200, { active: [], pending: [], completed: [] });
      return response(200, {});
    },
  });
  assert.equal(legacy.criticalComplete, false, "malformed legacy persistence response must fail");
});

test("k6 classifiers have malformed-payload parity with the shipped Home client", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6/home-open.js"), "utf8");
  const contractSource = source.slice(source.indexOf("function isJsonMap"), source.indexOf("function uuid"));
  const classifiers = vm.runInNewContext(`${contractSource}\n({ classifySync, classifyRaceCard, validMap, validMe, validFriends, validRaces, validCatalog })`);
  const response = (status, body, malformed = false) => ({ status,
    json() { if (malformed) throw new Error("malformed"); return body; } });
  assert.equal(classifiers.classifySync(response(202, [], false)).persisted, false);
  assert.equal(classifiers.classifySync(response(202, null, true)).persisted, false);
  assert.deepEqual({ ...classifiers.classifyRaceCard(response(200, [])) }, { presentation: false, friends: false, valid: false });
  assert.equal(classifiers.classifyRaceCard(response(200, { contract: "home-shell-v1", resolved: { presentation: true },
    presentation: { equipped: [], coins: 1, cape: null } })).presentation, false);
  assert.equal(classifiers.validMe(response(200, { user: [] })), false);
  assert.equal(classifiers.validFriends(response(200, { friends: {}, pending: {} })), false);
  assert.equal(classifiers.validRaces(response(200, [])), false);
  assert.equal(classifiers.validCatalog(response(200, { coins: 1, equipped: [], items: [] })), false);
  assert.equal(classifiers.validMap(response(200, [])), false);
});

test("k6 phase quota admits exactly the configured arrivals before any Home request", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6/home-open.js"), "utf8");
  const quotaSource = source.slice(source.indexOf("function withinPhaseQuota"),
    source.indexOf("function userHeaders"));
  const withinPhaseQuota = vm.runInNewContext(`${quotaSource}\nwithinPhaseQuota`);
  for (const [phaseRate, seconds] of [[1, 120], [500, 600]]) {
    const expected = phaseRate * seconds;
    assert.equal(Array.from({ length: expected + 2 }, (_, iteration) =>
      withinPhaseQuota(iteration, phaseRate, seconds)).filter(Boolean).length, expected);
    assert.equal(withinPhaseQuota(expected - 1, phaseRate, seconds), true);
    assert.equal(withinPhaseQuota(expected, phaseRate, seconds), false);
    assert.equal(withinPhaseQuota(expected + 1, phaseRate, seconds), false);
  }
  const guard = source.indexOf("if (!withinPhaseQuota(");
  assert.ok(guard > 0);
  assert.ok(guard < source.indexOf("http.post(`${__ENV.K6_HOME_INFLIGHT_URL}/start`"),
    "surplus executor iterations must stop before observer or SUT requests");
  assert.match(source.slice(guard, guard + 300), /quotaRejected\.add\(1\)[\s\S]*return/);
  const uniqueIteration = source.indexOf("const iterationInInstance = exec.scenario.iterationInInstance");
  assert.ok(uniqueIteration > 0 && uniqueIteration < guard,
    "the quota must use k6's cross-VU unique scenario iteration index");
});

test("k6 assigns exactly one fail-closed Home session failure reason", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6/home-open.js"), "utf8");
  const start = source.indexOf("function homeOpenFailureReason");
  const end = source.indexOf("function userHeaders");
  const classify = vm.runInNewContext(`${source.slice(start, end)}\nhomeOpenFailureReason`);
  const passing = { critical: true, manifestsOk: true, suggestedOk: true,
    resolutionSettled: true, withinDeadline: true };
  assert.equal(classify(passing), null);
  for (const [field, reason] of [["critical", "critical"], ["manifestsOk", "manifest"],
    ["suggestedOk", "suggested"], ["resolutionSettled", "resolution_not_settled"],
    ["withinDeadline", "deadline"]]) {
    assert.equal(classify({ ...passing, [field]: false }), reason);
  }
  assert.equal(classify({ ...passing, critical: false, manifestsOk: false }), "critical");
});

test("one home-open session preserves step-first and response-dependent fan-out", async () => {
  const calls = [];
  let raceCardCalls = 0;
  const response = (status, body = {}) => ({ status, body, timeout: false, unexpectedStatus: false, latencyMs: 1 });
  const result = await runHomeOpenSession({
    context: { today: "2026-09-01", runId: "home-open-test", userIndex: 1 },
    sequence: 2,
    wait: async () => {},
    requestOne: async ({ entry }) => {
      calls.push(`${entry.method} ${entry.path}${entry.query ? `?${entry.query}` : ""}`);
      if (entry.path === "/steps/sync-v2") return response(202, {
        uploaderReconciliation: { state: "CURRENT" },
        raceResolution: { jobId: "job-1", generation: 1 },
      });
      if (entry.path === "/home/race-card") {
        raceCardCalls += 1;
        return response(200, raceCardCalls === 1 ? { contract: "home-shell-v1" } : {
          contract: "home-shell-v1", resolved: { presentation: true, friends: true },
          presentation: { equipped: {}, coins: 1, cape: null },
          friends: { friends: [], pending: { incoming: [], outgoing: [] } },
        });
      }
      if (entry.path.includes("race-resolution")) return response(200, { raceResolution: { state: "SUCCEEDED" } });
      if (entry.path === "/shop/catalog") return response(200, { coins: 1, equipped: {}, items: [] });
      if (entry.path === "/friends") return response(200, { friends: [], pending: { incoming: [], outgoing: [] } });
      if (entry.path === "/auth/me") return response(200, { user: { id: "user-1" } });
      if (entry.path === "/races") return response(200, { active: [], pending: [], completed: [] });
      return response(200, {});
    },
  });
  assert.equal(calls[0], "POST /steps/sync-v2");
  assert.match(calls.find((call) => call.startsWith("GET /home/race-card")), /homePersistedTotals=1/);
  assert.ok(calls.includes("GET /shop/catalog"));
  assert.ok(calls.includes("GET /friends?view=summary-v1"));
  assert.equal(calls.filter((call) => call === "GET /assets/manifest").length, 4);
  assert.ok(calls.indexOf("GET /home/suggested-races") > calls.indexOf("POST /steps/sync-v2"));
  assert.equal(result.criticalComplete, true);
  assert.equal(result.allSettled, true);
  assert.equal(result.decisions.raceCardPresentationFallback, 1);
  assert.equal(result.decisions.raceCardFriendsFallback, 1);
});

test("home-open gates use visible Home completion and retain resolution freshness as diagnostics", () => {
  const passing = {
    parameters: { arrivalRatePerSecond: 2, measurementSeconds: 600 },
    sessions: { expected: 1200, offered: 1200, started: 1200, late: 0, dropped: 0,
      criticalComplete: 1200, allSettled: 600, failed: 0,
      criticalHomeMs: { p95: 999, p99: 1999 }, averageInFlight: 2.5, peakInFlight: 4,
      inFlightCounterEvidence: { source: "session-start-completion-counters", started: 1200,
        completed: 1200, activeAtClose: 0, invalidEvents: 0 } },
    generator: { iterations: 1200, quotaRejected: 0, droppedIterations: 0, cpuPresent: true,
      memoryPresent: true, vuUtilizationPresent: true, networkErrors: 0 },
    summary: { errorRate: 0.0009 },
    endpoints: Object.fromEntries(PROFILES["home-open"].entries.map((entry) =>
      [`${entry.method} ${entry.path}`, { requests: 1,
        status: { "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 0, timeout: 0 },
        latencyMs: { p50: 100, p95: entry.path === "/steps/sync-v2" ? 749 : 900,
          p99: entry.path === "/steps/sync-v2" ? 1499 : 1200 } }])) ,
    queue: { p95LagMs: 120000, drained: false, drainSeconds: 450 },
    cleanup: { cleaned: true, baselineUnchanged: true,
      globalEventIsolation: { totalEventCount: 0, activeEventCount: 0, summaryWorkCount: 0 } },
    provenance: { k6ExitError: null },
    infrastructure: { telemetryComplete: true, processCensusStable: true,
      processMemoryWithinLimits: true, dbPoolWaitP99Ms: 49, poolCheckoutFailures: 0,
      maxEventLoopDelayMs: 10, recoveredAfterLoad: true },
  };
  assert.equal(assertHomeOpenGates(passing), true);
  assert.equal(assertHomeOpenGates({ ...passing, generator: { ...passing.generator,
    iterations: 1201, quotaRejected: 1 } }), true,
  "a duration-edge executor invocation is safe only when quota-rejected before load");
  assert.throws(() => assertHomeOpenGates({ ...passing, generator: { ...passing.generator,
    iterations: 1201, quotaRejected: 0 } }), /accounting/);
  assert.throws(() => assertHomeOpenGates({ ...passing, generator: { ...passing.generator,
    quotaRejected: Number.NaN } }), /accounting/);
  assert.equal(assertHomeOpenGates({ ...passing,
    sessions: { ...passing.sessions, allSettled: 0 },
    queue: { ...passing.queue, p95LagMs: 600_000, drained: false, drainSeconds: 900 },
  }), true, "background resolution freshness must not redefine a successful Home open");
  assert.throws(() => assertHomeOpenGates({ ...passing, sessions: { ...passing.sessions, dropped: 1 } }), /accounting/);
  assert.throws(() => assertHomeOpenGates({ ...passing, infrastructure: { ...passing.infrastructure, telemetryComplete: false } }), /telemetry/);
  assert.throws(() => assertHomeOpenGates({ ...passing, infrastructure: {
    ...passing.infrastructure, dbPoolWaitP99Ms: 50.01 } }), /infrastructure health/,
  "startup exclusion must not weaken the measured 50ms DB checkout gate");
  assert.throws(() => assertHomeOpenGates({ ...passing, sessions: { ...passing.sessions, criticalHomeMs: { p95: 1001, p99: 1500 } } }), /critical Home latency/);
  assert.throws(() => assertHomeOpenGates({ ...passing, summary: {} }), /evidence/);
  assert.throws(() => assertHomeOpenGates({ ...passing, cleanup: { cleaned: true, baselineDriftObserved: true } }), /baseline drift/);
  assert.throws(() => assertHomeOpenGates({ ...passing, cleanup: { ...passing.cleanup,
    globalEventIsolation: { activeEventCount: 1, summaryWorkCount: 0 } } }), /global-event isolation/);
  assert.throws(() => assertHomeOpenGates({ ...passing, cleanup: { ...passing.cleanup,
    globalEventIsolation: { totalEventCount: 1, activeEventCount: 0, summaryWorkCount: 0 } } }), /global-event isolation/);
  assert.throws(() => assertHomeOpenGates({ ...passing, cleanup: { ...passing.cleanup,
    globalEventIsolation: { activeEventCount: 0, summaryWorkCount: Number.NaN } } }), /global-event isolation/);
  const missingEndpoint = structuredClone(passing);
  delete missingEndpoint.endpoints["GET /auth/me"];
  assert.throws(() => assertHomeOpenGates(missingEndpoint), /endpoint evidence/);
  assert.throws(() => assertHomeOpenGates({ ...passing,
    sessions: { ...passing.sessions, averageInFlight: NaN } }), /in-flight/);
});

test("home-open resets and confirms one DB-pool measurement epoch on all four processes", async () => {
  const identities = ["http:0", "http:0", "http:1", "resolution:0", "cron:0"];
  let call = 0;
  const reset = await resetCapacityDbPoolMeasurements(
    { base_url: "http://127.0.0.1:3000" }, "smoke-g", "pool-window-g", {
      fetchImpl: async (url, options) => {
        const identity = identities[Math.min(call++, identities.length - 1)];
        const [role, instance] = identity.split(":");
        assert.equal(options.method, "POST");
        assert.equal(options.headers["X-Capacity-Run-Id"], "smoke-g");
        assert.equal(options.headers["X-Capacity-Measurement-Id"], "pool-window-g");
        if (role === "resolution") assert.equal(url, "http://127.0.0.1:3010/internal/capacity/db-pool-measurement/reset");
        if (role === "cron") assert.equal(url, "http://127.0.0.1:3011/internal/capacity/db-pool-measurement/reset");
        return { ok: true, json: async () => ({ schema: "capacity-db-pool-measurement-reset-v1",
          runId: "smoke-g", process: { role, instance, pid: 100 + Number(instance) },
          // Role process clocks need not be synchronized with the host. The
          // cron stamp is deliberately 6ms after the host's recorded start.
          measurement: { id: "pool-window-g", generation: 2,
            startedAtMs: role === "cron" ? 2006 : 1000 } }) };
      },
      wait: async () => {},
    });
  assert.equal(reset.schema, "capacity-db-pool-measurement-census-v1");
  assert.deepEqual(Object.keys(reset.processes).sort(), ["cron:0", "http:0", "http:1", "resolution:0"]);
  assert.equal(reset.measurementId, "pool-window-g");
  assert.equal(Object.hasOwn(reset.processes["cron:0"], "measurementId"), false,
    "runtime census stores the shared measurement id only at top level");

  const began = new Date(2000);
  const infrastructureSample = (second) => ({
    at: new Date(began.getTime() + second * 1000).toISOString(),
    containers: [
      { Name: "unit-backend", MemUsage: "1GiB / 8GiB", CPUPerc: "10%" },
      { Name: "unit-postgres", MemUsage: "1GiB / 2GiB", CPUPerc: "10%" },
      { Name: "unit-redis", MemUsage: "50MiB / 256MiB", CPUPerc: "10%" },
    ],
    health: Object.fromEntries(Object.entries(reset.processes).map(([identity, stamp]) => {
      const [role, instance] = identity.split(":");
      return [identity, { capacity: { runId: "smoke-g", globalEventProfile: "home-open",
        process: { role, instance, pid: stamp.pid }, memory: { rss: 1024 },
        dbPool: { waitMsP99: 1, connectionFailures: 0, waiting: 0,
          measurementId: reset.measurementId, measurementGeneration: stamp.generation,
          measurementStartedAtMs: stamp.startedAtMs,
          max: role === "http" ? 10 : role === "resolution" ? 8 : 4 },
        eventLoop: { maxMs: 1 } } }];
    })),
    resolutionQueueLagMs: 0,
  });
  const normalized = normalizeInfrastructure({ schema: "capacity-metrics-v2",
    runId: "smoke-g", profile: "home-open",
    samples: Array.from({ length: 8 }, (_, second) => infrastructureSample(second)) }, {
    runId: "smoke-g", startedAt: began, endedAt: new Date(began.getTime() + 7000),
    poolMeasurementReset: reset,
  });
  assert.equal(normalized.dbPoolWaitP99Ms, 1);
  assert.equal(normalized.processCensusStable, true);
});

test("home-open waits for the real resolution worker handoff before offering smoke traffic", async () => {
  const responses = [
    { capacity: { runId: "smoke-e", globalEventProfile: "home-open",
      process: { role: "resolution", pid: 42 }, resolutionWorker: {
        state: "startup-quiet", ready: false, quietPeriodElapsed: false,
        oldQueueDrainedObserved: false, quietPeriodMs: 60_000, remainingQuietMs: 21_000,
        effectiveConcurrency: 2,
      } } },
    { capacity: { runId: "smoke-e", globalEventProfile: "home-open",
      process: { role: "resolution", pid: 42 }, resolutionWorker: {
        state: "old-queue-handoff", ready: false, quietPeriodElapsed: true,
        oldQueueDrainedObserved: false, quietPeriodMs: 60_000, remainingQuietMs: 0,
        effectiveConcurrency: 2,
      } } },
    { capacity: { runId: "smoke-e", globalEventProfile: "home-open",
      process: { role: "resolution", pid: 42 }, resolutionWorker: {
        state: "ready", ready: true, quietPeriodElapsed: true,
        oldQueueDrainedObserved: true, quietPeriodMs: 60_000, remainingQuietMs: 0,
        effectiveConcurrency: 2,
      } } },
  ];
  let polls = 0;
  let waits = 0;
  const result = await waitForResolutionWorkerReady({ base_url: "http://127.0.0.1:3000" },
    "smoke-e", {
      fetchImpl: async (url) => {
        assert.equal(url, "http://127.0.0.1:3010/health");
        const body = responses[Math.min(polls++, responses.length - 1)];
        return { ok: true, json: async () => body };
      },
      wait: async () => { waits += 1; },
      deadlineMs: 1_000,
    });
  assert.equal(result.state, "ready");
  assert.equal(result.effectiveConcurrency, 2);
  assert.equal(result.pid, 42);
  assert.equal(polls, 3);
  assert.equal(waits, 2);
});

test("home-open rejects a live resolution worker with non-production concurrency", async () => {
  await assert.rejects(waitForResolutionWorkerReady(
    { base_url: "http://127.0.0.1:3000" }, "smoke-e", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ capacity: {
        runId: "smoke-e", globalEventProfile: "home-open",
        process: { role: "resolution", pid: 42 }, resolutionWorker: {
          state: "ready", ready: true, quietPeriodElapsed: true,
          oldQueueDrainedObserved: true, quietPeriodMs: 60_000, remainingQuietMs: 0,
          effectiveConcurrency: 1,
        },
      } }) }),
      wait: async () => {}, deadlineMs: 10,
    }), /effective concurrency 2/);
});

test("home-open preserves exact count and checksum drift evidence by integrity table", () => {
  assert.deepEqual(baselineIntegrityDiff({
    users: { count: 2, checksum: "users-before" },
    race_participants: { count: 9, checksum: "participants-before" },
  }, {
    users: { count: 2, checksum: "users-before" },
    race_participants: { count: 9, checksum: "participants-after" },
  }), [{ table: "race_participants", beforeCount: 9, afterCount: 9, countDelta: 0,
    beforeChecksum: "participants-before", afterChecksum: "participants-after" }]);
});

test("home-open waits for two stable observations of the restored resolution queue", async () => {
  const batches = [
    [{ state: "QUEUED", generation: 3, processingGeneration: 2 }],
    [{ state: "SUCCEEDED", generation: 3, processingGeneration: 3 }],
    [{ state: "SUCCEEDED", generation: 3, processingGeneration: 3 }],
  ];
  let polls = 0;
  let clock = 0;
  const result = await waitForResolutionQueueQuiescence({ raceResolutionJobV2: {
    findMany: async () => batches[Math.min(polls++, batches.length - 1)],
  } }, {
    deadlineMs: 1_000,
    pollMs: 25,
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
  });
  assert.deepEqual(result, { drained: true, stableObservations: 2, observations: 3,
    jobCount: 1 });
  assert.equal(polls, 3);

  await assert.rejects(() => waitForResolutionQueueQuiescence({ raceResolutionJobV2: {
    findMany: async () => [{ state: "FAILED", generation: 1, processingGeneration: 1 }],
  } }, { deadlineMs: 100, now: () => 0, wait: async () => {} }),
  /failed restored resolution jobs/);
});

test("resolution readiness is the worker's quiet-period and old-queue handoff state", async () => {
  const previous = process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS;
  process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
  try {
    const worker = buildRaceResolutionWorkerV2({
      prisma: { $queryRawUnsafe: async () => [] },
      appSettings: { getUncachedFlag: async () => false },
      logger: { error() {} },
    });
    assert.deepEqual(worker.startupReadiness(), {
      state: "old-queue-handoff", ready: false, quietPeriodElapsed: true,
      oldQueueDrainedObserved: false, quietPeriodMs: 0, remainingQuietMs: 0,
      effectiveConcurrency: 1,
    });
    assert.equal(await worker.readyToClaim(new Date()), true);
    assert.deepEqual(worker.startupReadiness(), {
      state: "ready", ready: true, quietPeriodElapsed: true,
      oldQueueDrainedObserved: true, quietPeriodMs: 0, remainingQuietMs: 0,
      effectiveConcurrency: 1,
    });
  } finally {
    if (previous === undefined) delete process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS;
    else process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = previous;
  }
});

test("home-open runs k6 on the host and capacity VM reserves monitoring overhead", () => {
  const source = fs.readFileSync(path.join(root, "scripts/k6/home-open.js"), "utf8");
  const orchestrator = fs.readFileSync(path.join(root, "scripts/k6-home-open.js"), "utf8");
  const capacityProcess = fs.readFileSync(path.join(root, "scripts/capacity-process.js"), "utf8");
  const startup = fs.readFileSync(path.join(root, "src/index.js"), "utf8");
  assert.match(source, /constant-arrival-rate/);
  assert.match(source, /home_open_sessions_critical_complete/);
  assert.match(source, /dropped_iterations/);
  assert.match(source, /POST[\s\S]*\/steps\/sync-v2/);
  assert.match(source, /http\.batch/);
  assert.match(source, /ALL_SETTLED_DEADLINE_MS/);
  assert.match(source, /deadlineRemainingMs/);
  assert.match(source, /boundedSessionSeconds = 16/);
  assert.match(source, /warmupSeconds \+ boundedSessionSeconds/);
  assert.match(source, /home_open_sessions_completed/);
  assert.match(source, /race_payout_flat_50/);
  assert.match(source, /summaryTrendStats:\s*\[[^\]]*"p\(99\)"/);
  assert.ok(source.indexOf("const began = intendedAt") <
    source.indexOf("http.post(`${__ENV.K6_HOME_INFLIGHT_URL}/start`"),
  "the scheduled session clock must begin before synchronous observer work");
  assert.match(orchestrator, /assertCapacityRunProfile\(state, "home-open"\)/);
  assert.match(orchestrator, /waitForResolutionWorkerReady\(config, runId/);
  assert.ok(orchestrator.indexOf("waitForResolutionWorkerReady(config, runId") <
    orchestrator.indexOf("waitForResolutionQueueQuiescence(prisma"),
  "worker readiness must precede restored-queue quiescence");
  assert.ok(orchestrator.indexOf("waitForResolutionQueueQuiescence(prisma") <
    orchestrator.indexOf("fixture = await createHomeOpenFixtures("),
  "the restored queue must be quiescent before fixture baseline capture");
  assert.ok(orchestrator.indexOf("const poolMeasurementReset = await resetCapacityDbPoolMeasurements(") <
    orchestrator.indexOf("metricsChild = spawn("),
  "pool epoch must be established before metrics and k6 start");
  assert.match(orchestrator, /src\/shared\/observability\/capacityResolutionReadiness\.js/,
    "executed readiness code must be content-bound in provenance");
  assert.match(orchestrator, /src\/modules\/loadTesting\/fixtures\.js/,
    "executed cleanup-integrity code must be content-bound in provenance");
  assert.match(orchestrator, /spawn\("k6"/);
  assert.match(orchestrator, /if \(k6Child && k6Child\.exitCode == null\) k6Child\.kill\("SIGKILL"\)/,
    "cleanup must tolerate failure before the k6 child exists");
  assert.doesNotMatch(orchestrator, /docker run[\s\S]*k6/);
  assert.doesNotMatch(orchestrator, /peakInFlight:\s*metric\([\s\S]{0,100}vus/);
  assert.match(capacityProcess, /capacityHomeOpenIsolation = role === "cron"[\s\S]*CAPACITY_GLOBAL_EVENT_PROFILE === "home-open"/);
  assert.match(startup, /if \(capacityHomeOpenIsolation\) return;[\s\S]*scheduleRaceExpiry\(\)/,
    "home isolation must stop all unrelated cron writers before ordinary scheduling");
  assert.deepEqual(capacityResourcePlan({
    vps_specs: { vcpu: 4, ram_gb: 8 },
    database_specs: { vcpu: 1, ram_gb: 2 },
  }), {
    vmCpu: 7, vmMemoryGb: 12, backendCpu: 4, backendMemoryGb: 8,
    databaseCpu: 1, databaseMemoryGb: 2, redisCpu: 1, redisMemoryMb: 256,
    overheadCpu: 1, overheadMemoryMb: 1792,
  });
});

test("live k6 progress reads REST samples from measured submetrics without fabricating percentiles", () => {
  const row = (id, sample) => ({ id, attributes: { sample } });
  const progress = progressFromMetricsRows([
    row("home_open_sessions_offered", { count: 999 }),
    row("home_open_sessions_offered{phase:measurement}", { count: 61 }),
    row("home_open_sessions_completed{phase:measurement}", { count: 60 }),
    row("home_open_sessions_failed_count{phase:measurement}", { count: 1 }),
    row("home_open_critical_ms{phase:measurement}", { "p(95)": 62.5 }),
    row("http_req_failed{phase:measurement,telemetry:sut}", { rate: 0.001 }),
  ]);
  assert.deepEqual(progress, { phase: "measurement", offered: 61, completed: 60, failed: 1,
    latencyMs: { p95: 62.5, p99: null }, errorRate: 0.001 });
  assert.equal(progressFromMetricsRows([]).offered, null);
  assert.deepEqual(progressFromMetricsRows([
    row("home_open_sessions_offered{phase:measurement}", { count: null }),
    row("home_open_sessions_completed{phase:measurement}", { count: "" }),
    row("home_open_sessions_failed_count{phase:measurement}", { count: false }),
    row("home_open_critical_ms{phase:measurement}", { "p(95)": null, "p(99)": "12" }),
    row("http_req_failed{phase:measurement,telemetry:sut}", { rate: true }),
  ]), { phase: "measurement", offered: null, completed: null, failed: null,
    latencyMs: { p95: null, p99: null }, errorRate: null });
  assert.deepEqual(progressFromMetricsRows([
    row("home_open_sessions_offered{phase:warmup}", { count: 30 }),
    row("home_open_sessions_completed{phase:warmup}", { count: 29 }),
    row("home_open_sessions_failed_count{phase:warmup}", { count: 1 }),
    row("home_open_critical_ms{phase:warmup}", { "p(95)": 70, "p(99)": 90 }),
    row("http_req_failed{phase:warmup,telemetry:sut}", { rate: 0.002 }),
  ], "warmup"), { phase: "warmup", offered: 30, completed: 29, failed: 1,
    latencyMs: { p95: 70, p99: 90 }, errorRate: 0.002 });
});

test("waitFor resolves a child that exited before listeners were attached", async () => {
  const child = new EventEmitter(); child.exitCode = 0; child.signalCode = null;
  await waitFor(child);
  child.exitCode = 7;
  await assert.rejects(waitFor(child), /exited 7/);
});

test("in-flight tracker records exact overlapping measured session starts and completions", () => {
  let now = 0; const tracker = createInFlightTracker(() => now);
  tracker.start("a", "measured"); now = 10; tracker.start("b", "measured");
  now = 20; tracker.end("a", "measured"); now = 30; tracker.end("b", "measured");
  const result = tracker.summary();
  assert.equal(result.started, 2); assert.equal(result.completed, 2);
  assert.equal(result.activeAtClose, 0); assert.equal(result.invalidEvents, 0);
  assert.equal(result.peak, 2); assert.ok(result.average > 1 && result.average < 2);
});

test("final ladder aggregation requires three boundary passes and reports the supported ceiling", () => {
  const report = (rate, mode, repeat, passed = true) => ({
    schema: "home-open-capacity-result-v1", parameters: { arrivalRatePerSecond: rate },
    provenance: { mode, repeat, runId: `${mode}-${rate}-${repeat}`, backendCommit: "commit",
      profileVersion: "2.0.0", scrubAttestationHash: "scrub", sourceTreeHash: "tree",
      snapshotHash: "snapshot", manifestHash: "manifest", liveManifestHash: "live",
      resources: { vmCpu: 7, vmMemoryGb: 12 }, actualVmResources: { cpu: 7, memoryGb: 12, diskGb: 160 } },
    gates: { passed },
    sessions: { averageInFlight: rate / 2, peakInFlight: rate,
      criticalHomeMs: { p95: rate }, allHomeMs: { p95: rate + 100 } },
    endpoints: { "GET /auth/me": { requests: 10, latencyMs: { p95: rate * 2 } } },
    infrastructure: { dbPoolWaitP99Ms: rate / 10, maxEventLoopDelayMs: rate / 5 },
  });
  const result = aggregateHomeOpenLadder([
    report(80, "level", 1), report(150, "level", 1, false),
    report(100, "boundary", 1), report(100, "boundary", 2), report(100, "boundary", 3),
  ]);
  assert.equal(result.repeatableSupportedMaximumHomeOpensPerSecond, 100);
  assert.equal(result.safeOperatingCeilingHomeOpensPerSecond, 70);
  assert.equal(result.supportedHomeOpensPerMinute, 6000);
  assert.equal(result.boundaryRepeats.length, 3);
  assert.throws(() => aggregateHomeOpenLadder([report(100, "boundary", 1)]), /three/);
  assert.throws(() => aggregateHomeOpenLadder([report(500, "level", 1)]), /three/);
  const drift = report(100, "boundary", 3); drift.provenance.sourceTreeHash = "other";
  assert.throws(() => aggregateHomeOpenLadder([
    report(100, "boundary", 1), report(100, "boundary", 2), drift]), /provenance/);
  for (const field of ["backendCommit", "profileVersion", "scrubAttestationHash"]) {
    const changed = report(100, "boundary", 3); changed.provenance[field] = "other";
    assert.throws(() => aggregateHomeOpenLadder([
      report(100, "boundary", 1), report(100, "boundary", 2), changed]), /provenance/, field);
  }
});

test("home-open reuse keeps realistic steps bounded and stable", () => {
  assert.deepEqual(homeStepPayload({ userIndex: 4999 }), homeStepPayload({ userIndex: 4999 }));
  assert.deepEqual(homeStepPayload({ userIndex: 4999, reuseIndex: 10000 }),
    homeStepPayload({ userIndex: 4999, reuseIndex: 0 }));
  const payload = homeStepPayload({ userIndex: 4999 });
  assert.ok(payload.steps >= 4000 && payload.steps <= 15999);
  assert.ok(payload.sampleSteps >= 500 && payload.sampleSteps <= payload.steps);
});

test("home-open fixture reports materialized participant bands", () => {
  const value = scaleHomeTopology({ syntheticUsers: 100,
    activeRaceCountDistribution: [{ activeRaceCount: 1, users: 100 }],
    participantBands: [{ band: "1-9", races: 1, medianParticipants: 5 },
      { band: "10-49", races: 1, medianParticipants: 20 }] });
  assert.equal(value.raceParticipantTargets.reduce((sum, count) => sum + count, 0), value.membershipCount);
  assert.ok(value.raceCount > 1, "100 memberships must not collapse into one hotspot race");
  assert.deepEqual(value.racesByParticipantBand,
    value.raceParticipantTargets.reduce((bands, size) => {
      const band = size < 10 ? "1-9" : size < 50 ? "10-49" : size < 200 ? "50-199" : "200+";
      bands[band] = (bands[band] || 0) + 1; return bands;
    }, {}));
});

test("reused Lima VM is resized and actual resources are verified", () => {
  const calls = [];
  const settings = { run_id: "unit", lima_instance: "unit-vm", repository: root,
    vps_specs: { vcpu: 4, ram_gb: 8, disk_gb: 160 }, database_specs: { vcpu: 1, ram_gb: 2 } };
  const actual = ensureVmResources(settings, {
    present: () => true,
    inspect: (() => { let calls = 0; return () => calls++ ? { cpu: 7, memoryGb: 12, diskGb: 160 } :
      { cpu: 5, memoryGb: 10, diskGb: 100 }; })(),
    execute: (command, args) => calls.push([command, args]),
  });
  assert.deepEqual(actual, { cpu: 7, memoryGb: 12, diskGb: 160 });
  assert.ok(calls.some(([, args]) => args[0] === "edit" && args.includes("--cpus=7") &&
    args.includes("--memory=12") && args.includes("--disk=160")));
});

test("infrastructure normalization fails closed and requires stable exact census over recovery window", () => {
  const at = new Date("2026-09-01T12:00:00Z");
  const sample = (offset) => ({ at: new Date(at.getTime() + offset * 1000).toISOString(),
    containers: [
      { Name: "unit-backend", MemUsage: "1GiB / 8GiB", CPUPerc: "10%" },
      { Name: "unit-postgres", MemUsage: "1GiB / 2GiB", CPUPerc: "10%" },
      { Name: "unit-redis", MemUsage: "50MiB / 256MiB", CPUPerc: "10%" },
    ], health: Object.fromEntries(["http:0", "http:1", "resolution:0", "cron:0"].map((identity, pid) => {
      const [role, instance] = identity.split(":"); return [identity, { capacity: { runId: "unit",
        globalEventProfile: "home-open", process: { role, instance, pid: pid + 100 },
        memory: { rss: 1024 }, dbPool: { waitMsP99: 1, connectionFailures: 0, waiting: 0,
          measurementId: "pool-window", measurementGeneration: 2,
          measurementStartedAtMs: at.getTime() - 1000,
          max: role === "http" ? 10 : role === "resolution" ? 8 : 4 },
        eventLoop: { maxMs: 1 } } }]; })), resolutionQueueLagMs: 0 });
  const metrics = { schema: "capacity-metrics-v2", runId: "unit", profile: "home-open",
    samples: Array.from({ length: 8 }, (_, index) => sample(index)) };
  const poolMeasurementReset = { schema: "capacity-db-pool-measurement-census-v1",
    runId: "unit", measurementId: "pool-window", processes: Object.fromEntries(
    ["http:0", "http:1", "resolution:0", "cron:0"].map((identity, pid) => [identity, {
      pid: pid + 100, generation: 2, startedAtMs: at.getTime() - 1000 }])) };
  const result = normalizeInfrastructure(metrics, { runId: "unit", startedAt: at,
    poolMeasurementReset,
    endedAt: new Date(at.getTime() + 7000), expectedContainers: ["unit-backend", "unit-postgres", "unit-redis"] });
  assert.equal(result.processCensusStable, true);
  assert.equal(result.recoveredAfterLoad, true);
  const missing = structuredClone(metrics); delete missing.samples[2].health["cron:0"].capacity.dbPool.waitMsP99;
  assert.throws(() => normalizeInfrastructure(missing, { runId: "unit", startedAt: at,
    endedAt: new Date(at.getTime() + 7000), expectedContainers: ["unit-backend", "unit-postgres", "unit-redis"] }), /missing|finite/);
  assert.throws(() => normalizeInfrastructure({ ...metrics, repeat: 2 }, { runId: "unit", repeat: 1,
    startedAt: at, endedAt: new Date(at.getTime() + 7000) }), /provenance/);
  const stalePoolWindow = structuredClone(metrics);
  stalePoolWindow.samples[3].health["http:0"].capacity.dbPool.measurementId = "process-lifetime";
  assert.throws(() => normalizeInfrastructure(stalePoolWindow, { runId: "unit", startedAt: at,
    poolMeasurementReset, endedAt: new Date(at.getTime() + 7000) }), /measurement epoch/);
});

test("execution provenance binds untracked executed files by content", () => {
  const first = executionBundleHash(root, ["scripts/k6/home-open.js", "scripts/k6-home-open.js"]);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, executionBundleHash(root, ["scripts/k6/home-open.js"]));
});

test("home-open fixture topology scales aggregate snapshot distributions without identifiers", () => {
  const value = scaleHomeTopology({
    syntheticUsers: 10,
    activeRaceCountDistribution: [{ activeRaceCount: 0, users: 20 }, { activeRaceCount: 1, users: 60 }, { activeRaceCount: 2, users: 20 }],
    participantBands: [{ band: "1-9", races: 1, medianParticipants: 5 }, { band: "10-49", races: 3, medianParticipants: 20 }],
  });
  assert.deepEqual(value.usersByActiveRaceCount, { "0": 2, "1": 6, "2": 2 });
  assert.equal(Object.values(value.usersByActiveRaceCount).reduce((a, b) => a + b, 0), 10);
  assert.ok(value.raceCount >= 1 && value.raceCount <= 100);
  assert.equal(JSON.stringify(value).includes("userId"), false);
  assert.equal(JSON.stringify(value).includes("raceId"), false);
});
