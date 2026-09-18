const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLimaProvider } = require("../../../performance/providers/lima");

const {
  buildRacesTabFixtureFile,
  captureExpectedProjections,
  conditionMeasurementCache,
  compareRaceListCacheTarget,
  createRacesTabOpenWorkload,
  identityPoolSize,
  measurementIdentityOffset,
  normalizeRacesTabEvidence,
  raceListCacheEvidenceFromLog,
  racesTabMismatchSamplesFromLog,
} = require("../../../performance/workloads/races-tab-open");

test("v2 identity pools use the locked deadline factor and remain disjoint", () => {
  const config = { workload: { sessionDeadlineSeconds: 31, identitySafetyFactor: 1.05 } };
  assert.equal(identityPoolSize({ rate: 5, config }), 163);
  assert.equal(identityPoolSize({ rate: 76, config }), 2474);
  assert.ok(2 * identityPoolSize({ rate: 76, config }) <= 5000);
  assert.equal(measurementIdentityOffset({ ...config, scan: { rates: [5, 30] } }), 977);
});

test("expected projections are captured once from the prepared target without IDs in content", async () => {
  const fixture = { users: [{ id: "viewer-a", token: "token-a", zeroFriends: true },
    { id: "viewer-b", token: "token-b", zeroFriends: false }] };
  const calls = [];
  await captureExpectedProjections({ fixture, baseUrl: "http://127.0.0.1:3000",
    runId: "races-run", concurrency: 2, fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      return { status: 200, json: async () => url.includes("discovery-summary")
        ? { publicRaceCount: 3 }
        : { contract: "race-list-compact-v1", active: [], pending: [], completed: [],
          tournaments: [] } };
    } });
  assert.equal(calls.length, 4);
  assert.equal(fixture.users[0].expectedProjection.discovery.publicRaceCount, 3);
  assert.equal(fixture.users[0].expectedProjection.friends.shouldRequest, true);
  assert.equal(fixture.users[1].expectedProjection.friends.shouldRequest, false);
  assert.doesNotMatch(JSON.stringify(fixture.users[0].expectedProjection), /viewer-a/);
});

test("projection capture rejects a fixture label that the HTTP response does not satisfy", async () => {
  const fixture = { users: [{ id: "viewer", token: "token", zeroFriends: false,
    coverageAugmented: false,
    expectedProjectionVersion: "races-tab-open-projection-v2",
    expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2",
      ordinary: { active: [{ team: true }] } },
    coverageVariants: ["ordinary_team_active"] }] };
  await assert.rejects(captureExpectedProjections({ fixture, baseUrl: "http://127.0.0.1",
    runId: "run", fetchImpl: async (url) => ({ status: 200, json: async () =>
      url.includes("discovery") ? { publicRaceCount: 0 } : { contract: "race-list-compact-v1",
        active: [], pending: [], completed: [], tournaments: [] } }) }),
  /labels do not match.*ordinary_team_active/i);
});

test("projection capture reports response bytes by independently observed family and row count", async () => {
  const fixture = { users: [{ id: "viewer", token: "token", zeroFriends: false,
    coverageVariants: ["ordinary_classic_active"] }] };
  await captureExpectedProjections({ fixture, baseUrl: "http://127.0.0.1", runId: "run",
    fetchImpl: async (url) => ({ status: 200, json: async () => url.includes("discovery")
      ? { publicRaceCount: 0 }
      : { contract: "race-list-compact-v1", active: [{ id: "redacted", isTeamRace: false,
        myStatus: "ACCEPTED" }], pending: [], completed: [], tournaments: [] } }) });
  assert.equal(fixture.topology.generatedCoreResponseBytes.count, 1);
  assert.equal(fixture.topology.generatedCoreResponseBytes.byCoreRowCount["1"].count, 1);
  assert.equal(fixture.topology.generatedCoreResponseBytes
    .byObservedVariant.ordinary_classic_active.count, 1);
  assert.equal(fixture.topology.generatedCoreResponseBytes.byProvenance.natural.count, 1);
  assert.equal(fixture.topology.generatedCoreResponseBytes.byProvenance.augmented.count, 0);
  assert.doesNotMatch(JSON.stringify(fixture.topology.generatedCoreResponseBytes), /redacted/);
});

