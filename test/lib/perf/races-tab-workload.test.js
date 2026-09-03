const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildRacesTabFixtureFile,
  compareRaceListCacheTarget,
  createRacesTabOpenWorkload,
  normalizeRacesTabEvidence,
  raceListCacheEvidenceFromLog,
} = require("../../../performance/workloads/races-tab-open");

function metric(values) { return { values }; }

test("Races k6 fixture is versioned, authenticated, deterministic, and identifier-free outside credentials", () => {
  const file = buildRacesTabFixtureFile({ runId: "races-run", fixture: {
    users: [{ token: "token-a", zeroFriends: true }, { token: "token-b", zeroFriends: false }],
    topology: { zeroFriendsShare: 0.5, friendDistributionSourceHash: "a".repeat(64) },
  } });
  assert.equal(file.schema, "races-tab-open-k6-fixture-v1");
  assert.equal(file.client.headerProfile, "current-races-2.3.11-ios-v1");
  assert.deepEqual(file.users, [
    { userIndex: 0, token: "token-a", zeroFriends: true },
    { userIndex: 1, token: "token-b", zeroFriends: false },
  ]);
  assert.equal(file.cohort.zeroFriendsShare, 0.5);
  assert.equal(file.cohort.friendsCacheAgeMs, 5000);
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
  } };
  const result = normalizeRacesTabEvidence({ summary, rate: 10, measurementSeconds: 60,
    fixture: { topology: { zeroFriendsShare: 0.3 } } });
  assert.equal(result.racesCoreP95Ms, 180);
  assert.equal(result.racesCoreP99Ms, 350);
  assert.equal(result.incompleteRacesCoreTransactions, 1);
  assert.equal(result.incompleteRacesDiscovery, 2);
  assert.equal(result.incompleteRacesFriends, 1);
  assert.equal(result.racesContractErrors, 3);
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
    users: Array.from({ length: 10 }, (_, index) => ({ token: `t${index}`, zeroFriends: index < 3 })),
    topology: { zeroFriendsShare: 0.3 } };
  const workload = createRacesTabOpenWorkload({
    createFixtures: async () => (calls.push("fixtures"), fixture),
    cleanupFixtures: async () => calls.push("cleanup"),
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
      } }, metrics: { targetIdentityValid: true }, resources: {}, binding: { id: "same" } };
    },
  });
  const environment = { repository: "/repo", credentialDirectory: directory,
    processEnvironment: {}, prisma: {}, binding: { id: "same" } };
  const config = { workload: { cohortSize: 10, scoreShape: "production" },
    cache: { initialPrewarmRate: 2, initialPrewarmMaxUsers: 6 },
    scan: { rates: [5], measurementSeconds: 1 },
    thresholds: { racesCoreP95Ms: 900, racesCoreP99Ms: 1800, httpErrorRate: 0.0005 } };
  const prepared = await workload.prepareFixtures({ runId: "races-run", environment, config });
  await workload.initialPrewarm({ environment, fixtures: prepared, config, seconds: 30 });
  await workload.warmup({ rate: 5, warmupSeconds: 2, measurementSeconds: 1,
    environment, fixtures: prepared, config });
  const evidence = await workload.measure({ rate: 5, measurementSeconds: 1,
    environment, fixtures: prepared, config });
  await workload.cleanup({ environment, fixtures: prepared });
  assert.deepEqual(calls, ["fixtures",
    "initial-prewarm:2:3:true:0:scripts/k6/races-tab-open.js",
    "level-warmup:5:2:false:0:scripts/k6/races-tab-open.js",
    "measurement:5:1:false:0:scripts/k6/races-tab-open.js", "cleanup"]);
  assert.equal(evidence.safeCapacityGatesPassed, false,
    "uncalibrated cache/resource baselines cannot certify a safe rate");
  assert.deepEqual(k6Inputs.at(-1).k6Variables, {
    K6_RACES_TAB_RATE: "5",
    K6_RACES_TAB_MEASUREMENT_SECONDS: "1",
    K6_RACES_TAB_CACHE_ONLY: "0",
    K6_RACES_TAB_USER_OFFSET: "0",
    K6_RACES_TAB_CORE_P95_MS: "900",
    K6_RACES_TAB_CORE_P99_MS: "1800",
    K6_RACES_TAB_HTTP_ERROR_RATE: "0.0005",
  });
});
