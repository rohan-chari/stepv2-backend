import http from "k6/http";
import { check, sleep } from "k6";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { Counter, Trend } from "k6/metrics";

const scenarioName = __ENV.K6_SCENARIO || "sustained";
const scenario = {
  sustained: { rate: 100, duration: "5m" },
  headroom: { rate: 140, duration: "5m" },
  shock: { rate: 200, duration: "1m" },
}[scenarioName];
if (!scenario) throw new Error("K6_SCENARIO must be sustained, headroom, or shock");

const fixture = new SharedArray("event-open-fixture", () =>
  JSON.parse(open(__ENV.K6_FIXTURE_PATH)).users);
const baseUrl = __ENV.K6_BASE_URL || "http://127.0.0.1:3000";
const sessionsOffered = new Counter("event_open_sessions_offered");
const sessionsCompleted = new Counter("event_open_sessions_completed");
const sessionsFailed = new Counter("event_open_sessions_failed");
const latency = {
  auth: new Trend("event_open_auth_ms", true),
  device: new Trend("event_open_device_ms", true),
  activation: new Trend("event_open_activation_ms", true),
  step: new Trend("event_open_step_ms", true),
  home: new Trend("event_open_home_ms", true),
  races: new Trend("event_open_races_ms", true),
  inbox: new Trend("event_open_inbox_ms", true),
  discovery: new Trend("event_open_discovery_ms", true),
  detail: new Trend("event_open_detail_ms", true),
};

function observe(surface, response) {
  if (response) latency[surface].add(response.timings.duration);
  return response;
}
const currentClientFeatures = "characters,jammer,spinpowerups,team_races,tournaments,race_leave,powerups2,powerups3,powerups4,powerups5,stealth_runner_duration,hitchhike_effective_steps,remote_assets,remote_asset_preferred,next_race_cta,discoverable_identity,home_suggested_races,seeded_race_buckets,home_invite_modal,race_participants_paging,race_preview,privacy_safe_display_ranks,powerup_stacking_guide_v1,impact_notices,active_impact_notices_v1,resolved_impact_events_v2,impact_summaries,impact_summary_expiry_v1,review_prompt,inbox_v1,privateJoinApproval,api_payload_compact_v1,referral_contest_v1,referral_contest_global_v1,admin_metrics_v2";

