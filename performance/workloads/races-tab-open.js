const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PROFILES } = require("../../src/modules/loadTesting/contract");
const {
  cleanupRacesTabOpenFixtures,
  createRacesTabOpenFixtures,
  verifyRacesTabOpenFixtures,
} = require("../../src/modules/loadTesting/racesTabOpenFixtures");
const { runRawK6 } = require("./home-open");

function metric(summary, name, key, tags = {}, fallback = Number.NaN) {
  const rows = Object.entries(summary?.metrics || {}).filter(([metricName]) => {
    if (metricName === name && Object.keys(tags).length === 0) return true;
    if (!metricName.startsWith(`${name}{`) || !metricName.endsWith("}")) return false;
    const actual = new Set(metricName.slice(name.length + 1, -1).split(","));
    return Object.entries(tags).every(([tag, value]) => actual.has(`${tag}:${value}`));
  });
  const value = rows[0]?.[1]?.values?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function buildRacesTabFixtureFile({ runId, fixture } = {}) {
  return {
    schema: "races-tab-open-k6-fixture-v1",
    runId,
    client: {
      appVersion: "2.3.11",
      timezone: "America/New_York",
      releaseChannel: "prod",
      platform: "ios",
      headerProfile: PROFILES["races-tab-open"].racesTabOpen.clientHeaderProfile,
      features: PROFILES["races-tab-open"].racesTabOpen.clientFeatures,
    },
    cohort: {
      zeroFriendsShare: fixture.topology.zeroFriendsShare,
      friendDistributionSourceHash: fixture.topology.friendDistributionSourceHash,
      friendsCacheAgeMs: PROFILES["races-tab-open"].racesTabOpen.friendsCacheAgeMs,
    },
    users: fixture.users.map((user, userIndex) => ({
      userIndex,
      token: user.token,
      zeroFriends: user.zeroFriends === true,
    })),
  };
}

function endpointMetric(summary, endpoint, key, fallback) {
  return metric(summary, "http_reqs", key, {
    endpoint, phase: "measurement", telemetry: "sut",
  }, fallback);
}

function normalizeRacesTabEvidence({ summary, rate, measurementSeconds, fixture,
  cacheEvidence = null } = {}) {
  const phase = { phase: "measurement" };
  const started = metric(summary, "races_tab_sessions_started", "count", phase, 0);
  const offered = metric(summary, "races_tab_sessions_offered", "count", phase, started);
  const coreComplete = metric(summary, "races_tab_sessions_core_refresh_complete", "count", phase, 0);
  const sessionsCompleted = metric(summary, "races_tab_sessions_completed", "count", phase, 0);
  const discoveryStartedCount = metric(summary, "races_tab_discovery_started", "count", phase, 0);
  const discoveryCompletedCount = metric(summary, "races_tab_discovery_completed", "count", phase, 0);
  const discoveryErrorCount = metric(summary, "races_tab_discovery_errors", "count", phase, 0);
  const friendsStartedCount = metric(summary, "races_tab_friends_started", "count", phase, 0);
  const friendsCompletedCount = metric(summary, "races_tab_friends_completed", "count", phase, 0);
  const friendsErrorCount = metric(summary, "races_tab_friends_errors", "count", phase, 0);
  const expected = Number(rate) * Number(measurementSeconds);
  const expectedFriends = Array.isArray(fixture?.users) && fixture.users.length
    ? Array.from({ length: expected }, (_, index) =>
      fixture.users[index % fixture.users.length]?.zeroFriends === true).filter(Boolean).length
    : Math.round(expected * Number(fixture?.topology?.zeroFriendsShare || 0));
  const endpointCounts = {
    "GET /races": endpointMetric(summary, "compact-races", "count", Number.NaN),
    "GET /races/discovery-summary": endpointMetric(summary, "discovery-summary", "count",
      Number.NaN),
    "GET /friends": endpointMetric(summary, "friends-summary", "count",
      expectedFriends === 0 ? 0 : Number.NaN),
  };
  const endpointRps = Object.fromEntries(Object.entries(endpointCounts)
    .map(([name, count]) => [name, count / Math.max(1, Number(measurementSeconds))]));
  const requestLatency = (endpoint, key) => metric(summary, "http_req_duration", key,
    { ...phase, endpoint, telemetry: "sut" });
  const friendsLatency = (key) => friendsStartedCount === 0 ? 0 :
    requestLatency("friends-summary", key);
  const endpointReconciliationErrors = [
    endpointCounts["GET /races"] - started,
    endpointCounts["GET /races/discovery-summary"] - discoveryStartedCount,
    endpointCounts["GET /friends"] - friendsStartedCount,
    friendsStartedCount - expectedFriends,
  ].reduce((sum, value) => sum + (Number.isFinite(value) ? Math.abs(value) : 1), 0);
  const racesTabOpen = {
    started,
    offered,
    coreRefreshComplete: coreComplete,
    sessionsCompleted,
    coreLatencyMs: {
      p50: metric(summary, "races_tab_core_refresh_ms", "med", phase),
      p95: metric(summary, "races_tab_core_refresh_ms", "p(95)", phase),
      p99: metric(summary, "races_tab_core_refresh_ms", "p(99)", phase),
    },
    coreResponseBytes: {
      average: metric(summary, "races_tab_endpoint_response_bytes", "avg",
        { ...phase, endpoint: "compact-races" }),
      p95: metric(summary, "races_tab_endpoint_response_bytes", "p(95)",
        { ...phase, endpoint: "compact-races" }),
    },
    discovery: {
      started: discoveryStartedCount,
      completed: discoveryCompletedCount,
      errors: discoveryErrorCount,
      latencyMs: {
        p95: requestLatency("discovery-summary", "p(95)"),
        p99: requestLatency("discovery-summary", "p(99)"),
      },
      responseBytes: {
        average: metric(summary, "races_tab_endpoint_response_bytes", "avg",
          { ...phase, endpoint: "discovery-summary" }),
        p95: metric(summary, "races_tab_endpoint_response_bytes", "p(95)",
          { ...phase, endpoint: "discovery-summary" }),
      },
    },
    friends: {
      expected: expectedFriends,
      started: friendsStartedCount,
      completed: friendsCompletedCount,
      errors: friendsErrorCount,
      selectionQuotaDrift: friendsStartedCount - expectedFriends,
      latencyMs: { p95: friendsLatency("p(95)"), p99: friendsLatency("p(99)") },
      responseBytes: friendsStartedCount === 0 ? { average: 0, p95: 0 } : {
        average: metric(summary, "races_tab_endpoint_response_bytes", "avg",
          { ...phase, endpoint: "friends-summary" }),
        p95: metric(summary, "races_tab_endpoint_response_bytes", "p(95)",
          { ...phase, endpoint: "friends-summary" }),
      },
    },
    fixtureZeroFriendsShare: Number(fixture?.topology?.zeroFriendsShare || 0),
    fixtureFriendsCacheAgeMs: PROFILES["races-tab-open"].racesTabOpen.friendsCacheAgeMs,
    requestCountsByEndpoint: endpointCounts,
    observedEndpointRps: endpointRps,
    scheduler: {
      lagMs: {
        p95: metric(summary, "races_tab_scheduler_lag_ms", "p(95)", phase),
        p99: metric(summary, "races_tab_scheduler_lag_ms", "p(99)", phase),
        max: metric(summary, "races_tab_scheduler_lag_ms", "max", phase),
      },
      expectedSessions: expected,
      offeredQuotaDrift: offered - expected,
      quotaDrift: started - expected,
      completionQuotaDrift: sessionsCompleted - expected,
    },
    incompleteBackground: Math.max(0, discoveryStartedCount - discoveryCompletedCount) +
      Math.max(0, friendsStartedCount - friendsCompletedCount),
    iterationDeadlineTimeouts: metric(summary,
      "races_tab_iteration_deadline_timeouts", "count", phase, 0),
    cacheSourceMix: cacheEvidence || {
      schema: "races-tab-race-list-cache-evidence-v1", eventCount: 0,
      sources: {}, outcomes: {}, unavailableReason: "no-cache-source-events-observed",
    },
    fixtureCohort: fixture?.topology || null,
  };
  return {
    racesCoreP50Ms: racesTabOpen.coreLatencyMs.p50,
    racesCoreP95Ms: racesTabOpen.coreLatencyMs.p95,
    racesCoreP99Ms: racesTabOpen.coreLatencyMs.p99,
    httpErrorRate: metric(summary, "http_req_failed", "rate",
      { phase: "measurement", telemetry: "sut" }),
    networkErrors: metric(summary, "races_tab_network_errors", "count", phase, 0),
    incompleteRacesCoreTransactions: Math.max(0, started - coreComplete),
    incompleteRacesDiscovery: Math.max(0, discoveryStartedCount - discoveryCompletedCount),
    incompleteRacesFriends: Math.max(0, friendsStartedCount - friendsCompletedCount),
    racesContractErrors: metric(summary, "races_tab_contract_errors", "count", phase, 0) +
      endpointReconciliationErrors,
    droppedArrivals: Math.max(
      metric(summary, "dropped_iterations", "count", phase, 0),
      Math.max(0, expected - started),
    ),
    racesTabOpen,
  };
}

function raceListCacheEvidenceFromLog(log = "") {
  const result = {
    schema: "races-tab-race-list-cache-evidence-v1",
    eventCount: 0,
    sources: {},
    outcomes: {},
  };
  for (const line of String(log).split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    let row;
    try { row = JSON.parse(line.slice(start)); } catch { continue; }
    if (row?.event !== "race_list_cache_v1") continue;
    if (row.outcome === "hit" && row.fragment !== "membership") continue;
    if (["write", "write_error", "invalidated", "invalidate_error"].includes(row.outcome)) continue;
    result.eventCount += 1;
    const source = String(row.source || "other");
    const outcome = String(row.outcome || "other");
    result.sources[source] = (result.sources[source] || 0) + 1;
    result.outcomes[outcome] = (result.outcomes[outcome] || 0) + 1;
  }
  if (result.eventCount === 0) result.unavailableReason = "no-cache-source-events-observed";
  return result;
}

function shares(counts, total) {
  return Object.fromEntries(Object.entries(counts || {})
    .map(([name, count]) => [name, Number(count) / Math.max(1, Number(total))]));
}

function compareRaceListCacheTarget(evidence, target) {
  if (!target || target === "calibration-required") return {};
  if (target.schema !== "race-list-cache-target-v1" ||
      !Number.isInteger(target.minimumEvents) || target.minimumEvents < 1 ||
      !(Number(target.tolerance) >= 0 && Number(target.tolerance) <= 1) ||
      (!target.sources && !target.outcomes)) {
    throw new Error("invalid versioned race-list cache target");
  }
  const observedSourceShares = shares(evidence?.sources, evidence?.eventCount);
  const observedOutcomeShares = shares(evidence?.outcomes, evidence?.eventCount);
  const within = (expected, observed) => Object.entries(expected || {}).every(([name, value]) =>
    Number.isFinite(Number(value)) &&
    Math.abs(Number(observed[name] || 0) - Number(value)) <= Number(target.tolerance));
  return {
    targetSchema: target.schema,
    minimumEvents: target.minimumEvents,
    tolerance: Number(target.tolerance),
    observedSourceShares,
    observedOutcomeShares,
    matchesTarget: Number(evidence?.eventCount || 0) >= target.minimumEvents &&
      within(target.sources, observedSourceShares) && within(target.outcomes, observedOutcomeShares),
  };
}

function cacheEvidenceFromResult(result, target) {
  const file = result?.resources?.diagnostics?.paths?.backendLog;
  if (!file || !fs.existsSync(file)) return null;
  const evidence = raceListCacheEvidenceFromLog(fs.readFileSync(file, "utf8"));
  return { ...evidence, ...compareRaceListCacheTarget(evidence, target) };
}

function createRacesTabOpenWorkload(dependencies = {}) {
  const createFixtures = dependencies.createFixtures || createRacesTabOpenFixtures;
  const cleanupFixtures = dependencies.cleanupFixtures || cleanupRacesTabOpenFixtures;
  const verifyFixtures = dependencies.verifyFixtures || verifyRacesTabOpenFixtures;
  const runK6 = dependencies.runK6 || runRawK6;
  const execute = ({ phase, rate, seconds, environment, fixtures, config,
    cacheOnly = false, userOffset = 0 }) => runK6({
    repository: environment.repository,
    phase,
    rate,
    measurementSeconds: seconds,
    fixturePath: fixtures.fixturePath,
    baseUrl: environment.baseUrl,
    outputDirectory: environment.levelOutputDirectory,
    environment: environment.processEnvironment,
    cacheOnly,
    userOffset,
    scriptPath: "scripts/k6/races-tab-open.js",
    profile: "races-tab-open",
    k6Variables: {
      K6_RACES_TAB_RATE: String(rate),
      K6_RACES_TAB_MEASUREMENT_SECONDS: String(seconds),
      K6_RACES_TAB_CACHE_ONLY: cacheOnly ? "1" : "0",
      K6_RACES_TAB_USER_OFFSET: String(userOffset),
      K6_RACES_TAB_CORE_P95_MS: String(config.thresholds.racesCoreP95Ms),
      K6_RACES_TAB_CORE_P99_MS: String(config.thresholds.racesCoreP99Ms),
      K6_RACES_TAB_HTTP_ERROR_RATE: String(config.thresholds.httpErrorRate),
    },
    ...(phase === "measurement" ? {
      metricsConfig: environment.metricsConfig,
      databaseUrl: environment.databaseUrl,
      runId: environment.runId,
      metricEpoch: environment.metricEpoch,
      expectedPids: environment.expectedPids,
    } : {}),
  });
  return {
    async prepareFixtures({ runId, environment, config }) {
      const fixture = await createFixtures({ prisma: environment.prisma, runId,
        users: config.workload.cohortSize || 5000,
        scoreShape: config.workload.scoreShape || "production",
        arrivalRate: Math.max(...(config.scan?.rates || [config.smoke?.rate || 1])),
        env: environment.processEnvironment || process.env });
      const directory = environment.credentialDirectory ||
        fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-races-tab-"));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fixturePath = path.join(directory, `races-tab-open-${crypto.randomUUID()}.json`);
      fs.writeFileSync(fixturePath,
        `${JSON.stringify(buildRacesTabFixtureFile({ runId, fixture }), null, 2)}\n`,
        { flag: "wx", mode: 0o600 });
      return { ...fixture, fixturePath };
    },
    async initialPrewarm({ environment, fixtures, config, seconds }) {
      const rate = config.cache.initialPrewarmRate;
      const users = Math.min(fixtures.users.length, config.cache.initialPrewarmMaxUsers);
      const boundedSeconds = Math.min(seconds, Math.max(1, Math.ceil(users / rate)));
      return execute({ phase: "initial-prewarm", rate, seconds: boundedSeconds,
        environment, fixtures, config, cacheOnly: true, userOffset: 0 });
    },
    warmup({ rate, warmupSeconds, measurementSeconds, environment, fixtures, config }) {
      return execute({ phase: "level-warmup", rate, seconds: warmupSeconds,
        environment, fixtures, config, userOffset: 0 });
    },
    async measure({ rate, measurementSeconds, environment, fixtures, config }) {
      const result = await execute({ phase: "measurement", rate,
        seconds: measurementSeconds, environment, fixtures, config, userOffset: 0 });
      const normalized = normalizeRacesTabEvidence({ summary: result.summary, rate,
        measurementSeconds, fixture: fixtures,
        cacheEvidence: cacheEvidenceFromResult(result, config.cache.raceListTargetMix) });
      const metrics = result.metrics || {};
      environment.lastMeasurementMetrics = metrics;
      const cacheMatches = normalized.racesTabOpen.cacheSourceMix?.matchesTarget === true;
      return {
        ...normalized,
        workerRestarts: Number(metrics.workerRestarts || 0),
        databaseConnectionsExhausted: Number(metrics.databaseConnectionsExhausted || 0),
        targetIdentityValid: metrics.targetIdentityValid === true,
        queueGrowth: Number(metrics.queueGrowth || 0),
        timedOut: normalized.racesTabOpen.iterationDeadlineTimeouts > 0,
        safeCapacityGatesPassed: metrics.targetIdentityValid === true && cacheMatches,
        binding: result.binding || environment.binding,
        resources: result.resources || {},
      };
    },
    targetedReset() {
      return { schema: "races-tab-read-only-reset-v1", performed: false,
        reason: "all baseline endpoints are GET and read-only" };
    },
    async verifyFixtures({ environment, fixtures }) {
      const evidence = await verifyFixtures({ prisma: environment.prisma,
        manifest: fixtures.manifest });
      fixtures.verificationAfter = evidence;
      fixtures.topology.fixtureStability = evidence;
      return evidence;
    },
    async cleanup({ environment, fixtures }) {
      await cleanupFixtures({ prisma: environment.prisma, manifest: fixtures?.manifest });
      if (fixtures?.fixturePath && fs.existsSync(fixtures.fixturePath)) {
        fs.unlinkSync(fixtures.fixturePath);
      }
    },
  };
}

module.exports = {
  buildRacesTabFixtureFile,
  compareRaceListCacheTarget,
  createRacesTabOpenWorkload,
  normalizeRacesTabEvidence,
  raceListCacheEvidenceFromLog,
};