test("per-attempt cache conditioning uses exact measurement identities and bounded ages", async () => {
  const users = Array.from({ length: 400 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, token: `t${index}`,
  }));
  const deleted = [];
  const requested = [];
  const sleeps = [];
  let clock = 1_000;
  const result = await conditionMeasurementCache({ rate: 5, purpose: "discovery", attempt: 2,
    environment: { baseUrl: "http://127.0.0.1", runId: "run-1" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 31, identitySafetyFactor: 1.05 },
      scan: { rates: [5] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "test",
        hot30Share: 0.34, hot15Share: 0.33, expired300Share: 0.33, maximumSeconds: 30,
      } } },
    deleteExact: async (input) => (deleted.push(input), 12),
    fetchImpl: async (url, options) => (requested.push({ url, headers: options.headers }),
      { status: 200, json: async () => ({}) }),
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    nowMillis: () => clock });
  assert.equal(deleted[0].userIds.length, 163);
  assert.equal(requested.length,
    result.cohorts.hot30Seconds + result.cohorts.hot15Seconds);
  assert.deepEqual(sleeps, [14_000, 15_000]);
  assert.equal(requested[0].headers["X-Capacity-Attempt-Id"], "discovery-2");
  assert.equal(Object.values(result.cohorts).reduce((sum, value) => sum + value, 0), 163);
  assert.equal(result.durationSeconds, 29);
  assert.equal(result.budgetExceeded, false);
});

test("cache conditioning has one wall-clock deadline across Redis, requests, and sleeps", async () => {
  const users = Array.from({ length: 400 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let clock = 0;
  await assert.rejects(conditionMeasurementCache({ rate: 5, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 31, identitySafetyFactor: 1.05 },
      scan: { rates: [5] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "test", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 30 } } },
    deleteExact: async () => { clock += 10_000; return 1; },
    fetchImpl: async () => { clock += 20_001; return { status: 200, json: async () => ({}) }; },
    sleep: async (ms) => { clock += ms; }, nowMillis: () => clock,
  }), (error) => error.cacheConditioning?.budgetExceeded === true &&
    error.cacheConditioning.durationSeconds > 30);
});

test("cache conditioning waits for every started HTTP operation to settle before failing", async () => {
  const users = Array.from({ length: 4 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let calls = 0;
  let slowSettled = false;
  await assert.rejects(conditionMeasurementCache({ rate: 2, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 1, identitySafetyFactor: 1 },
      scan: { rates: [2] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "test", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 30 } } },
    deleteExact: async () => 1,
    fetchImpl: async () => { calls += 1; if (calls === 1) throw new Error("first failed");
      await new Promise((resolve) => setTimeout(resolve, 20)); slowSettled = true;
      return { status: 200, json: async () => ({}) }; },
    sleep: async () => {}, nowMillis: () => 0,
  }), /first failed/);
  assert.equal(slowSettled, true);
});

test("Redis deletion consumes the same conditioning deadline before HTTP begins", async () => {
  const users = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let clock = 0;
  let requests = 0;
  await assert.rejects(conditionMeasurementCache({ rate: 1, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 1, identitySafetyFactor: 1 },
      scan: { rates: [1] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "test", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 30 } } },
    deleteExact: async () => { clock = 30_001; return 1; },
    fetchImpl: async () => { requests += 1; return { status: 200, json: async () => ({}) }; },
    sleep: async () => {}, nowMillis: () => clock,
  }), (error) => error.cacheConditioning?.budgetExceeded === true);
  assert.equal(requests, 0);
});

