const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PROFILES } = require("../../src/modules/loadTesting/contract");
const { canonicalRaceListVariant } = require(
  "../../src/modules/races/services/raceListCache");
const { PROJECTION_VERSION, observedCoverageVariants, projectRacesTabPayload } = require(
  "../../src/modules/loadTesting/racesTabOpenProjection");
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
  if (!fixture?.users?.length || fixture.users.some((user) =>
    user.expectedProjectionVersion !== PROJECTION_VERSION ||
    user.expectedProjection?.expectedProjectionVersion !== PROJECTION_VERSION)) {
    throw new Error("Races-tab v2 fixture requires a captured expected projection for every user");
  }
  return {
    schema: "races-tab-open-k6-fixture-v2",
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
      ...(typeof user.id === "string" ? { viewerUserId: user.id } : {}),
      token: user.token,
      zeroFriends: user.zeroFriends === true,
      expectedProjectionVersion: PROJECTION_VERSION,
      expectedProjection: user.expectedProjection,
      coverageVariants: user.coverageVariants || [],
    })),
  };
}

function racesHeaders({ token, runId }) {
  return {
    Accept: "application/json", Authorization: `Bearer ${token}`,
    "X-App-Version": "2.3.11",
    "X-Client-Features": PROFILES["races-tab-open"].racesTabOpen.clientFeatures.join(","),
    "X-Timezone": "America/New_York", "X-Release-Channel": "prod",
    "X-Platform": "ios", "X-Capacity-Run-Id": runId,
  };
}

