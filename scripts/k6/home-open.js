import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";

const fixture = new SharedArray("home-open-fixture", () =>
  [JSON.parse(open(__ENV.K6_FIXTURE_PATH))])[0];
if (fixture.schema === "home-open-k6-fixture-v2" &&
    (fixture.client?.headerProfile !== "current-home-2.3.11-ios-v1" ||
     !Array.isArray(fixture.client?.features) ||
     !fixture.client.features.includes("race_payout_flat_50"))) {
  throw new Error("home-open fixture client header profile is not the locked current-client contract");
}
const rate = Number(__ENV.K6_HOME_RATE || 1);
const warmupRate = Number(__ENV.K6_HOME_WARMUP_RATE || Math.max(1, Math.floor(rate / 2)));
const warmupSeconds = Number(__ENV.K6_HOME_WARMUP_SECONDS || 0);
const measuredSeconds = Number(__ENV.K6_HOME_MEASUREMENT_SECONDS || 120);
const ALL_SETTLED_DEADLINE_MS = 15000;
// One extra launch bucket prevents generator VU exhaustion from being mistaken
// for an SUT capacity limit when a session consumes its entire 15s budget.
const boundedSessionSeconds = 16;
const vus = Math.max(1, Math.ceil(Math.max(rate, warmupRate) * boundedSessionSeconds));
let sessionDeadlineAt = 0;
const endpointNames = ["sync-v2", "legacy-samples", "race-resolution", "legacy-steps", "home-race-card",
  "compact-races", "suggested-races", "shop-catalog", "friends-summary", "auth-me",
  "assets-manifest"];
const statusClasses = ["2xx", "3xx", "4xx", "5xx", "timeout"];
const failureReasons = ["critical", "manifest", "suggested", "resolution_not_settled", "deadline"];
const endpointThresholds = Object.fromEntries(endpointNames.flatMap((endpoint) => [
  [`http_req_duration{endpoint:${endpoint},phase:measurement}`, ["p(99)<60000"]],
  [`http_reqs{endpoint:${endpoint},phase:measurement}`, ["count>=0"]],
  ...statusClasses.map((status) =>
    [`home_open_endpoint_status{endpoint:${endpoint},status:${status},phase:measurement}`, ["count>=0"]]),
]));
const perSecondThresholds = Object.fromEntries(Array.from({ length: measuredSeconds }, (_, second) => [
  [`home_open_sessions_started{phase:measurement,second:${second}}`, ["count>=0"]],
  [`home_open_sessions_critical_complete{phase:measurement,second:${second}}`, ["count>=0"]],
  [`home_open_sessions_all_settled{phase:measurement,second:${second}}`, ["count>=0"]],
  [`home_open_sessions_failed_count{phase:measurement,second:${second}}`, ["count>=0"]],
  [`home_open_sessions_freshness_failed_count{phase:measurement,second:${second}}`, ["count>=0"]],
]).flat());
const completionThresholds = Object.fromEntries(Array.from(
  { length: measuredSeconds + boundedSessionSeconds }, (_, second) =>
    [`home_open_sessions_completed{phase:measurement,second:${second}}`, ["count>=0"]]));

function deadlineRemainingMs() { return Math.max(0, sessionDeadlineAt - Date.now()); }

