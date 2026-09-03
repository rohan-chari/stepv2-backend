import http from "k6/http";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";
import { compareRacesTabProjection, projectRacesTabPayload, PROJECTION_VERSION,
  REQUIRED_COVERAGE_VARIANTS, observedCoverageVariants } from "./races-tab-projection.js";

const fixture = new SharedArray("races-tab-open-fixture", () =>
  [JSON.parse(open(__ENV.K6_FIXTURE_PATH))])[0];
if (fixture.schema !== "races-tab-open-k6-fixture-v2" ||
    fixture.client?.headerProfile !== "current-races-2.3.11-ios-v1") {
  throw new Error("races-tab-open fixture does not match the locked client contract");
}
if (!Array.isArray(fixture.users) || fixture.users.length === 0 || fixture.users.some((user) =>
  typeof user.viewerUserId !== "string" ||
  user.expectedProjectionVersion !== PROJECTION_VERSION ||
  !isMap(user.expectedProjection) || !Array.isArray(user.coverageVariants))) {
  throw new Error("races-tab-open fixture does not contain the v2 expected projection");
}

const rate = Number(__ENV.K6_RACES_TAB_RATE || 5);
const measuredSeconds = Number(__ENV.K6_RACES_TAB_MEASUREMENT_SECONDS || 60);
const cacheOnly = __ENV.K6_RACES_TAB_CACHE_ONLY === "1";
const userOffset = Number(__ENV.K6_RACES_TAB_USER_OFFSET || 0);
const identityPoolSize = Number(__ENV.K6_RACES_TAB_IDENTITY_POOL_SIZE || fixture.users.length);
const attemptId = String(__ENV.K6_RACES_TAB_ATTEMPT_ID || "measurement-1");
const trafficPhase = String(__ENV.K6_RACES_TAB_PHASE || "measurement");
if (!Number.isInteger(identityPoolSize) || identityPoolSize < 1 ||
    userOffset < 0 || userOffset + identityPoolSize > fixture.users.length ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(attemptId) ||
    !["initial-prewarm", "level-warmup", "measurement"].includes(trafficPhase)) {
  throw new Error("races-tab identity pool or attempt dimensions are invalid");
}
const coreP95ThresholdMs = Number(__ENV.K6_RACES_TAB_CORE_P95_MS || 1000);
const coreP99ThresholdMs = Number(__ENV.K6_RACES_TAB_CORE_P99_MS || 2000);
const httpErrorRateThreshold = Number(__ENV.K6_RACES_TAB_HTTP_ERROR_RATE || 0.001);
const ITERATION_DEADLINE_MS = 31_000;
const REQUEST_TIMEOUT = "15s";
const boundedSessionSeconds = 31;
const vus = Math.max(1, Math.ceil(rate * boundedSessionSeconds * 1.05));
const expectedSessions = rate * measuredSeconds;
const expectedBackground = cacheOnly ? 0 : expectedSessions;
const expectedFriends = cacheOnly ? 0 : Array.from({ length: expectedSessions }, (_, index) =>
  fixture.users[(index % identityPoolSize) + userOffset].zeroFriends === true)
  .filter(Boolean).length;

const started = new Counter("races_tab_sessions_started");
const offered = new Counter("races_tab_sessions_offered");
const coreComplete = new Counter("races_tab_sessions_core_refresh_complete");
const completed = new Counter("races_tab_sessions_completed");
const coreMs = new Trend("races_tab_core_refresh_ms", true);
const discoveryStarted = new Counter("races_tab_discovery_started");
const discoveryCompleted = new Counter("races_tab_discovery_completed");
const discoveryErrors = new Counter("races_tab_discovery_errors");
const discoveryMs = new Trend("races_tab_discovery_ms", true);
const friendsStarted = new Counter("races_tab_friends_started");
const friendsCompleted = new Counter("races_tab_friends_completed");
const friendsErrors = new Counter("races_tab_friends_errors");
const friendsMs = new Trend("races_tab_friends_ms", true);
const networkErrors = new Counter("races_tab_network_errors");
const contractErrors = new Counter("races_tab_contract_errors");
const deadlineTimeouts = new Counter("races_tab_iteration_deadline_timeouts");
const schedulerLagMs = new Trend("races_tab_scheduler_lag_ms", true);
const quotaRejected = new Counter("races_tab_sessions_quota_rejected");
const endpointResponseBytes = new Trend("races_tab_endpoint_response_bytes", true);
const sessionFailed = new Rate("races_tab_sessions_failed");
const contentMismatches = new Counter("races_tab_payload_content_mismatches");
const mismatchReasons = new Counter("races_tab_payload_mismatch_reasons");
const coverageVariantSeen = new Counter("races_tab_coverage_variant_seen");
const contentRows = new Counter("races_tab_content_rows");