test("cache conditioning validates its deadline policy before deleting owned keys", async () => {
  const users = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let deleteCalls = 0;
  await assert.rejects(conditionMeasurementCache({ rate: 1, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 1, identitySafetyFactor: 1 },
      scan: { rates: [1] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "bad", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 31 } } },
    deleteExact: async () => { deleteCalls += 1; return 1; },
  }), /invalid bounded/i);
  assert.equal(deleteCalls, 0);
});

test("cache conditioning actively aborts Redis deletion at the shared deadline and settles it", async () => {
  const users = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let settled = false;
  let received = null;
  const started = Date.now();
  await assert.rejects(conditionMeasurementCache({ rate: 1, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 1, identitySafetyFactor: 1 },
      scan: { rates: [1] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "deadline", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 0.02 } } },
    deleteExact: async (options) => {
      received = options;
      await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
        settled = true; reject(options.signal.reason);
      }, { once: true }));
    },
  }), (error) => error.cacheConditioning?.budgetExceeded === true);
  assert.equal(received.signal.aborted, true);
  assert.ok(received.timeoutMs <= 20);
  assert.equal(settled, true);
  assert.ok(Date.now() - started < 500);
});

test("cache conditioning uses a deadline-aware cancellable sleep and awaits settlement", async () => {
  const users = Array.from({ length: 2 }, (_, index) => ({ id: `u${index}`, token: `t${index}` }));
  let sleepSettled = false;
  const started = Date.now();
  await assert.rejects(conditionMeasurementCache({ rate: 1, purpose: "discovery", attempt: 1,
    environment: { baseUrl: "http://127.0.0.1", runId: "run" }, fixtures: { users },
    config: { workload: { sessionDeadlineSeconds: 1, identitySafetyFactor: 1 },
      scan: { rates: [1] }, cache: { racesTabConditioning: {
        schema: "races-tab-cache-conditioning-v1", profile: "deadline", hot30Share: 1,
        hot15Share: 0, expired300Share: 0, maximumSeconds: 0.02 } } },
    deleteExact: async () => 1,
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
    sleep: async (_ms, { signal }) => new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => { sleepSettled = true; reject(signal.reason); },
        { once: true })),
  }), (error) => error.cacheConditioning?.budgetExceeded === true);
  assert.equal(sleepSettled, true);
  assert.ok(Date.now() - started < 500);
});

function metric(values) { return { values }; }

test("Races k6 fixture is versioned, authenticated, deterministic, and identifier-free outside credentials", () => {
  const file = buildRacesTabFixtureFile({ runId: "races-run", fixture: {
    users: [{ id: "viewer-a", token: "token-a", zeroFriends: true,
      expectedProjectionVersion: "races-tab-open-projection-v2",
      expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2", marker: "a" },
      coverageVariants: ["ordinary_classic_active"] },
    { id: "viewer-b", token: "token-b", zeroFriends: false,
      expectedProjectionVersion: "races-tab-open-projection-v2",
      expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2", marker: "b" },
      coverageVariants: ["tournament_lobby"] }],
    topology: { zeroFriendsShare: 0.5, friendDistributionSourceHash: "a".repeat(64) },
  } });
  assert.equal(file.schema, "races-tab-open-k6-fixture-v2");
  assert.equal(file.client.headerProfile, "current-races-2.3.11-ios-v1");
  assert.deepEqual(file.users, [
    { userIndex: 0, viewerUserId: "viewer-a", token: "token-a", zeroFriends: true,
      expectedProjectionVersion: "races-tab-open-projection-v2",
      expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2", marker: "a" }, coverageVariants: ["ordinary_classic_active"] },
    { userIndex: 1, viewerUserId: "viewer-b", token: "token-b", zeroFriends: false,
      expectedProjectionVersion: "races-tab-open-projection-v2",
      expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2", marker: "b" }, coverageVariants: ["tournament_lobby"] },
  ]);
  assert.equal(file.cohort.zeroFriendsShare, 0.5);
  assert.equal(file.cohort.friendsCacheAgeMs, 5000);
  assert.throws(() => buildRacesTabFixtureFile({ runId: "bad", fixture: {
    users: [{ id: "viewer", token: "token", expectedProjection: null }], topology: {},
  } }), /expected projection/i);
});

test("oversized fixture output fails before k6 and cleans the owned graph", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "races-size-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let cleaned = false;
  let cacheCleanup = null;
  const fixture = { manifest: { ids: {} }, topology: {}, users: [{ id: "viewer",
    token: "token", zeroFriends: false,
    expectedProjectionVersion: "races-tab-open-projection-v2",
    expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2",
      padding: "x".repeat(100) }, coverageVariants: [] }] };
  const workload = createRacesTabOpenWorkload({ createFixtures: async () => fixture,
    captureExpectedProjections: async () => {},
    conditionMeasurementCache: async () => ({ schema: "races-tab-cache-conditioning-v1" }),
    cleanupFixtures: async () => { cleaned = true; } });
  const provider = createLimaProvider({ adapter: {
    deleteExactRaceListCache: async (options) => { cacheCleanup = options; },
  } });
  await assert.rejects(workload.prepareFixtures({ runId: "races-size", environment: {
    prisma: {}, baseUrl: "http://127.0.0.1", credentialDirectory: directory,
    processEnvironment: {}, deleteExactRaceListCache: (options) =>
      provider.deleteExactRaceListCache(options) },
  config: { workload: { maximumFixtureBytes: 10 },
    scan: { rates: [1] } } }), /exceeds 10 bytes/);
  assert.equal(cleaned, true);
  assert.ok(Number.isFinite(cacheCleanup.deadlineMillis));
  assert.ok(cacheCleanup.timeoutMs > 0 && cacheCleanup.timeoutMs <= 30_000);
  assert.equal(cacheCleanup.signal.aborted, false);
});