export const options = {
  discardResponseBodies: false,
  // handleSummary only receives configured trend columns. Keep every report
  // percentile required by the finite-evidence gate, including p99.
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    ...(warmupSeconds > 0 ? {
      warmup: {
        executor: "constant-arrival-rate", exec: "homeOpen", rate: warmupRate,
        timeUnit: "1s", duration: `${warmupSeconds}s`, preAllocatedVUs: vus,
        maxVUs: vus, tags: { phase: "warmup" }, gracefulStop: "20s",
      },
    } : {}),
    measured: {
      executor: "constant-arrival-rate", exec: "homeOpen", rate, timeUnit: "1s",
      // Warmup arrivals stop first, then their full bounded session budget
      // drains before any measured arrival can begin.
      startTime: `${warmupSeconds > 0 ? warmupSeconds + boundedSessionSeconds : 0}s`,
      duration: `${measuredSeconds}s`,
      preAllocatedVUs: vus, maxVUs: vus, tags: { phase: "measurement" },
      gracefulStop: "20s",
    },
  },
  thresholds: {
    ...endpointThresholds,
    ...perSecondThresholds,
    ...completionThresholds,
    ...(warmupSeconds > 0 ? {
      "home_open_sessions_offered{phase:warmup}": ["count>=0"],
      "home_open_sessions_quota_rejected{phase:warmup}": ["count>=0"],
      "home_open_sessions_completed{phase:warmup}": ["count>=0"],
      "home_open_sessions_failed_count{phase:warmup}": ["count>=0"],
      "home_open_critical_ms{phase:warmup}": ["p(95)<60000"],
      "http_req_failed{phase:warmup,telemetry:sut}": ["rate<=1"],
    } : {}),
    "home_open_sessions_offered{phase:measurement}": [`count==${rate * measuredSeconds}`],
    "home_open_sessions_quota_rejected{phase:measurement}": ["count>=0"],
    "home_open_sessions_started{phase:measurement}": [`count==${rate * measuredSeconds}`],
    "home_open_sessions_critical_complete{phase:measurement}": [`count==${rate * measuredSeconds}`],
    // Resolution settlement is a freshness diagnostic. The shipped Home flow
    // renders first and polls this receipt silently in the background.
    "home_open_sessions_all_settled{phase:measurement}": ["count>=0"],
    "home_open_sessions_completed{phase:measurement}": ["count>=0"],
    "home_open_sessions_failed{phase:measurement}": ["rate<0.0000001"],
    "home_open_sessions_failed_count{phase:measurement}": ["count>=0"],
    "home_open_sessions_freshness_failed_count{phase:measurement}": ["count>=0"],
    ...Object.fromEntries(failureReasons.map((reason) =>
      [`home_open_session_failure_reason{phase:measurement,reason:${reason}}`, ["count>=0"]])),
    "home_open_sessions_late{phase:measurement}": ["count==0"],
    "home_open_critical_ms{phase:measurement}": ["p(95)<=1000", "p(99)<=2000"],
    "home_open_all_ms{phase:measurement}": ["max>=0"],
    "home_open_scheduler_lag_ms{phase:measurement}": ["max<=1000"],
    "home_open_network_errors{phase:measurement}": ["count==0"],
    "http_req_failed{phase:measurement,telemetry:sut}": ["rate<0.001"],
    "http_req_duration{endpoint:sync-v2,phase:measurement}": ["p(95)<=750", "p(99)<=1500"],
    "http_req_duration{endpoint:legacy-steps,phase:measurement}": ["p(95)<=2000", "p(99)<=5000"],
    // k6 may invoke the executor once on the duration boundary. The globally
    // unique scenario iteration quota rejects it before observer/SUT work.
    "iterations{phase:measurement}": [`count>=${rate * measuredSeconds}`],
    "dropped_iterations{phase:measurement}": ["count==0"],
    "vus{scenario:measured}": ["value>=0"],
  },
};

const offered = new Counter("home_open_sessions_offered");
const quotaRejected = new Counter("home_open_sessions_quota_rejected");
const started = new Counter("home_open_sessions_started");
const criticalComplete = new Counter("home_open_sessions_critical_complete");
const allSettled = new Counter("home_open_sessions_all_settled");
const failed = new Rate("home_open_sessions_failed");
const failedCount = new Counter("home_open_sessions_failed_count");
const freshnessFailedCount = new Counter("home_open_sessions_freshness_failed_count");
const failureReason = new Counter("home_open_session_failure_reason");
const completed = new Counter("home_open_sessions_completed");
const criticalMs = new Trend("home_open_critical_ms", true);
const allMs = new Trend("home_open_all_ms", true);
const schedulerLagMs = new Trend("home_open_scheduler_lag_ms", true);
const lateSessions = new Counter("home_open_sessions_late");
const syncRetries = new Counter("home_open_sync_retries");
const syncLegacyFallbacks = new Counter("home_open_sync_legacy_fallbacks");
const legacyStepRetries = new Counter("home_open_legacy_step_retries");
const presentationFallbacks = new Counter("home_open_presentation_fallbacks");
const friendsFallbacks = new Counter("home_open_friends_fallbacks");
const resolutionPolls = new Counter("home_open_resolution_polls");
const networkErrors = new Counter("home_open_network_errors");
const endpointStatus = new Counter("home_open_endpoint_status");

const features = Array.isArray(fixture.client?.features) ? fixture.client.features.join(",") :
  "race_payout_flat_50";

function withinPhaseQuota(iterationInInstance, phaseRate, phaseSeconds) {
  return Number.isInteger(iterationInInstance) && iterationInInstance >= 0 &&
    iterationInInstance < phaseRate * phaseSeconds;
}