const perEndpoint = ["compact-races", "discovery-summary", "friends-summary"];
const endpointThresholds = Object.fromEntries(perEndpoint.flatMap((endpoint) => [
  [`http_reqs{endpoint:${endpoint},phase:measurement,telemetry:sut}`, ["count>=0"]],
  [`http_req_duration{endpoint:${endpoint},phase:measurement,telemetry:sut}`, ["p(99)<60000"]],
  [`races_tab_endpoint_response_bytes{endpoint:${endpoint},phase:measurement}`, ["max>=0"]],
]));
const coverageThresholds = cacheOnly ? {} : Object.fromEntries(REQUIRED_COVERAGE_VARIANTS.map((variant) => [
  `races_tab_coverage_variant_seen{phase:measurement,variant:${variant}}`, ["count>=1"],
]));

export const options = {
  discardResponseBodies: false,
  maxRedirects: 0,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    measured: {
      executor: "constant-arrival-rate", exec: "racesTabOpen", rate, timeUnit: "1s",
      duration: `${measuredSeconds}s`, preAllocatedVUs: vus, maxVUs: vus,
      tags: { phase: "measurement" }, gracefulStop: "32s",
    },
  },
  thresholds: {
    ...endpointThresholds,
    ...coverageThresholds,
    "races_tab_sessions_started{phase:measurement}": [`count==${expectedSessions}`],
    "races_tab_sessions_offered{phase:measurement}": [`count==${expectedSessions}`],
    "races_tab_sessions_core_refresh_complete{phase:measurement}": ["count>=0"],
    "races_tab_sessions_completed{phase:measurement}": [`count==${expectedSessions}`],
    "races_tab_sessions_quota_rejected{phase:measurement}": ["count>=0"],
    "races_tab_core_refresh_ms{phase:measurement}": [
      `p(95)<=${coreP95ThresholdMs}`, `p(99)<=${coreP99ThresholdMs}`],
    "races_tab_discovery_started{phase:measurement}": [`count==${expectedBackground}`],
    "races_tab_discovery_completed{phase:measurement}": [`count==${expectedBackground}`],
    "races_tab_discovery_errors{phase:measurement}": ["count==0"],
    "races_tab_friends_started{phase:measurement}": [`count==${expectedFriends}`],
    "races_tab_friends_completed{phase:measurement}": [`count==${expectedFriends}`],
    "races_tab_friends_errors{phase:measurement}": ["count==0"],
    "races_tab_network_errors{phase:measurement}": ["count==0"],
    "races_tab_contract_errors{phase:measurement}": ["count==0"],
    "races_tab_payload_content_mismatches{phase:measurement}": ["count==0"],
    "races_tab_iteration_deadline_timeouts{phase:measurement}": ["count==0"],
    "races_tab_scheduler_lag_ms{phase:measurement}": ["max<=1000"],
    "races_tab_sessions_failed{phase:measurement}": ["rate<0.0000001"],
    "http_req_failed{phase:measurement,telemetry:sut}": [`rate<${httpErrorRateThreshold}`],
    "dropped_iterations{phase:measurement}": ["count==0"],
  },
};

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMap(response) {
  try {
    const value = response.json();
    return isMap(value) ? value : null;
  } catch (_) { return null; }
}

function validCompactRaces(response) {
  const body = response?.status === 200 ? parseMap(response) : null;
  return Boolean(body && body.contract === "race-list-compact-v1" &&
    [body.active, body.pending, body.completed].every(Array.isArray));
}

function validDiscovery(response) {
  const body = response?.status === 200 ? parseMap(response) : null;
  const resolved = body?.resolved;
  return Boolean(body && Number.isInteger(body.publicRaceCount) && body.publicRaceCount >= 0 &&
    Array.isArray(body.featuredRaces) && Array.isArray(body.featuredTournaments) &&
    isMap(resolved) && resolved.publicRaceCount === true &&
    resolved.featuredRaces === true && resolved.featuredTournaments === true);
}

function validFriends(response) {
  const body = response?.status === 200 ? parseMap(response) : null;
  return Boolean(body && body.contract === "friends-summary-v1" &&
    Array.isArray(body.friends) && isMap(body.pending) &&
    Array.isArray(body.pending.incoming) && Array.isArray(body.pending.outgoing));
}

function coreProjection(value = {}) {
  return { expectedProjectionVersion: value.expectedProjectionVersion,
    ordinary: value.ordinary, ordinaryInventoryByRace: value.ordinaryInventoryByRace,
    ordinaryEffectsByRace: value.ordinaryEffectsByRace,
    tournaments: value.tournaments,
    tournamentMatchByTournament: value.tournamentMatchByTournament };
}