test("workload cleanup settles Redis, graph, and credential-file cleanup", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "races-cleanup-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixturePath = path.join(directory, "fixture.json");
  fs.writeFileSync(fixturePath, "{}\n");
  const calls = [];
  let cacheCleanup = null;
  const workload = createRacesTabOpenWorkload({ cleanupFixtures: async () => {
    calls.push("graph"); throw new Error("graph cleanup failed");
  } });
  const provider = createLimaProvider({ adapter: {
    deleteExactRaceListCache: async (options) => { cacheCleanup = options;
      calls.push("redis"); throw new Error("redis cleanup failed"); },
  } });
  await assert.rejects(workload.cleanup({ environment: {
    deleteExactRaceListCache: (options) => provider.deleteExactRaceListCache(options),
    prisma: {},
  }, fixtures: { fixturePath, users: [{ id: "u" }], manifest: {} } }),
  (error) => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(calls, ["redis", "graph"]);
  assert.ok(Number.isFinite(cacheCleanup.deadlineMillis));
  assert.ok(cacheCleanup.timeoutMs > 0 && cacheCleanup.timeoutMs <= 30_000);
  assert.equal(cacheCleanup.signal.aborted, false);
  assert.equal(fs.existsSync(fixturePath), false);
});

test("Races summary normalizes core, background, endpoint, scheduler, and deadline evidence", () => {
  const summary = { metrics: {
    "races_tab_sessions_started{phase:measurement}": metric({ count: 600 }),
    "races_tab_sessions_offered{phase:measurement}": metric({ count: 600 }),
    "races_tab_sessions_core_refresh_complete{phase:measurement}": metric({ count: 599 }),
    "races_tab_sessions_completed{phase:measurement}": metric({ count: 600 }),
    "races_tab_core_refresh_ms{phase:measurement}": metric({ med: 80, "p(95)": 180, "p(99)": 350 }),
    "races_tab_discovery_started{phase:measurement}": metric({ count: 600 }),
    "races_tab_discovery_completed{phase:measurement}": metric({ count: 598 }),
    "races_tab_discovery_errors{phase:measurement}": metric({ count: 2 }),
    "races_tab_discovery_ms{phase:measurement}": metric({ "p(95)": 190, "p(99)": 400 }),
    "http_req_duration{endpoint:discovery-summary,phase:measurement,telemetry:sut}":
      metric({ "p(95)": 91, "p(99)": 141 }),
    "races_tab_friends_started{phase:measurement}": metric({ count: 180 }),
    "races_tab_friends_completed{phase:measurement}": metric({ count: 179 }),
    "races_tab_friends_errors{phase:measurement}": metric({ count: 1 }),
    "races_tab_friends_ms{phase:measurement}": metric({ "p(95)": 90, "p(99)": 160 }),
    "http_req_duration{endpoint:friends-summary,phase:measurement,telemetry:sut}":
      metric({ "p(95)": 42, "p(99)": 72 }),
    "races_tab_network_errors{phase:measurement}": metric({ count: 0 }),
    "races_tab_contract_errors{phase:measurement}": metric({ count: 3 }),
    "races_tab_payload_content_mismatches{phase:measurement}": metric({ count: 2 }),
    "races_tab_payload_mismatch_reasons{phase:measurement,reason:ordinary_field}":
      metric({ count: 2 }),
    "races_tab_iteration_deadline_timeouts{phase:measurement}": metric({ count: 0 }),
    "races_tab_scheduler_lag_ms{phase:measurement}": metric({ "p(95)": 2, "p(99)": 4, max: 8 }),
    "http_req_failed{phase:measurement,telemetry:sut}": metric({ rate: 0.0005 }),
    "dropped_iterations{phase:measurement}": metric({ count: 0 }),
    "http_reqs{endpoint:compact-races,phase:measurement,telemetry:sut}": metric({ count: 600, rate: 10 }),
    "http_reqs{endpoint:discovery-summary,phase:measurement,telemetry:sut}": metric({ count: 600, rate: 10 }),
    "http_reqs{endpoint:friends-summary,phase:measurement,telemetry:sut}": metric({ count: 180, rate: 3 }),
    "races_tab_endpoint_response_bytes{endpoint:compact-races,phase:measurement}": metric({ avg: 1200, "p(95)": 1800 }),
    "races_tab_endpoint_response_bytes{endpoint:discovery-summary,phase:measurement}": metric({ avg: 300, "p(95)": 500 }),
    "races_tab_endpoint_response_bytes{endpoint:friends-summary,phase:measurement}": metric({ avg: 200, "p(95)": 350 }),
    "races_tab_content_rows{family:favorites,phase:measurement,state:classic}": metric({ count: 17 }),
    "races_tab_content_rows{family:teams,phase:measurement,state:size_4}": metric({ count: 9 }),
    "races_tab_content_rows{family:placement,phase:measurement,state:privacy}": metric({ count: 3 }),
    "races_tab_content_rows{family:ordinary_inventory,phase:measurement,state:held}": metric({ count: 11 }),
    "races_tab_content_rows{family:ordinary_effect,phase:measurement,state:negative}": metric({ count: 4 }),
    "races_tab_content_rows{family:match_inventory,phase:measurement,state:queued}": metric({ count: 2 }),
  } };
  const result = normalizeRacesTabEvidence({ summary, rate: 10, measurementSeconds: 60,
    fixture: { topology: { zeroFriendsShare: 0.3 } } });
  assert.equal(result.racesCoreP95Ms, 180);
  assert.equal(result.racesCoreP99Ms, 350);
  assert.equal(result.incompleteRacesCoreTransactions, 1);
  assert.equal(result.incompleteRacesDiscovery, 2);
  assert.equal(result.incompleteRacesFriends, 1);
  assert.equal(result.racesContractErrors, 3);
  assert.equal(result.racesPayloadContentMismatches, 2);
  assert.equal(result.racesTabOpen.content.mismatchCounts.ordinary_field, 2);
  assert.equal(result.fixtureStateCoverageMissing, 28);
  assert.equal(result.racesTabOpen.fixtureZeroFriendsShare, 0.3);
  assert.equal(result.racesTabOpen.fixtureFriendsCacheAgeMs, 5000);
  assert.equal(result.racesTabOpen.requestCountsByEndpoint["GET /friends"], 180);
  assert.equal(result.racesTabOpen.friends.expected, 180);
  assert.equal(result.racesTabOpen.friends.selectionQuotaDrift, 0);
  assert.equal(result.racesTabOpen.observedEndpointRps["GET /friends"], 3);
  assert.equal(result.racesTabOpen.scheduler.quotaDrift, 0);
  assert.equal(result.racesTabOpen.coreResponseBytes.p95, 1800);
  assert.deepEqual(result.racesTabOpen.discovery.latencyMs, { p95: 91, p99: 141 });
  assert.deepEqual(result.racesTabOpen.friends.latencyMs, { p95: 42, p99: 72 });
  assert.equal(result.racesTabOpen.content.totals.favorites.classic, 17);
  assert.equal(result.racesTabOpen.content.totals.teams.size_4, 9);
  assert.equal(result.racesTabOpen.content.totals.placement.privacy, 3);
  assert.equal(result.racesTabOpen.content.totals.ordinary_inventory.held, 11);
  assert.equal(result.racesTabOpen.content.totals.ordinary_effect.negative, 4);
  assert.equal(result.racesTabOpen.content.totals.match_inventory.queued, 2);
  assert.equal(Object.hasOwn(result.racesTabOpen, "fixtureCohort"), false);
});