function homeOpenFailureReason({ critical, manifestsOk, suggestedOk,
  resolutionSettled, withinDeadline }) {
  if (!critical) return "critical";
  if (!manifestsOk) return "manifest";
  if (!suggestedOk) return "suggested";
  if (!resolutionSettled) return "resolution_not_settled";
  if (!withinDeadline) return "deadline";
  return null;
}

function userHeaders(user, extra = {}) {
  return {
    Accept: "application/json", Authorization: `Bearer ${user.token}`,
    "X-App-Version": fixture.client.appVersion,
    "X-Client-Features": features, "X-Timezone": fixture.client.timezone,
    "X-Release-Channel": fixture.client.releaseChannel,
    "X-Platform": fixture.client.platform, "X-Capacity-Run-Id": fixture.runId,
    ...extra,
  };
}

function request(method, path, user, body = null, tags = {}, headers = {}) {
  const allowed = tags.allowedStatuses || [200];
  const cleanTags = { ...tags };
  delete cleanTags.allowedStatuses;
  return [method, `${__ENV.K6_BASE_URL}${path}`, body == null ? null : JSON.stringify(body), {
    headers: userHeaders(user, { ...(body == null ? {} : { "Content-Type": "application/json" }), ...headers }),
    tags: { endpoint: cleanTags.endpoint || path, telemetry: "sut", ...cleanTags },
    timeout: `${Math.max(100, Math.min(5000, deadlineRemainingMs()))}ms`,
    responseCallback: http.expectedStatuses(...allowed),
  }];
}

function isJsonMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(response) {
  try { return response.json(); } catch (_) { return {}; }
}