function recordContentComparison(comparison, user) {
  if (comparison.matches) return;
  contentMismatches.add(comparison.mismatchCount);
  for (const [reason, count] of Object.entries(comparison.mismatchCounts)) {
    mismatchReasons.add(count, { reason });
  }
  if (trafficPhase === "measurement" && user.userIndex < 50) {
    for (const sample of comparison.samples.slice(0, 1)) console.error(JSON.stringify({
      event: "races_tab_projection_mismatch_sample_v1", fixtureIndex: user.userIndex,
      reason: sample.reason, path: sample.path,
      expectedType: sample.expectedType, observedType: sample.observedType,
    }));
  }
}

function recordProjectionTotals(projection) {
  for (const [bucket, rows] of Object.entries(projection.ordinary || {})) {
    contentRows.add(rows.length, { family: "ordinary", state: bucket });
    for (const row of rows) {
      if (row.isFavorite) contentRows.add(1,
        { family: "favorites", state: row.kind === "team" ? "team" : "classic" });
      if (row.kind === "team") contentRows.add(1,
        { family: "teams", state: `size_${row.team?.size ?? "unknown"}` });
      if (row.placement?.privacyActive) contentRows.add(1,
        { family: "placement", state: "privacy" });
      if (row.placement?.hidden) contentRows.add(1,
        { family: "placement", state: "hidden" });
      else if (row.placement?.value != null || row.placement?.displayValue != null) {
        contentRows.add(1, { family: "placement", state: "visible" });
      }
    }
  }
  for (const [bucket, rows] of Object.entries(projection.tournaments || {})) {
    contentRows.add(rows.length, { family: "tournament", state: bucket });
    for (const row of rows) contentRows.add(1,
      { family: "tournament_render", state: row.renderState || "unknown" });
    for (const row of rows) if (row.isFavorite) {
      contentRows.add(1, { family: "favorites", state: "tournament" });
    }
  }
  contentRows.add((projection.ordinaryInventoryByRace || []).length,
    { family: "ordinary_inventory", state: "rows" });
  for (const row of projection.ordinaryInventoryByRace || []) {
    contentRows.add((row.heldTypedItems || []).length,
      { family: "ordinary_inventory", state: "held" });
    contentRows.add(Number(row.mysteryBoxCount || 0),
      { family: "ordinary_inventory", state: "mystery" });
    contentRows.add(Number(row.queuedBoxCount || 0),
      { family: "ordinary_inventory", state: "queued" });
  }
  contentRows.add((projection.ordinaryEffectsByRace || []).length,
    { family: "ordinary_effect", state: "rows" });
  for (const row of projection.ordinaryEffectsByRace || []) {
    contentRows.add(Object.values(row.positive || {}).reduce((sum, count) => sum + count, 0),
      { family: "ordinary_effect", state: "positive" });
    contentRows.add(Object.values(row.negative || {}).reduce((sum, count) => sum + count, 0),
      { family: "ordinary_effect", state: "negative" });
  }
  contentRows.add((projection.tournamentMatchByTournament || []).length,
    { family: "tournament_match", state: "rows" });
  for (const row of projection.tournamentMatchByTournament || []) {
    if (row.placement?.privacyActive) contentRows.add(1,
      { family: "match_placement", state: "privacy" });
    if (row.placement?.hidden) contentRows.add(1,
      { family: "match_placement", state: "hidden" });
    else if (row.placement?.value != null || row.placement?.displayValue != null) {
      contentRows.add(1, { family: "match_placement", state: "visible" });
    }
    contentRows.add((row.inventory?.heldTypedItems || []).length,
      { family: "match_inventory", state: "held" });
    contentRows.add(Number(row.inventory?.mysteryBoxCount || 0),
      { family: "match_inventory", state: "mystery" });
    contentRows.add(Number(row.inventory?.queuedBoxCount || 0),
      { family: "match_inventory", state: "queued" });
  }
  contentRows.add(Number(projection.discovery?.publicRaceCount || 0),
    { family: "discovery", state: "public_races" });
}

function headers(user) {
  return {
    Accept: "application/json", Authorization: `Bearer ${user.token}`,
    "X-App-Version": fixture.client.appVersion,
    "X-Client-Features": fixture.client.features.join(","),
    "X-Timezone": fixture.client.timezone,
    "X-Release-Channel": fixture.client.releaseChannel,
    "X-Platform": fixture.client.platform,
    "X-Capacity-Run-Id": fixture.runId,
    "X-Capacity-Attempt-Id": attemptId,
    "X-Capacity-Phase": trafficPhase,
  };
}