test("cache evidence is grouped without user identifiers", () => {
  const log = [
    '2026-09-03T00:00:00Z {"event":"race_list_cache_v1","source":"redis","outcome":"hit","fragment":"membership"}',
    '2026-09-03T00:00:00Z {"event":"race_list_cache_v1","source":"redis","outcome":"hit","fragment":"completed"}',
    '2026-09-03T00:00:00Z {"event":"race_list_cache_v1","source":"redis","outcome":"hit","fragment":"pending"}',
    '2026-09-03T00:00:00Z {"event":"race_list_cache_v1","source":"redis","outcome":"write","fragment":"membership"}',
    '2026-09-03T00:00:01Z {"event":"race_list_cache_v1","source":"postgres","outcome":"miss","fragment":"all"}',
    '2026-09-03T00:00:02Z {"event":"race_list_cache_v1","source":"postgres","outcome":"bounded","fragment":"all"}',
    'ignore me',
  ].join("\n");
  assert.deepEqual(raceListCacheEvidenceFromLog(log), {
    schema: "races-tab-race-list-cache-evidence-v1",
    eventCount: 3,
    sources: { redis: 1, postgres: 2 },
    outcomes: { hit: 1, miss: 1, bounded: 1 },
  });
});

test("cache evidence accepts only the current measurement attempt", () => {
  const current = { runId: "run-1", attemptId: "discovery-1", phase: "measurement" };
  const log = [
    JSON.stringify({ event: "race_list_cache_v1", source: "redis", outcome: "hit",
      fragment: "membership", ...current }),
    JSON.stringify({ event: "race_list_cache_v1", source: "postgres", outcome: "bounded",
      fragment: "all", ...current, attemptId: "older-1" }),
    JSON.stringify({ event: "race_list_cache_v1", source: "postgres", outcome: "bounded",
      fragment: "all", ...current, phase: "cache-conditioning" }),
  ].join("\n");
  const evidence = raceListCacheEvidenceFromLog(log, current);
  assert.equal(evidence.eventCount, 1);
  assert.deepEqual(evidence.sources, { redis: 1 });
});