function parseMap(response) {
  try {
    const value = response.json();
    return isJsonMap(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function successful(response) { return response && response.status === 200; }
function validMap(response) { return successful(response) && parseMap(response) !== null; }
function validMe(response) {
  const body = successful(response) ? parseMap(response) : null;
  return Boolean(body && isJsonMap(body.user));
}
function validFriends(response) {
  const body = successful(response) ? parseMap(response) : null;
  return Boolean(body && Array.isArray(body.friends) && body.friends.every(isJsonMap) &&
    isJsonMap(body.pending) && Array.isArray(body.pending.incoming) &&
    Array.isArray(body.pending.outgoing));
}
function validRaces(response) {
  const body = successful(response) ? parseMap(response) : null;
  return Boolean(body && [body.active, body.pending, body.completed].every(Array.isArray));
}
function validCatalog(response) {
  const body = successful(response) ? parseMap(response) : null;
  return Boolean(body && typeof body.coins === "number" && Number.isFinite(body.coins) &&
    isJsonMap(body.equipped) && Array.isArray(body.items));
}
function observeNetwork(value) {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const failedNetwork = !row || row.status === 0;
    networkErrors.add(failedNetwork ? 1 : 0);
    const url = String(row?.url || row?.request?.url || "");
    const endpoint = endpointNames.find((name) => ({
      "sync-v2": "/steps/sync-v2", "legacy-steps": "/steps", "legacy-samples": "/steps/samples",
      "home-race-card": "/home/race-card", "compact-races": "/races", "suggested-races": "/home/suggested-races",
      "shop-catalog": "/shop/catalog", "friends-summary": "/friends", "auth-me": "/auth/me",
      "assets-manifest": "/assets/manifest", "race-resolution": "/steps/race-resolution/",
    })[name] && url.includes(({
      "sync-v2": "/steps/sync-v2", "legacy-steps": "/steps", "legacy-samples": "/steps/samples",
      "home-race-card": "/home/race-card", "compact-races": "/races", "suggested-races": "/home/suggested-races",
      "shop-catalog": "/shop/catalog", "friends-summary": "/friends", "auth-me": "/auth/me",
      "assets-manifest": "/assets/manifest", "race-resolution": "/steps/race-resolution/",
    })[name])) || "unknown";
    const status = failedNetwork ? "timeout" : `${Math.floor(row.status / 100)}xx`;
    endpointStatus.add(1, { endpoint, status });
  }
}

function classifySync(response) {
  const body = parseMap(response);
  if (!response || response.status === 0 || response.status >= 500 &&
      !(response.status === 503 && body?.code === "ASYNC_DISABLED")) {
    return { retry: true, persisted: false, legacy: false, usePersistedHome: false, job: null };
  }
  if (response.status === 404 || response.status === 503 && body?.code === "ASYNC_DISABLED") {
    return { retry: false, persisted: false, legacy: true, usePersistedHome: false, job: null };
  }
  if (response.status >= 200 && response.status < 300) {
    if (!body) return { retry: false, persisted: false, legacy: false,
      usePersistedHome: false, job: null };
    const receipt = body.raceResolution || {};
    return { retry: false, persisted: true, legacy: false,
      usePersistedHome: body.uploaderReconciliation?.state === "CURRENT",
      job: typeof receipt.jobId === "string" && Number.isInteger(receipt.generation)
        ? { id: receipt.jobId, generation: receipt.generation } : null };
  }
  if (response.status === 409) return { retry: false, persisted: true, legacy: false, usePersistedHome: false, job: null };
  return { retry: false, persisted: false, legacy: false, usePersistedHome: false, job: null };
}

function classifyRaceCard(response) {
  const body = successful(response) ? parseMap(response) : null;
  if (!body) return { presentation: false, friends: false, valid: false };
  const resolved = isJsonMap(body.resolved) ? body.resolved : null;
  const presentation = isJsonMap(body.presentation) ? body.presentation : null;
  const friends = isJsonMap(body.friends) ? body.friends : null;
  const pending = friends && isJsonMap(friends.pending) ? friends.pending : null;
  return {
    presentation: body.contract === "home-shell-v1" && resolved?.presentation === true &&
      isJsonMap(presentation) && isJsonMap(presentation.equipped) &&
      typeof presentation.coins === "number" && Number.isFinite(presentation.coins) &&
      Object.prototype.hasOwnProperty.call(presentation, "cape") &&
      (presentation.cape == null || isJsonMap(presentation.cape)),
    friends: body.contract === "home-shell-v1" && resolved?.friends === true &&
      isJsonMap(friends) && Array.isArray(friends.friends) &&
      friends.friends.every(isJsonMap) && isJsonMap(pending) &&
      Array.isArray(pending.incoming) && Array.isArray(pending.outgoing),
    valid: true,
  };
}

function uuid(user, sequence) {
  const phase = exec.scenario.name === "warmup" ? "a" : "b";
  const prefix = `${phase}${String(sequence).padStart(7, "0")}${String(user.userIndex).padStart(8, "0")}`.slice(-16);
  return `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-4000-8000-${fixture.runHash.slice(0, 12)}`;
}

function manifestRequest(user) {
  return ["GET", `${__ENV.K6_BASE_URL}/assets/manifest`, null, {
    headers: { "X-Release-Channel": fixture.client.releaseChannel },
    tags: { endpoint: "assets-manifest", telemetry: "sut" },
    timeout: `${Math.max(100, Math.min(5000, deadlineRemainingMs()))}ms`,
  }];
}

function persistedFanout(user, today, persisted) {
  const suffix = persisted ? "&homePersistedTotals=1" : "";
  return http.batch([
    request("GET", `/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=${today}${suffix}`, user, null, { endpoint: "home-race-card" }),
    request("GET", "/races?view=compact-v1", user, null, { endpoint: "compact-races" }),
    request("GET", "/auth/me?view=shell-v1", user, null, { endpoint: "auth-me" }),
  ]);
}

export async function homeOpen() {
  const scenarioRate = exec.scenario.name === "warmup" ? warmupRate : rate;
  const scenarioSeconds = exec.scenario.name === "warmup" ? warmupSeconds : measuredSeconds;
  const iterationInInstance = exec.scenario.iterationInInstance;
  // iterationInInstance is allocated uniquely for the scenario across VUs in
  // this single k6 instance, so this is an atomic phase quota without a racy
  // mutable JS global. A duration-edge invocation performs no observer or SUT
  // request and is retained separately as generator evidence.
  if (!withinPhaseQuota(iterationInInstance, scenarioRate, scenarioSeconds)) {
    quotaRejected.add(1);
    return;
  }
  const second = String(Math.floor(iterationInInstance / scenarioRate));
  const sessionId = `${exec.scenario.name}:${exec.scenario.iterationInTest}`;
  // Count latency/deadline from the open-loop scheduled launch, so generator
  // scheduling lag and synchronous observer overhead are included once.
  const scenarioStartAt = Number(exec.scenario.startTime);
  const intendedAt = (Number.isFinite(scenarioStartAt) ? scenarioStartAt : Date.now()) +
    iterationInInstance * (1000 / scenarioRate);
  const began = intendedAt;
  sessionDeadlineAt = intendedAt + ALL_SETTLED_DEADLINE_MS;
  if (__ENV.K6_HOME_INFLIGHT_URL) http.post(`${__ENV.K6_HOME_INFLIGHT_URL}/start`,
    JSON.stringify({ sessionId, phase: exec.scenario.name }), { headers: { "Content-Type": "application/json" },
      tags: { telemetry: "generator", endpoint: "inflight-observer" }, timeout: "1s" });
  offered.add(1, { second });
  started.add(1, { second });
  networkErrors.add(0);
  // constant-arrival-rate launches on the intended open-loop schedule; k6's
  // dropped_iterations records sessions that could not launch in their bucket.
  const schedulerLag = Math.max(0, Date.now() - intendedAt);
  schedulerLagMs.add(schedulerLag);
  if (schedulerLag > 1000) lateSessions.add(1);
  const sequence = exec.scenario.iterationInTest;
  const user = fixture.users[sequence % fixture.users.length];
  const today = fixture.client.localDate;
  const stableSteps = 4000 + (user.userIndex * 7919 % 12000);
  const stableSampleSteps = Math.min(stableSteps, 500 + (user.userIndex * 1543 % 3500));
  const payload = {
    date: today, steps: stableSteps,
    samples: [{ periodStart: user.sampleStart, periodEnd: user.sampleEnd,
      steps: stableSampleSteps,
      recordingMethod: "automatic", sourceName: "synthetic-health",
      sourceId: `capacity:${fixture.runId}:${user.userIndex}` }],
  };
  const key = uuid(user, sequence);
  let syncResponse = http.request(...request("POST", "/steps/sync-v2", user, payload,
    { endpoint: "sync-v2", allowedStatuses: [202, 400, 404, 409, 429, 503] }, { "Idempotency-Key": key }));
  observeNetwork(syncResponse);
  let sync = classifySync(syncResponse);
  if (sync.retry) {
    syncRetries.add(1);
    syncResponse = http.request(...request("POST", "/steps/sync-v2", user, payload,
      { endpoint: "sync-v2", allowedStatuses: [202, 400, 404, 409, 429, 503] }, { "Idempotency-Key": key }));
    observeNetwork(syncResponse);
    sync = classifySync(syncResponse);
  }
  let persisted = sync.persisted;
  if (sync.legacy) {
    syncLegacyFallbacks.add(1);
    const legacyBody = { date: today, steps: payload.steps, skipRaceResolution: true };
    let legacy = http.request(...request("POST", "/steps", user, legacyBody, { endpoint: "legacy-steps", allowedStatuses: [200, 400, 429] }));
    observeNetwork(legacy);
    if (!validMap(legacy)) {
      legacyStepRetries.add(1); sleep(1);
      legacy = http.request(...request("POST", "/steps", user, legacyBody, { endpoint: "legacy-steps", allowedStatuses: [200, 400, 429] }));
      observeNetwork(legacy);
    }
    persisted = validMap(legacy);
    if (persisted) observeNetwork(http.request(...request("POST", "/steps/samples", user,
      { samples: payload.samples }, { endpoint: "legacy-samples", critical: "false" })));
  }

  // POST /steps/sync-v2 settles before this complete Home request graph starts.
  const suffix = sync.usePersistedHome ? "&homePersistedTotals=1" : "";
  const raceCardPromise = http.asyncRequest(...request("GET",
    `/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=${today}${suffix}`,
    user, null, { endpoint: "home-race-card" }));
  const racesPromise = http.asyncRequest(...request("GET", "/races?view=compact-v1",
    user, null, { endpoint: "compact-races" }));
  const suggestedPromise = http.asyncRequest(...request("GET", "/home/suggested-races",
    user, null, { endpoint: "suggested-races", critical: "false" }));
  const raceCard = await raceCardPromise;
  observeNetwork(raceCard);
  const resolved = classifyRaceCard(raceCard);
  const manifestPromises = [];
  if (resolved.presentation) manifestPromises.push(http.asyncRequest(...manifestRequest(user)));
  const postCard = [];
  if (!resolved.presentation) {
    presentationFallbacks.add(1);
    postCard.push(http.asyncRequest(...request("GET", "/shop/catalog", user, null,
      { endpoint: "shop-catalog" })).then((response) => {
      observeNetwork(response);
      if (validCatalog(response)) manifestPromises.push(http.asyncRequest(...manifestRequest(user)));
      return { role: "presentation", response };
    }));
  }
  if (!resolved.friends) {
    friendsFallbacks.add(1);
    postCard.push(http.asyncRequest(...request("GET", "/friends?view=summary-v1", user, null,
      { endpoint: "friends-summary" })).then((response) => {
      observeNetwork(response); return { role: "friends", response };
    }));
  }
  postCard.push(http.asyncRequest(...request("GET", "/auth/me?view=shell-v1", user, null,
    { endpoint: "auth-me" })).then((response) => {
    observeNetwork(response);
    if (validMe(response)) manifestPromises.push(http.asyncRequest(...manifestRequest(user)));
    return { role: "me", response };
  }));
  const postResponses = await Promise.all(postCard);
  let presentationOk = resolved.presentation;
  let friendsOk = resolved.friends;
  let meOk = false;
  for (const { role, response } of postResponses) {
    if (role === "presentation") presentationOk = validCatalog(response);
    if (role === "friends") friendsOk = validFriends(response);
    if (role === "me") meOk = validMe(response);
  }
  const races = await racesPromise;
  observeNetwork(races);
  const critical = persisted && resolved.valid && validRaces(races) &&
    presentationOk && friendsOk && meOk;
  criticalMs.add(Date.now() - began);
  if (critical) criticalComplete.add(1, { second });

  let manifestsOk = true;
  if (manifestPromises.length) {
    const manifests = await Promise.all(manifestPromises);
    observeNetwork(manifests);
    // Manifest is best-effort for critical render, but must settle and must be
    // a 200 for the all-settled capacity contract.
    manifestsOk = check(manifests, { "Home-triggered manifests return 200": (rows) => rows.every(successful) });
  }

  let resolutionSettled = true;
  if (sync.job) {
    resolutionSettled = false;
    for (const waitSeconds of [0.75, 1.5, 3, 5]) {
      if (deadlineRemainingMs() <= waitSeconds * 1000 + 100) break;
      sleep(waitSeconds); resolutionPolls.add(1);
      const poll = http.get(`${__ENV.K6_BASE_URL}/steps/race-resolution/${sync.job.id}?generation=${sync.job.generation}`,
        { headers: userHeaders(user),
          tags: { endpoint: "race-resolution", critical: "false", telemetry: "sut" },
          timeout: `${Math.max(100, Math.min(5000, deadlineRemainingMs()))}ms`,
          responseCallback: http.expectedStatuses(200, 400, 404) });
      observeNetwork(poll);
      const state = String(parse(poll).raceResolution?.state || "").toUpperCase();
      if (state === "SUCCEEDED") {
        resolutionSettled = true;
          const replay = persistedFanout(user, today, false);
          observeNetwork(replay);
          const replayCard = classifyRaceCard(replay[0]);
          const replayValid = replayCard.valid && validRaces(replay[1]) && validMe(replay[2]);
          resolutionSettled = replayValid;
          const replayManifests = (replayCard.presentation ? 1 : 0) +
            (validMe(replay[2]) ? 1 : 0);
          if (replayManifests) {
            const rows = http.batch(Array.from({ length: replayManifests }, () => manifestRequest(user)));
            observeNetwork(rows);
            manifestsOk = manifestsOk && rows.every(successful);
          }
        break;
      }
      if (["FAILED", "SUPERSEDED", "NOT_FOUND"].includes(state) ||
          poll.status === 400 || poll.status === 404) break;
    }
  }
  const suggested = await suggestedPromise;
  observeNetwork(suggested);
  const withinDeadline = Date.now() <= sessionDeadlineAt;
  const reason = homeOpenFailureReason({ critical, manifestsOk,
    suggestedOk: successful(suggested), resolutionSettled, withinDeadline });
  const everything = reason === null;
  if (everything) allSettled.add(1, { second });
  allMs.add(Date.now() - began);
  failed.add(!critical);
  if (!critical) failedCount.add(1, { second });
  if (reason) {
    freshnessFailedCount.add(1, { second });
    failureReason.add(1, { reason });
  }
  const completionSecond = String(Math.max(0, Math.min(measuredSeconds + boundedSessionSeconds - 1,
    Math.floor((Date.now() - Number(exec.scenario.startTime || Date.now())) / 1000))));
  completed.add(1, { second: completionSecond });
  if (__ENV.K6_HOME_INFLIGHT_URL) http.post(`${__ENV.K6_HOME_INFLIGHT_URL}/end`,
    JSON.stringify({ sessionId, phase: exec.scenario.name }), { headers: { "Content-Type": "application/json" },
      tags: { telemetry: "generator", endpoint: "inflight-observer" }, timeout: "1s" });
}

export function handleSummary(data) {
  return { [__ENV.K6_SUMMARY_PATH || "home-open-k6-summary.json"]: JSON.stringify(data, null, 2) };
}