function request(path, endpoint, user) {
  return ["GET", `${__ENV.K6_BASE_URL}${path}`, null, {
    headers: headers(user), timeout: REQUEST_TIMEOUT,
    tags: { endpoint, telemetry: "sut" },
    responseCallback: http.expectedStatuses(200),
  }];
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of String(value || "")) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function observe(response, endpoint) {
  networkErrors.add(!response || response.status === 0 ? 1 : 0, { endpoint });
  endpointResponseBytes.add(utf8ByteLength(response?.body), { endpoint });
}

export async function racesTabOpen() {
  const iteration = exec.scenario.iterationInInstance;
  if (iteration >= expectedSessions) {
    quotaRejected.add(1);
    return;
  }
  const intendedAt = Number(exec.scenario.startTime) + iteration * (1000 / rate);
  schedulerLagMs.add(Math.max(0, Date.now() - intendedAt));
  const began = Date.now();
  // The pool is sized for the full 31-second deadline. Reuse after one complete
  // pool traversal is therefore non-overlapping even at the configured rate.
  const user = fixture.users[(exec.scenario.iterationInTest % identityPoolSize) + userOffset];
  offered.add(1);
  started.add(1);

  const core = http.request(...request("/races?view=compact-v1", "compact-races", user));
  observe(core, "compact-races");
  const coreBody = parseMap(core) || {};
  const observedCore = projectRacesTabPayload({ core: coreBody,
    friendsShouldRequest: user.zeroFriends === true, viewerUserId: user.viewerUserId });
  const coreComparison = compareRacesTabProjection(coreProjection(user.expectedProjection),
    coreProjection(observedCore));
  const coreValid = validCompactRaces(core) && coreComparison.matches;
  coreMs.add(Date.now() - began);
  if (coreValid) coreComplete.add(1);
  if (cacheOnly) {
    sessionFailed.add(!coreValid);
    completed.add(1);
    return;
  }

  discoveryStarted.add(1);
  const discoveryBegan = Date.now();
  const discoveryPromise = http.asyncRequest(...request(
    "/races/discovery-summary", "discovery-summary", user));
  let friendsPromise = null;
  let friendsBegan = 0;
  if (user.zeroFriends === true) {
    friendsStarted.add(1);
    friendsBegan = Date.now();
    friendsPromise = http.asyncRequest(...request(
      "/friends?view=summary-v1", "friends-summary", user));
  }
  const rows = await Promise.all([discoveryPromise, friendsPromise || Promise.resolve(null)]);
  const discovery = rows[0];
  observe(discovery, "discovery-summary");
  discoveryMs.add(Date.now() - discoveryBegan);
  const discoveryValid = validDiscovery(discovery);
  if (discoveryValid) discoveryCompleted.add(1);
  else {
    discoveryErrors.add(1);
    if (discovery?.status !== 0) contractErrors.add(1, { endpoint: "discovery-summary" });
  }

  let friendsValid = true;
  let friendsBody = null;
  if (friendsPromise) {
    const friends = rows[1];
    friendsBody = parseMap(friends);
    observe(friends, "friends-summary");
    friendsMs.add(Date.now() - friendsBegan);
    friendsValid = validFriends(friends);
    if (friendsValid) friendsCompleted.add(1);
    else {
      friendsErrors.add(1);
      if (friends?.status !== 0) contractErrors.add(1, { endpoint: "friends-summary" });
    }
  }
  const observedProjection = projectRacesTabPayload({ core: coreBody,
    discovery: parseMap(discovery) || {}, friends: friendsBody,
    friendsShouldRequest: user.zeroFriends === true, viewerUserId: user.viewerUserId });
  const contentComparison = compareRacesTabProjection(user.expectedProjection, observedProjection);
  recordContentComparison(contentComparison, user);
  recordProjectionTotals(observedProjection);
  for (const variant of observedCoverageVariants(observedProjection)) {
    coverageVariantSeen.add(1, { variant });
  }
  if (!coreValid && core?.status !== 0) contractErrors.add(1, { endpoint: "compact-races" });
  const deadlineExceeded = Date.now() - began > ITERATION_DEADLINE_MS;
  if (deadlineExceeded) deadlineTimeouts.add(1);
  sessionFailed.add(!coreValid || !discoveryValid || !friendsValid ||
    !contentComparison.matches || deadlineExceeded);
  completed.add(1);
}

export function handleSummary(data) {
  return { [__ENV.K6_SUMMARY_PATH || "races-tab-open-k6-summary.json"]:
    JSON.stringify(data, null, 2) };
}