test("mismatch samples are redacted, deduplicated, and capped accurately", () => {
  const rows = Array.from({ length: 55 }, (_, fixtureIndex) => JSON.stringify({
    event: "races_tab_projection_mismatch_sample_v1", fixtureIndex,
    path: `ordinary.active.${fixtureIndex}.name`, reason: "ordinary_field",
    expectedType: "string", observedType: "null", userId: "must-not-survive",
  }));
  rows.push(rows[0], JSON.stringify({ event: "races_tab_projection_mismatch_sample_v1",
    fixtureIndex: 56, path: "x", reason: "not-an-enum", expectedType: "string",
    observedType: "string" }));
  const result = racesTabMismatchSamplesFromLog(rows.join("\n"));
  assert.equal(result.samples.length, 50);
  assert.equal(result.observedSampleCount, 55);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes("must-not-survive"), false);
});

test("versioned cache targets compare observed source/outcome shares with tolerance", () => {
  const evidence = { eventCount: 10, sources: { redis: 8, postgres: 2 },
    outcomes: { hit: 8, miss: 2 } };
  assert.deepEqual(compareRaceListCacheTarget(evidence, {
    schema: "race-list-cache-target-v1", minimumEvents: 10, tolerance: 0.05,
    sources: { redis: 0.8, postgres: 0.2 }, outcomes: { hit: 0.8, miss: 0.2 },
  }), {
    targetSchema: "race-list-cache-target-v1", minimumEvents: 10, tolerance: 0.05,
    observedSourceShares: { redis: 0.8, postgres: 0.2 },
    observedOutcomeShares: { hit: 0.8, miss: 0.2 }, matchesTarget: true,
  });
  assert.equal(compareRaceListCacheTarget(evidence, {
    schema: "race-list-cache-target-v1", minimumEvents: 11, tolerance: 0.05,
    sources: { redis: 0.8 },
  }).matchesTarget, false);
});