export const options = {
  // A VU represents successive independent app opens, not one phone changing
  // identity between iterations. Keep each launch graph on its own connection
  // so cluster distribution matches thousands of distinct devices.
  noVUConnectionReuse: true,
  scenarios: {
    event_open: {
      executor: "constant-arrival-rate",
      rate: scenario.rate,
      timeUnit: "1s",
      duration: scenario.duration,
      preAllocatedVUs: 500,
      maxVUs: 2000,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    "http_req_duration{class:interactive}": ["p(95)<500", "p(99)<1000"],
    "http_req_duration{class:sync-v2}": ["p(95)<750", "p(99)<1500"],
    "http_req_duration{class:legacy-step}": ["p(95)<2000", "p(99)<5000"],
    event_open_sessions_failed: ["count==0"],
  },
};

function jsonHeaders(user, legacy = false) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${user.token}`,
    "X-App-Version": legacy ? "1.1.0" : "2.3.8",
    ...(legacy ? {} : { "X-Client-Features": currentClientFeatures }),
    "X-Capacity-Run-Id": __ENV.CAPACITY_RUN_ID,
    "X-Capacity-Repeat": __ENV.CAPACITY_REPEAT || "1",
  };
}

function request(method, path, user, body = null, tags = { class: "interactive" }, headers = {}, legacy = false) {
  return {
    method,
    url: `${baseUrl}${path}`,
    body: body == null ? null : JSON.stringify(body),
    params: { headers: { ...jsonHeaders(user, legacy), ...headers }, tags: { ...tags, name: `${method} ${path}` } },
  };
}

function canonicalIdempotencyKey(prefix, sequence) {
  const hex = `${prefix}${Number(sequence).toString(16).padStart(9, "0").slice(-9)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export default function () {
  sessionsOffered.add(1);
  const sequence = exec.scenario.iterationInTest;
  const user = fixture[sequence % fixture.length];
  const bucket = sequence % 100;
  const legacyClient = bucket < 36;
  const authPath = legacyClient ? "/auth/me" : "/auth/session?view=shell-v1";
  const auth = http.get(`${baseUrl}${authPath}`, {
    headers: jsonHeaders(user, legacyClient), tags: { class: "interactive", name: `GET ${authPath}` },
  });
  observe("auth", auth);
  if (!check(auth, { "auth 200": (response) => response.status === 200 })) {
    sessionsFailed.add(1);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const sampleSteps = 6000 + user.userIndex * 100 + Math.floor(sequence / fixture.length);
  const sample = {
    periodStart: user.sampleStart, periodEnd: user.sampleEnd, steps: sampleSteps,
    recordingMethod: "automatic", sourceName: "synthetic-health",
    sourceId: `k6:${__ENV.CAPACITY_RUN_ID}:${user.userIndex}`,
  };
  let stepRequest;
  if (bucket < 18) {
    stepRequest = request("POST", "/steps", user, { steps: 1000 + sequence, date: today, skipRaceResolution: true }, { class: "legacy-step" }, {}, true);
  } else if (bucket < 36) {
    stepRequest = request("POST", "/steps/samples", user, { samples: [sample] }, { class: "legacy-step" }, {}, true);
  } else {
    stepRequest = request("POST", "/steps/sync-v2", user,
      { date: today, steps: 1000 + sequence, samples: [sample] },
      { class: "sync-v2" }, { "Idempotency-Key": canonicalIdempotencyKey(user.idempotencyPrefix, sequence) }, false);
  }
  const raceRead = bucket < 36
    ? request("GET", `/races/${user.raceId}/progress`, user, null,
      { class: "interactive" }, {}, true)
    : request("GET", `/races/${user.raceId}/bootstrap?view=participants-v1&offset=0&limit=15&shape=compact-v1`, user, null,
      { class: "interactive" });
  const homePath = legacyClient
    ? "/home/race-card"
    : `/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=${today}&homePersistedTotals=1`;
  const racesPath = legacyClient ? "/races" : "/races?view=compact-v1";
  const backgroundWrites = [
    request("POST", "/notifications/device-token", user, {
      deviceToken: `capacity-${__ENV.CAPACITY_RUN_ID}-${user.userIndex}`, platform: "ios",
      installationId: `capacity.${__ENV.CAPACITY_RUN_ID}.${user.userIndex}`.slice(0, 128),
    }, { class: "interactive" }, {}, legacyClient),
    request("POST", "/analytics/activation-events", user, { events: [{
      id: user.activationId, name: "home_reached", timestamp: new Date().toISOString(),
      appVersion: "2.3.8", platform: "ios", context: {},
    }] }, { class: "interactive" }, {}, legacyClient),
  ];
  const primaryReads = [
    request("GET", homePath, user, null, { class: "interactive" }, {}, legacyClient),
    request("GET", racesPath, user, null, { class: "interactive" }, {}, legacyClient),
    ...(legacyClient ? [] : [request("GET", "/inbox/alerts", user, null,
      { class: "interactive" })]),
  ];
  const secondaryReads = [];
  // These are navigation follow-ons, not MainShell startup requirements. Keep
  // statistically meaningful coverage (4,200 discovery and 420 detail opens
  // in the five-minute headroom gate) without pretending half of a launch wave
  // explicitly opens a potentially 10,000-person legacy race roster.
  if (sequence % 10 === 0) {
    secondaryReads.push(request("GET", "/races/discovery-summary", user, null,
      { class: "interactive" }, {}, legacyClient));
  }
  if (sequence % 100 === 0) secondaryReads.push(raceRead);

  // Match the shipped client's staged cold-start graph: session/auth first,
  // lightweight telemetry beside device registration, step persistence before
  // the home surfaces, then non-visible discovery/detail work after first
  // paint. This retains the complete endpoint graph without manufacturing an
  // eight-request per-user database stampede that the app never sends.
  const responses = http.batch(backgroundWrites);
  observe("device", responses[0]);
  observe("activation", responses[1]);
  const stepResponse = http.request(
    stepRequest.method, stepRequest.url, stepRequest.body, stepRequest.params,
  );
  responses.push(stepResponse);
  observe("step", stepResponse);
  const primaryResponses = http.batch(primaryReads);
  observe("home", primaryResponses[0]);
  observe("races", primaryResponses[1]);
  if (!legacyClient) observe("inbox", primaryResponses[2]);
  responses.push(...primaryResponses);
  sleep(0.25);
  if (secondaryReads.length) {
    const secondaryResponses = http.batch(secondaryReads);
    observe("discovery", secondaryResponses[0]);
    if (secondaryResponses.length > 1) observe("detail", secondaryResponses[1]);
    responses.push(...secondaryResponses);
  }
  const complete = responses.every((response) => response.status >= 200 && response.status < 300);
  if (complete) sessionsCompleted.add(1);
  else sessionsFailed.add(1);
}

export function handleSummary(data) {
  return { [__ENV.K6_SUMMARY_PATH || "event-open-k6-summary.json"]: JSON.stringify(data, null, 2) };
}