async function responseJson(response, label) {
  if (!response || response.status !== 200) {
    throw new Error(`Races-tab expected projection ${label} returned ${response?.status || 0}`);
  }
  const body = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Races-tab expected projection ${label} returned malformed JSON`);
  }
  return body;
}

async function captureExpectedProjections({ fixture, baseUrl, runId, fetchImpl = fetch,
  concurrency = 24 } = {}) {
  if (!fixture?.users?.length || !baseUrl || typeof fetchImpl !== "function") {
    throw new Error("Races-tab expected projection capture requires users and the prepared target");
  }
  let cursor = 0;
  const responseBytes = [];
  const workers = Array.from({ length: Math.min(concurrency, fixture.users.length) }, async () => {
    while (cursor < fixture.users.length) {
      const index = cursor; cursor += 1;
      const user = fixture.users[index];
      const headers = racesHeaders({ token: user.token, runId });
      const [core, discovery] = await Promise.all([
        fetchImpl(`${baseUrl}/races?view=compact-v1`, { headers, redirect: "error",
          signal: AbortSignal.timeout(15_000) }).then((response) =>
          responseJson(response, `core user ${index}`)),
        fetchImpl(`${baseUrl}/races/discovery-summary`, { headers, redirect: "error",
          signal: AbortSignal.timeout(15_000) }).then((response) =>
          responseJson(response, `discovery user ${index}`)),
      ]);
      user.expectedProjection = projectRacesTabPayload({ core, discovery,
        friends: user.zeroFriends ? { contract: "friends-summary-v1", friends: [] } : null,
        friendsShouldRequest: user.zeroFriends === true, viewerUserId: user.id });
      user.expectedProjectionVersion = PROJECTION_VERSION;
      const observed = new Set(observedCoverageVariants(user.expectedProjection));
      const missing = (user.coverageVariants || []).filter((variant) => !observed.has(variant));
      if (missing.length) {
        throw new Error(`Races-tab fixture labels do not match captured response predicates at user ${index}: ${missing.join(",")}`);
      }
      responseBytes[index] = { bytes: Buffer.byteLength(JSON.stringify(core), "utf8"),
        rowCount: ["active", "pending", "completed", "tournaments"]
          .reduce((sum, key) => sum + (Array.isArray(core[key]) ? core[key].length : 0), 0),
        observedVariants: [...observed].sort(),
        provenance: user.coverageAugmented === true ? "augmented" : "natural" };
    }
  });
  await Promise.all(workers);
  const summarize = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (fraction) => sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
    return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
  };
  const byCoreRowCount = {};
  const byObservedVariant = {};
  const byProvenance = { natural: [], augmented: [] };
  for (const row of responseBytes) {
    (byCoreRowCount[row.rowCount] ||= []).push(row.bytes);
    for (const variant of row.observedVariants) (byObservedVariant[variant] ||= []).push(row.bytes);
    byProvenance[row.provenance].push(row.bytes);
  }
  fixture.topology ||= {};
  fixture.topology.generatedCoreResponseBytes = { schema: "races-tab-response-bytes-v1",
    ...summarize(responseBytes.map((row) => row.bytes)),
    byCoreRowCount: Object.fromEntries(Object.entries(byCoreRowCount)
      .map(([key, values]) => [key, summarize(values)])),
    byObservedVariant: Object.fromEntries(Object.entries(byObservedVariant)
      .map(([key, values]) => [key, summarize(values)])),
    byProvenance: Object.fromEntries(Object.entries(byProvenance)
      .map(([key, values]) => [key, summarize(values)])) };
  return fixture;
}

function endpointMetric(summary, endpoint, key, fallback) {
  return metric(summary, "http_reqs", key, {
    endpoint, phase: "measurement", telemetry: "sut",
  }, fallback);
}

function identityPoolSize({ rate, config } = {}) {
  const seconds = Number(config?.workload?.sessionDeadlineSeconds || 31);
  const factor = Number(config?.workload?.identitySafetyFactor || 1.05);
  const result = Math.ceil(Number(rate) * seconds * factor);
  if (!Number.isInteger(result) || result < 1) throw new Error("invalid Races-tab identity pool");
  return result;
}

function maximumConfiguredRate(config) {
  return Math.max(...(config?.scan?.rates || [config?.smoke?.rate || 1]));
}

function measurementIdentityOffset(config) {
  return identityPoolSize({ rate: maximumConfiguredRate(config), config });
}

async function fetchCoreCohort({ users, baseUrl, runId, attemptId, fetchImpl, concurrency = 24,
  deadlineMillis, signal, nowMillis = Date.now, deadlineError = () =>
    new Error("Races-tab cache conditioning exceeded wall-clock budget") }) {
  let cursor = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, users.length)) },
    async () => {
      try {
        while (!stopped && cursor < users.length) {
          const remaining = deadlineMillis - nowMillis();
          if (remaining <= 0 || signal?.aborted) throw signal?.reason || deadlineError();
          const user = users[cursor++];
          const headers = { ...racesHeaders({ token: user.token, runId }),
            "X-Capacity-Attempt-Id": attemptId, "X-Capacity-Phase": "cache-conditioning" };
          const requestSignal = signal ? AbortSignal.any([signal,
            AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining)))])
            : AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining)));
          const response = await fetchImpl(`${baseUrl}/races?view=compact-v1`, {
            headers, redirect: "error", signal: requestSignal,
          });
          await responseJson(response, `cache conditioning ${attemptId}`);
          if (nowMillis() > deadlineMillis || signal?.aborted) {
            throw signal?.reason || deadlineError();
          }
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}

function abortableSleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason); }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function awaitDeadlineSettlement(operation, { signal, deadlineError }) {
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(signal.reason || deadlineError());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } catch (error) {
    if (!signal.aborted) throw error;
    await Promise.allSettled([operation]);
    throw signal.reason || deadlineError();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function boundedCacheCleanup(deleteExact, input, maximumMs = 30_000) {
  const deadlineMillis = Date.now() + maximumMs;
  const controller = new AbortController();
  const deadlineError = () => {
    const error = new Error(`Races-tab owned-cache cleanup exceeded ${maximumMs}ms`);
    error.cacheCleanup = { budgetMillis: maximumMs, budgetExceeded: true };
    return error;
  };
  const timer = setTimeout(() => controller.abort(deadlineError()), maximumMs);
  timer.unref?.();
  try {
    const operation = Promise.resolve().then(() => deleteExact({ ...input, deadlineMillis,
      timeoutMs: Math.max(1, deadlineMillis - Date.now()), signal: controller.signal }));
    return await awaitDeadlineSettlement(operation, { signal: controller.signal, deadlineError });
  } finally {
    clearTimeout(timer);
  }
}

async function conditionMeasurementCache({ rate, purpose, attempt, environment, fixtures, config,
  deleteExact, fetchImpl = fetch, sleep = abortableSleep,
  nowMillis = Date.now }) {
  if (typeof deleteExact !== "function") {
    throw new Error("Races-tab cache conditioning requires exact-key Redis cleanup");
  }
  const startedAtMillis = nowMillis();
  const poolSize = identityPoolSize({ rate, config });
  const offset = measurementIdentityOffset(config);
  const users = fixtures.users.slice(offset, offset + poolSize);
  if (users.length !== poolSize) throw new Error("Races-tab measurement identity pool is incomplete");
  const attemptId = `${purpose}-${attempt}`;
  const profile = config.cache?.racesTabConditioning;
  if (profile?.schema !== "races-tab-cache-conditioning-v1" ||
      Math.abs(Number(profile.hot30Share) + Number(profile.hot15Share) +
        Number(profile.expired300Share) - 1) > 1e-9 || profile.maximumSeconds > 30) {
    throw new Error("invalid bounded Races-tab cache conditioning profile");
  }
  const deadlineMillis = startedAtMillis + Number(profile.maximumSeconds) * 1000;
  const deadlineError = () => {
    const durationSeconds = (nowMillis() - startedAtMillis) / 1000;
    const error = new Error(`Races-tab cache conditioning exceeded wall-clock budget of ${profile.maximumSeconds}s`);
    error.cacheConditioning = { schema: "races-tab-cache-conditioning-overrun-v1",
      durationSeconds, budgetSeconds: Number(profile.maximumSeconds), budgetExceeded: true };
    return error;
  };
  const assertBudget = () => {
    if (nowMillis() > deadlineMillis) {
      throw deadlineError();
    }
  };
  assertBudget();
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError()),
    Math.max(1, deadlineMillis - nowMillis()));
  deadlineTimer.unref?.();
  try {
    const variant = canonicalRaceListVariant({
      clientFeatures: new Set(PROFILES["races-tab-open"].racesTabOpen.clientFeatures),
      compact: true, releaseChannel: "prod",
    });
    const deleteOperation = Promise.resolve().then(() => deleteExact({ environment,
      userIds: users.map((user) => user.id), variant, initializeGeneration: true,
      deadlineMillis, timeoutMs: Math.max(1, deadlineMillis - nowMillis()),
      signal: deadlineController.signal }));
    const deletedKeys = await awaitDeadlineSettlement(deleteOperation,
      { signal: deadlineController.signal, deadlineError });
    assertBudget();
    const bucket = (index) => (index * 37) % 100;
    const hot30 = users.filter((_, index) => bucket(index) < profile.hot30Share * 100);
    const hot15 = users.filter((_, index) => bucket(index) >= profile.hot30Share * 100 &&
      bucket(index) < (profile.hot30Share + profile.hot15Share) * 100);
    const expired300 = users.filter((_, index) =>
      bucket(index) >= (profile.hot30Share + profile.hot15Share) * 100);
    const workloadRunId = fixtures.manifest?.runId || environment.runId;
    await fetchCoreCohort({ users: hot30, baseUrl: environment.baseUrl, runId: workloadRunId,
      attemptId, fetchImpl, deadlineMillis, signal: deadlineController.signal,
      nowMillis, deadlineError });
    // Stay inside the 30-second membership TTL rather than racing its expiry.
    await awaitDeadlineSettlement(Promise.resolve().then(() => sleep(
      Math.max(0, startedAtMillis + 14_000 - nowMillis()),
      { signal: deadlineController.signal, deadlineMillis })),
    { signal: deadlineController.signal, deadlineError });
    assertBudget();
    await fetchCoreCohort({ users: hot15, baseUrl: environment.baseUrl, runId: workloadRunId,
      attemptId, fetchImpl, deadlineMillis, signal: deadlineController.signal,
      nowMillis, deadlineError });
    await awaitDeadlineSettlement(Promise.resolve().then(() => sleep(
      Math.max(0, startedAtMillis + 29_000 - nowMillis()),
      { signal: deadlineController.signal, deadlineMillis })),
    { signal: deadlineController.signal, deadlineError });
    assertBudget();
    const durationSeconds = (nowMillis() - startedAtMillis) / 1000;
    return { schema: "races-tab-cache-conditioning-v1", attemptId, deletedKeys,
      profile: profile.profile, cohorts: { hot30Seconds: hot30.length, hot15Seconds: hot15.length,
      expired300Seconds: expired300.length }, durationSeconds, budgetSeconds: profile.maximumSeconds,
      budgetExceeded: durationSeconds > Number(profile.maximumSeconds),
      expiredDisposition: "exact-keys-absent-equivalent-to-expired" };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function normalizeRacesTabEvidence({ summary, rate, measurementSeconds, fixture,
  cacheEvidence = null, userOffset = 0, identityPool = null, mismatchSamples = [] } = {}) {
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
      fixture.users[((index % (identityPool || fixture.users.length)) + userOffset) %
        fixture.users.length]?.zeroFriends === true)
      .filter(Boolean).length
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
  const mismatchCount = metric(summary, "races_tab_payload_content_mismatches", "count",
    phase, 0);
  const mismatchCounts = Object.fromEntries(require(
    "../../src/modules/loadTesting/racesTabOpenProjection").MISMATCH_REASONS.map((reason) => [
    reason, metric(summary, "races_tab_payload_mismatch_reasons", "count",
      { ...phase, reason }, 0),
  ]).filter(([, count]) => count > 0));
  const requiredVariants = require(
    "../../src/modules/loadTesting/racesTabOpenProjection").REQUIRED_COVERAGE_VARIANTS;
  const coverageCounts = Object.fromEntries(requiredVariants.map((variant) => [
    variant, metric(summary, "races_tab_coverage_variant_seen", "count",
      { ...phase, variant }, 0),
  ]));
  const missingVariants = requiredVariants.filter((variant) => coverageCounts[variant] < 1);
  const contentTotals = {};
  for (const [family, states] of Object.entries({ ordinary: ["active", "pending", "completed", "invited"],
    tournament: ["active", "pending", "completed", "invited"],
    tournament_render: ["invite", "lobby", "between_rounds", "live_match", "eliminated",
      "champion", "completed_non_champion"], ordinary_inventory: ["rows"],
    ordinary_effect: ["rows"], tournament_match: ["rows"],
    discovery: ["public_races"] })) {
    contentTotals[family] = Object.fromEntries(states.map((state) => [state,
      metric(summary, "races_tab_content_rows", "count", { ...phase, family, state }, 0)]));
  }
  for (const [metricName, row] of Object.entries(summary?.metrics || {})) {
    if (!metricName.startsWith("races_tab_content_rows{") || !metricName.endsWith("}")) continue;
    const tags = Object.fromEntries(metricName.slice(metricName.indexOf("{") + 1, -1)
      .split(",").map((part) => { const at = part.indexOf(":");
        return [part.slice(0, at), part.slice(at + 1)]; }));
    if (tags.phase !== "measurement" || !tags.family || !tags.state) continue;
    contentTotals[tags.family] ||= {};
    contentTotals[tags.family][tags.state] = Number(row?.values?.count || 0);
  }
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
    content: {
      mismatchCount,
      mismatchCounts,
      coverageMissingCount: missingVariants.length,
      missingVariants,
      coveredVariants: requiredVariants.length - missingVariants.length,
      coverageCounts,
      totals: contentTotals,
      mismatchSamples: mismatchSamples.slice(0, 50),
      mismatchSamplesTruncated: mismatchCount > Math.min(50, mismatchSamples.length),
    },
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
    racesPayloadContentMismatches: mismatchCount,
    fixtureStateCoverageMissing: missingVariants.length,
    droppedArrivals: Math.max(
      metric(summary, "dropped_iterations", "count", phase, 0),
      Math.max(0, expected - started),
    ),
    racesTabOpen,
  };
}

function raceListCacheEvidenceFromLog(log = "", expectedDimensions = null) {
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
    if (expectedDimensions && Object.entries(expectedDimensions)
      .some(([name, value]) => row[name] !== value)) continue;
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

function racesTabMismatchSamplesFromLog(log = "", sampleLimit = 50) {
  const samples = [];
  const seen = new Set();
  let observedSampleCount = 0;
  const safeType = new Set(["array", "null", "object", "string", "number", "boolean", "undefined"]);
  for (const line of String(log).split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    let row;
    try { row = JSON.parse(line.slice(start)); } catch { continue; }
    if (row?.event !== "races_tab_projection_mismatch_sample_v1" ||
        !Number.isInteger(row.fixtureIndex) || row.fixtureIndex < 0 ||
        typeof row.path !== "string" || row.path.length > 256 ||
        !require("../../src/modules/loadTesting/racesTabOpenProjection").MISMATCH_REASONS
          .includes(row.reason) || !safeType.has(row.expectedType) || !safeType.has(row.observedType)) {
      continue;
    }
    const key = `${row.fixtureIndex}:${row.path}`;
    if (seen.has(key)) continue;
    seen.add(key); observedSampleCount += 1;
    if (samples.length < sampleLimit) samples.push({ fixtureIndex: row.fixtureIndex,
      path: row.path, reason: row.reason, expectedType: row.expectedType,
      observedType: row.observedType });
  }
  return { samples, observedSampleCount, truncated: observedSampleCount > samples.length };
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

function cacheEvidenceFromResult(result, target, expectedDimensions) {
  const file = result?.resources?.diagnostics?.paths?.backendLog;
  if (!file || !fs.existsSync(file)) return null;
  const evidence = raceListCacheEvidenceFromLog(fs.readFileSync(file, "utf8"),
    expectedDimensions);
  return { ...evidence, ...compareRaceListCacheTarget(evidence, target) };
}

function createRacesTabOpenWorkload(dependencies = {}) {
  const createFixtures = dependencies.createFixtures || createRacesTabOpenFixtures;
  const cleanupFixtures = dependencies.cleanupFixtures || cleanupRacesTabOpenFixtures;
  const verifyFixtures = dependencies.verifyFixtures || verifyRacesTabOpenFixtures;
  const runK6 = dependencies.runK6 || runRawK6;
  const captureProjections = dependencies.captureExpectedProjections || captureExpectedProjections;
  const conditionCache = dependencies.conditionMeasurementCache || conditionMeasurementCache;
  const execute = ({ phase, rate, seconds, environment, fixtures, config,
    cacheOnly = false, userOffset = 0, purpose = phase, attempt = 1 }) => {
    const poolSize = identityPoolSize({ rate, config });
    return runK6({
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
    captureConsole: phase === "measurement",
    k6Variables: {
      K6_RACES_TAB_RATE: String(rate),
      K6_RACES_TAB_MEASUREMENT_SECONDS: String(seconds),
      K6_RACES_TAB_CACHE_ONLY: cacheOnly ? "1" : "0",
      K6_RACES_TAB_USER_OFFSET: String(userOffset),
      K6_RACES_TAB_IDENTITY_POOL_SIZE: String(poolSize),
      K6_RACES_TAB_ATTEMPT_ID: `${purpose}-${attempt}`,
      K6_RACES_TAB_PHASE: phase,
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
  };
  return {
    async prepareFixtures({ runId, environment, config }) {
      const fixture = await createFixtures({ prisma: environment.prisma, runId,
        users: config.workload.cohortSize || 5000,
        scoreShape: config.workload.scoreShape || "production",
        arrivalRate: Math.max(...(config.scan?.rates || [config.smoke?.rate || 1])),
        env: environment.processEnvironment || process.env });
      let fixturePath = null;
      try {
        await captureProjections({ fixture, baseUrl: environment.baseUrl, runId,
          fetchImpl: dependencies.fetchImpl || globalThis.fetch });
        const directory = environment.credentialDirectory ||
          fs.mkdtempSync(path.join(os.tmpdir(), "bara-perf-races-tab-"));
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fixturePath = path.join(directory, `races-tab-open-${crypto.randomUUID()}.json`);
        const serialized = `${JSON.stringify(buildRacesTabFixtureFile({ runId, fixture }), null, 2)}\n`;
        const maximumBytes = Number(config.workload.maximumFixtureBytes || 67_108_864);
        if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
          throw new Error(`Races-tab fixture exceeds ${maximumBytes} bytes`);
        }
        fs.writeFileSync(fixturePath, serialized, { flag: "wx", mode: 0o600 });
        return { ...fixture, fixturePath };
      } catch (error) {
        const cleanupErrors = [];
        if (fixturePath && fs.existsSync(fixturePath)) {
          try { fs.unlinkSync(fixturePath); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (typeof environment.deleteExactRaceListCache === "function") {
          const variant = canonicalRaceListVariant({ clientFeatures: new Set(
            PROFILES["races-tab-open"].racesTabOpen.clientFeatures), compact: true });
          try { await boundedCacheCleanup(environment.deleteExactRaceListCache,
            { environment, userIds: fixture.users.map((user) => user.id), variant }); }
          catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        try { await cleanupFixtures({ prisma: environment.prisma, manifest: fixture.manifest }); }
        catch (cleanupError) { cleanupErrors.push(...(cleanupError.errors || [cleanupError])); }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
          `Races-tab fixture serialization and cleanup failed: ${error.message}`);
        throw error;
      }
    },
    async initialPrewarm({ environment, fixtures, config, seconds }) {
      const rate = config.cache.initialPrewarmRate;
      const users = Math.min(fixtures.users.length, config.cache.initialPrewarmMaxUsers);
      const boundedSeconds = Math.min(seconds, Math.max(1, Math.ceil(users / rate)));
      const measurementOffset = measurementIdentityOffset(config);
      return execute({ phase: "initial-prewarm", rate, seconds: boundedSeconds,
        environment, fixtures, config, cacheOnly: true, userOffset: measurementOffset });
    },
    warmup({ rate, warmupSeconds, measurementSeconds, environment, fixtures, config }) {
      return execute({ phase: "level-warmup", rate, seconds: warmupSeconds,
        environment, fixtures, config, userOffset: 0 });
    },
    async measure({ rate, purpose, attempt, measurementSeconds, environment, fixtures, config }) {
      const measurementOffset = measurementIdentityOffset(config);
      const result = await execute({ phase: "measurement", rate,
        seconds: measurementSeconds, environment, fixtures, config,
        userOffset: measurementOffset, purpose, attempt });
      const poolSize = identityPoolSize({ rate, config });
      const normalized = normalizeRacesTabEvidence({ summary: result.summary, rate,
        measurementSeconds, fixture: fixtures, userOffset: measurementOffset,
        identityPool: poolSize,
        mismatchSamples: result.consolePath && fs.existsSync(result.consolePath)
          ? racesTabMismatchSamplesFromLog(fs.readFileSync(result.consolePath, "utf8")).samples : [],
        cacheEvidence: cacheEvidenceFromResult(result, config.cache.raceListTargetMix, {
          runId: fixtures.manifest?.runId || environment.runId,
          attemptId: `${purpose}-${attempt}`, phase: "measurement",
        }) });
      const metrics = result.metrics || {};
      environment.lastMeasurementMetrics = metrics;
      const cacheMatches = normalized.racesTabOpen.cacheSourceMix?.matchesTarget === true;
      const generatorCpuPercent = Number(result.resources?.generatorCpuPercent);
      const generatorHealthy = normalized.droppedArrivals === 0 &&
        normalized.racesTabOpen.scheduler.lagMs.p99 <= config.workload.generatorSchedulerLagP99Ms &&
        Number.isFinite(generatorCpuPercent) &&
        generatorCpuPercent < config.workload.generatorCpuPercent;
      return {
        ...normalized,
        workerRestarts: Number(metrics.workerRestarts || 0),
        databaseConnectionsExhausted: Number(metrics.databaseConnectionsExhausted || 0),
        targetIdentityValid: metrics.targetIdentityValid === true,
        queueGrowth: Number(metrics.queueGrowth || 0),
        timedOut: normalized.racesTabOpen.iterationDeadlineTimeouts > 0,
        generatorCapacityValid: generatorHealthy,
        safeCapacityGatesPassed: metrics.targetIdentityValid === true && cacheMatches &&
          generatorHealthy && normalized.racesPayloadContentMismatches === 0 &&
          normalized.fixtureStateCoverageMissing === 0,
        binding: result.binding || environment.binding,
        resources: { ...(result.resources || {}), generatorSaturated: !generatorHealthy },
      };
    },
    async targetedReset({ rate, purpose, attempt, environment, fixtures, config,
      deleteExactRaceListCache }) {
      const cacheConditioning = await conditionCache({ rate, purpose, attempt, environment,
        fixtures, config, deleteExact: deleteExactRaceListCache,
        fetchImpl: dependencies.fetchImpl || globalThis.fetch, sleep: dependencies.sleep });
      return { schema: "races-tab-read-only-reset-v2", durableResetPerformed: false,
        reason: "all baseline endpoints are GET and read-only", cacheConditioning };
    },
    async verifyFixtures({ environment, fixtures }) {
      const evidence = await verifyFixtures({ prisma: environment.prisma,
        manifest: fixtures.manifest });
      fixtures.verificationAfter = evidence;
      fixtures.topology.fixtureStability = evidence;
      return evidence;
    },
    async cleanup({ environment, fixtures }) {
      const errors = [];
      if (fixtures?.users?.length && typeof environment.deleteExactRaceListCache === "function") {
        const variant = canonicalRaceListVariant({ clientFeatures: new Set(
          PROFILES["races-tab-open"].racesTabOpen.clientFeatures), compact: true,
        });
        try { await boundedCacheCleanup(environment.deleteExactRaceListCache,
          { environment, userIds: fixtures.users.map((user) => user.id), variant }); }
        catch (error) { errors.push(error); }
      }
      try { await cleanupFixtures({ prisma: environment.prisma, manifest: fixtures?.manifest }); }
      catch (error) { errors.push(...(error.errors || [error])); }
      if (fixtures?.fixturePath && fs.existsSync(fixtures.fixturePath)) {
        try { fs.unlinkSync(fixtures.fixturePath); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Races-tab workload cleanup failed");
    },
  };
}

module.exports = {
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
};