test("missing required endpoint submetrics fail reconciliation instead of using session fallbacks", () => {
  const summary = { metrics: {
    "races_tab_sessions_started{phase:measurement}": metric({ count: 1 }),
    "races_tab_sessions_offered{phase:measurement}": metric({ count: 1 }),
    "races_tab_sessions_core_refresh_complete{phase:measurement}": metric({ count: 1 }),
    "races_tab_sessions_completed{phase:measurement}": metric({ count: 1 }),
    "races_tab_discovery_started{phase:measurement}": metric({ count: 1 }),
    "races_tab_discovery_completed{phase:measurement}": metric({ count: 1 }),
    "races_tab_friends_started{phase:measurement}": metric({ count: 0 }),
    "races_tab_friends_completed{phase:measurement}": metric({ count: 0 }),
  } };
  const result = normalizeRacesTabEvidence({ summary, rate: 1, measurementSeconds: 1,
    fixture: { users: [{ zeroFriends: false }], topology: { zeroFriendsShare: 0 } } });
  assert.ok(result.racesContractErrors >= 2);
  assert.equal(Number.isNaN(result.racesTabOpen.requestCountsByEndpoint["GET /races"]), true);
});

test("workload prepares once, prewarms only core, and uses separate bounded k6 epochs", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "races-workload-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const k6Inputs = [];
  const fixture = { manifest: { ids: { friendships: [] } }, races: [],
    users: Array.from({ length: 10 }, (_, index) => ({ token: `t${index}`, zeroFriends: index < 3,
      expectedProjectionVersion: "races-tab-open-projection-v2",
      expectedProjection: { expectedProjectionVersion: "races-tab-open-projection-v2" } })),
    topology: { zeroFriendsShare: 0.3 } };
  const workload = createRacesTabOpenWorkload({
    createFixtures: async () => (calls.push("fixtures"), fixture),
    captureExpectedProjections: async () => calls.push("capture"),
    cleanupFixtures: async () => calls.push("cleanup"),
    conditionMeasurementCache: async () => ({ schema: "races-tab-cache-conditioning-v1" }),
    runK6: async (input) => {
      k6Inputs.push(input);
      calls.push(`${input.phase}:${input.rate}:${input.measurementSeconds}:${input.cacheOnly}:${input.userOffset}:${input.scriptPath}`);
      return { summary: { metrics: {
        "races_tab_sessions_started{phase:measurement}": metric({ count: 5 }),
        "races_tab_sessions_offered{phase:measurement}": metric({ count: 5 }),
        "races_tab_sessions_core_refresh_complete{phase:measurement}": metric({ count: 5 }),
        "races_tab_sessions_completed{phase:measurement}": metric({ count: 5 }),
        "races_tab_core_refresh_ms{phase:measurement}": metric({ med: 10, "p(95)": 20, "p(99)": 30 }),
        "races_tab_discovery_started{phase:measurement}": metric({ count: 5 }),
        "races_tab_discovery_completed{phase:measurement}": metric({ count: 5 }),
        "races_tab_discovery_errors{phase:measurement}": metric({ count: 0 }),
        "races_tab_discovery_ms{phase:measurement}": metric({ "p(95)": 20, "p(99)": 30 }),
        "races_tab_friends_started{phase:measurement}": metric({ count: 2 }),
        "races_tab_friends_completed{phase:measurement}": metric({ count: 2 }),
        "races_tab_friends_errors{phase:measurement}": metric({ count: 0 }),
        "races_tab_friends_ms{phase:measurement}": metric({ "p(95)": 20, "p(99)": 30 }),
        "races_tab_network_errors{phase:measurement}": metric({ count: 0 }),
        "races_tab_contract_errors{phase:measurement}": metric({ count: 0 }),
        "races_tab_iteration_deadline_timeouts{phase:measurement}": metric({ count: 0 }),
        "races_tab_scheduler_lag_ms{phase:measurement}": metric({ "p(95)": 1, "p(99)": 1, max: 1 }),
        "http_req_failed{phase:measurement,telemetry:sut}": metric({ rate: 0 }),
        "dropped_iterations{phase:measurement}": metric({ count: 0 }),
      } }, metrics: { targetIdentityValid: true }, resources: { generatorCpuPercent: 10 },
      binding: { id: "same" } };
    },
  });
  const environment = { repository: "/repo", credentialDirectory: directory,
    processEnvironment: {}, prisma: {}, binding: { id: "same" } };
  const config = { cache: { initialPrewarmRate: 2, initialPrewarmMaxUsers: 6 },
    scan: { rates: [5], measurementSeconds: 1 },
    thresholds: { racesCoreP95Ms: 900, racesCoreP99Ms: 1800, httpErrorRate: 0.0005 },
    workload: { cohortSize: 10, scoreShape: "production", generatorCpuPercent: 85,
      generatorSchedulerLagP99Ms: 1000, sessionDeadlineSeconds: 31,
      identitySafetyFactor: 1.05 } };
  const prepared = await workload.prepareFixtures({ runId: "races-run", environment, config });
  await workload.initialPrewarm({ environment, fixtures: prepared, config, seconds: 30 });
  await workload.warmup({ rate: 5, warmupSeconds: 2, measurementSeconds: 1,
    environment, fixtures: prepared, config });
  const evidence = await workload.measure({ rate: 5, measurementSeconds: 1,
    environment, fixtures: prepared, config });
  await workload.cleanup({ environment, fixtures: prepared });
  assert.deepEqual(calls, ["fixtures", "capture",
    "initial-prewarm:2:3:true:163:scripts/k6/races-tab-open.js",
    "level-warmup:5:2:false:0:scripts/k6/races-tab-open.js",
    "measurement:5:1:false:163:scripts/k6/races-tab-open.js", "cleanup"]);
  assert.equal(evidence.safeCapacityGatesPassed, false,
    "uncalibrated cache/resource baselines cannot certify a safe rate");
  assert.deepEqual(k6Inputs.at(-1).k6Variables, {
    K6_RACES_TAB_RATE: "5",
    K6_RACES_TAB_MEASUREMENT_SECONDS: "1",
    K6_RACES_TAB_CACHE_ONLY: "0",
    K6_RACES_TAB_USER_OFFSET: "163",
    K6_RACES_TAB_IDENTITY_POOL_SIZE: "163",
    K6_RACES_TAB_ATTEMPT_ID: "measurement-1",
    K6_RACES_TAB_PHASE: "measurement",
    K6_RACES_TAB_CORE_P95_MS: "900",
    K6_RACES_TAB_CORE_P99_MS: "1800",
    K6_RACES_TAB_HTTP_ERROR_RATE: "0.0005",
  });
});
