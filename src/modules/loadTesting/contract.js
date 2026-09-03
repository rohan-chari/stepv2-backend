const crypto = require("node:crypto");
const net = require("node:net");
const {
  PROJECTION_VERSION: RACES_TAB_PROJECTION_VERSION,
  REQUIRED_COVERAGE_VARIANTS: RACES_TAB_REQUIRED_COVERAGE_VARIANTS,
} = require("./racesTabOpenProjection");

const RESULT_SCHEMA = "load-test-result-v1";
const PROFILE_SCHEMA = "load-profile-v1";
const CURRENT_IOS_CLIENT_FEATURES = Object.freeze([
  "characters", "ads", "ad_coin_random", "jammer", "spinpowerups", "team_races",
  "tournaments", "race_leave", "powerups2", "powerups3", "powerups4", "powerups5",
  "stealth_runner_duration", "hitchhike_effective_steps", "remote_assets",
  "remote_asset_preferred", "next_race_cta", "discoverable_identity",
  "home_suggested_races", "seeded_race_buckets", "home_invite_modal",
  "race_participants_paging", "race_preview", "privacy_safe_display_ranks",
  "powerup_stacking_guide_v1", "impact_notices", "active_impact_notices_v1",
  "resolved_impact_events_v2", "impact_summaries", "impact_summary_expiry_v1",
  "review_prompt", "inbox_v1", "privateJoinApproval", "api_payload_compact_v1",
  "referral_contest_v1", "referral_contest_global_v1", "admin_metrics_v2",
  "race_payout_flat_50",
]);
const PROFILES = Object.freeze(buildProfiles());

function entry(method, path, options = {}) {
  return Object.freeze({
    method,
    path,
    query: options.query || null,
    headers: Object.freeze(options.headers || {}),
    payloadShape: options.payloadShape || null,
    fixturePrerequisites: Object.freeze(options.fixturePrerequisites || []),
    allowedStatuses: Object.freeze(options.allowedStatuses || [200]),
    weight: options.weight ?? 1,
    persona: options.persona || "current",
    readOnly: options.readOnly !== false,
    disposableWrite: options.disposableWrite === true,
    queue: options.queue === true,
  });
}

function buildProfiles() {
  const health = entry("GET", "/health", { allowedStatuses: [200], weight: 1, persona: "current" });
  const authMe = entry("GET", "/auth/me", { allowedStatuses: [200], fixturePrerequisites: ["synthetic-user"] });
  const home = [
    entry("GET", "/home/race-card", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "characters,remote_assets,inbox_v1" }, weight: 20 }),
    entry("GET", "/races", { query: "view=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "characters,remote_assets,api_payload_compact_v1,race_participants_paging" }, weight: 12 }),
    entry("GET", "/friends", { fixturePrerequisites: ["synthetic-user"], weight: 8 }),
    entry("GET", "/friends/steps", { fixturePrerequisites: ["synthetic-user"], weight: 5 }),
    entry("GET", "/auth/me", { fixturePrerequisites: ["synthetic-user"], weight: 3 }),
    entry("GET", "/steps", { query: "date={{today}}", fixturePrerequisites: ["synthetic-user"], weight: 4 }),
    entry("POST", "/steps/sync-v2", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Step-Sync-Intent": "home-pull" }, payloadShape: { steps: "integer", samples: "bounded-array", clientRequestId: "deterministic" }, allowedStatuses: [202, 400, 409, 429, 503], weight: 4, readOnly: false, disposableWrite: true, persona: "current", queue: true }),
    entry("POST", "/steps", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { steps: "integer", date: "YYYY-MM-DD", skipRaceResolution: true }, allowedStatuses: [200, 400, 429], weight: 2, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
    entry("POST", "/steps/samples", { fixturePrerequisites: ["synthetic-user"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { samples: "bounded-realistic-window" }, allowedStatuses: [200, 400, 429], weight: 2, readOnly: false, disposableWrite: true, persona: "legacy" }),
  ];
  const races = [
    entry("GET", "/races/discovery-summary", { fixturePrerequisites: ["synthetic-user"], weight: 9 }),
    entry("GET", "/races", { query: "view=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], weight: 15 }),
    entry("GET", "/home/suggested-races", { fixturePrerequisites: ["synthetic-user"], weight: 5 }),
    entry("GET", "/friends", { fixturePrerequisites: ["synthetic-user"], weight: 4 }),
    entry("GET", "/races", { query: "legacyFallback=1", fixturePrerequisites: ["synthetic-user"], headers: { "X-App-Version": "1.1.0" }, weight: 3, persona: "legacy" }),
  ];
  const details = [
    entry("GET", "/races/:raceId/bootstrap", { query: "view=participants-v1&offset=0&limit=15&shape=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "race_participants_paging,powerups4,api_payload_compact_v1" }, allowedStatuses: [200, 404], weight: 12 }),
    entry("GET", "/races/:raceId/progress", { fixturePrerequisites: ["synthetic-user", "active-race"], weight: 10, persona: "legacy" }),
    entry("GET", "/races/:raceId/progress", { query: "view=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "race_participants_paging,api_payload_compact_v1" }, weight: 8 }),
    entry("GET", "/races/:raceId/message-streams", { query: "limit=20&includeUser=true&view=conditional-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "inbox_v1,api_payload_compact_v1" }, allowedStatuses: [200, 404], weight: 5 }),
    entry("GET", "/races/:raceId/inventory", { fixturePrerequisites: ["synthetic-user", "active-race"], weight: 5 }),
    entry("GET", "/races/:raceId/powerups/use-context", { fixturePrerequisites: ["synthetic-user", "active-race"], weight: 4 }),
    entry("GET", "/races/:raceId/feed", { query: "limit=20", fixturePrerequisites: ["synthetic-user", "active-race"], weight: 4 }),
    entry("GET", "/races/:raceId/messages", { query: "kind=USER&limit=20", fixturePrerequisites: ["synthetic-user", "active-race"], weight: 4 }),
    entry("GET", "/races/:raceId/active-impact-notices", { fixturePrerequisites: ["synthetic-user", "active-race"], allowedStatuses: [200, 404], weight: 3 }),
    entry("GET", "/races/:raceId/impact-notices", { fixturePrerequisites: ["synthetic-user", "active-race"], allowedStatuses: [200, 404], weight: 3 }),
    entry("GET", "/races/:raceId/private-impact-feed", { fixturePrerequisites: ["synthetic-user", "active-race"], allowedStatuses: [200, 404], weight: 3 }),
    entry("GET", "/races/:raceId", { fixturePrerequisites: ["synthetic-user", "active-race"], weight: 3 }),
  ];
  const queue = [
    entry("GET", "/steps/race-resolution/:jobId", { query: "generation={{generation}}", fixturePrerequisites: ["synthetic-user", "queue-job"], allowedStatuses: [200, 400, 404], weight: 2, queue: true }),
  ];
  const contention = [
    entry("POST", "/steps/sync-v2", { fixturePrerequisites: ["synthetic-user", "active-race"], payloadShape: { steps: "integer", samples: "bounded-array", clientRequestId: "deterministic" }, allowedStatuses: [202, 400, 409, 429, 503], weight: 5, readOnly: false, disposableWrite: true, persona: "current", queue: true }),
    entry("POST", "/steps", { fixturePrerequisites: ["synthetic-user", "active-race"], payloadShape: { steps: "integer", date: "YYYY-MM-DD", skipRaceResolution: true }, allowedStatuses: [200, 400, 429], weight: 3, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
    entry("POST", "/steps/samples", { fixturePrerequisites: ["synthetic-user"], payloadShape: { samples: "bounded-realistic-window" }, allowedStatuses: [200, 400, 429], weight: 2, readOnly: false, disposableWrite: true, persona: "legacy" }),
  ];
  const profile = (name, entries, limits = {}) => Object.freeze({
    schema: PROFILE_SCHEMA,
    version: "1.0.0",
    name,
    fixtureRaces: limits.fixtureRaces || 1,
    ambiguousRetryEvery: limits.ambiguousRetryEvery || null,
    defaults: Object.freeze({
      users: limits.defaultUsers || (name === "smoke" ? 1 : 25),
      duration: limits.defaultDuration || "300s",
      arrivalRatePerSecond: limits.defaultArrivalRatePerSecond || 10,
      concurrency: limits.defaultConcurrency || null,
    }),
    limits: Object.freeze({ maxUsers: limits.maxUsers || 5000, maxDurationSeconds: limits.maxDurationSeconds || 3600, maxArrivalRatePerSecond: limits.maxArrivalRatePerSecond || 500 }),
    entries: Object.freeze(entries),
    queue: Object.freeze({ arrivalRatePerSecond: 2, payloadDistribution: "1-8 samples per sync", retrySameKey: "one deterministic duplicate only", workerServiceRatePerSecond: 2, lagThresholdMs: 30000, drainCriteria: "queued=0 and running=0", ...(limits.queue || {}) }),
    ...(limits.eventReliability ? {
      eventReliability: Object.freeze({
        fixtureUsers: 10_000,
        warmupSeconds: 120,
        measurementSeconds: 600,
        repetitions: 3,
        background: Object.freeze({
          authenticatedHttpPerSecond: 25,
          resolutionJobsPerSecond: 50,
        }),
        ...limits.eventReliability,
      }),
    } : {}),
  });
  const eventTraffic = [
    entry("GET", "/auth/me", {
      fixturePrerequisites: ["synthetic-user"], weight: 1,
    }),
  ];
  const eventOpenTraffic = [
    entry("GET", "/auth/me", { fixturePrerequisites: ["synthetic-user"], weight: 100 }),
    entry("POST", "/notifications/device-token", { fixturePrerequisites: ["synthetic-user"], payloadShape: { deviceToken: "synthetic", platform: "ios", installationId: "deterministic" }, allowedStatuses: [200], weight: 100, readOnly: false, disposableWrite: true }),
    entry("POST", "/analytics/activation-events", { fixturePrerequisites: ["synthetic-user"], payloadShape: { events: "app-open" }, allowedStatuses: [202], weight: 100, readOnly: false, disposableWrite: true }),
    entry("POST", "/steps", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { steps: "integer", date: "YYYY-MM-DD", skipRaceResolution: true }, allowedStatuses: [200, 400, 500], weight: 18, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
    entry("POST", "/steps/samples", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { samples: "bounded-realistic-window" }, allowedStatuses: [200, 400, 500], weight: 18, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
    entry("POST", "/steps/sync-v2", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Step-Sync-Intent": "home-pull" }, payloadShape: { steps: "integer", samples: "bounded-array", clientRequestId: "deterministic" }, allowedStatuses: [202, 400, 409, 429, 500, 503], weight: 64, readOnly: false, disposableWrite: true, persona: "current", queue: true }),
    entry("GET", "/home/race-card", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "characters,remote_assets,inbox_v1" }, weight: 100 }),
    entry("GET", "/races/discovery-summary", { fixturePrerequisites: ["synthetic-user"], weight: 100 }),
    entry("GET", "/races", { query: "view=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "characters,remote_assets,api_payload_compact_v1,race_participants_paging" }, weight: 100 }),
    entry("GET", "/inbox/alerts", { fixturePrerequisites: ["synthetic-user"], headers: { "X-Client-Features": "inbox_v1" }, allowedStatuses: [200, 404], weight: 100 }),
    entry("GET", "/races/:raceId/progress", { fixturePrerequisites: ["synthetic-user", "active-race"], weight: 100 }),
    entry("GET", "/races/:raceId/bootstrap", { query: "view=participants-v1&offset=0&limit=15&shape=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-Client-Features": "race_participants_paging,powerups4,api_payload_compact_v1" }, allowedStatuses: [200, 404], weight: 100 }),
  ];
  const homeOpenTraffic = [
    entry("POST", "/steps/sync-v2", {
      fixturePrerequisites: ["synthetic-user", "active-race"],
      payloadShape: { date: "YYYY-MM-DD", steps: "integer", samples: "bounded-array" },
      allowedStatuses: [202, 400, 404, 409, 429, 503], readOnly: false,
      disposableWrite: true, queue: true,
    }),
    entry("POST", "/steps", {
      fixturePrerequisites: ["synthetic-user", "active-race"],
      payloadShape: { steps: "integer", date: "YYYY-MM-DD", skipRaceResolution: true },
      allowedStatuses: [200, 400, 429], readOnly: false, disposableWrite: true,
      persona: "legacy", queue: true,
    }),
    entry("POST", "/steps/samples", {
      fixturePrerequisites: ["synthetic-user"],
      payloadShape: { samples: "bounded-realistic-window" },
      allowedStatuses: [200, 400, 429], readOnly: false, disposableWrite: true,
      persona: "legacy",
    }),
    entry("GET", "/home/race-card", {
      query: "view=shell-v1&homeActiveRaces=1&localDate={{today}}",
      fixturePrerequisites: ["synthetic-user", "active-race"],
    }),
    entry("GET", "/races", { query: "view=compact-v1", fixturePrerequisites: ["synthetic-user", "active-race"] }),
    entry("GET", "/home/suggested-races", { fixturePrerequisites: ["synthetic-user"] }),
    entry("GET", "/shop/catalog", { fixturePrerequisites: ["synthetic-user"] }),
    entry("GET", "/friends", { query: "view=summary-v1", fixturePrerequisites: ["synthetic-user"] }),
    entry("GET", "/auth/me", { query: "view=shell-v1", fixturePrerequisites: ["synthetic-user"] }),
    entry("GET", "/assets/manifest", { headers: { "X-Release-Channel": "prod" }, fixturePrerequisites: [] }),
    entry("GET", "/steps/race-resolution/:jobId", {
      query: "generation={{generation}}", fixturePrerequisites: ["synthetic-user", "queue-job"],
      allowedStatuses: [200, 400, 404], queue: true,
    }),
    entry("GET", "/home/global-event-summary-work/:workId", {
      fixturePrerequisites: ["synthetic-user", "global-summary-work"],
      allowedStatuses: [200], queue: true,
    }),
  ];
  const racesTabOpenTraffic = [
    entry("GET", "/races", {
      query: "view=compact-v1", fixturePrerequisites: ["synthetic-user"],
    }),
    entry("GET", "/races/discovery-summary", {
      fixturePrerequisites: ["synthetic-user"],
    }),
    entry("GET", "/friends", {
      query: "view=summary-v1", fixturePrerequisites: ["synthetic-user", "zero-friends"],
    }),
  ];
  return {
    smoke: profile("smoke", [health, authMe, home[0], races[1]], { maxUsers: 2, maxDurationSeconds: 60, maxArrivalRatePerSecond: 10 }),
    home: profile("home", home),
    races: profile("races", races),
    "race-details": profile("race-details", details),
    "full-app": profile("full-app", [health, ...home, ...races, ...details, ...queue]),
    contention: profile("contention", contention, { maxUsers: 100, maxDurationSeconds: 600, maxArrivalRatePerSecond: 100, queue: { workerServiceRatePerSecond: 5 } }),
    "event-open-surge": Object.freeze({
      ...profile("event-open-surge", eventOpenTraffic, {
        fixtureRaces: 3,
        defaultUsers: 10_000,
        defaultDuration: "300s",
        defaultArrivalRatePerSecond: 100,
        defaultConcurrency: 1000,
        maxUsers: 10_000,
        maxDurationSeconds: 600,
        maxArrivalRatePerSecond: 200,
        queue: { workerServiceRatePerSecond: 100, lagThresholdMs: 30_000 },
      }),
      surgeGate: Object.freeze({
        incidentEligibleCohort: 517,
        sustainedSessionsPerSecond: 100,
        sustainedSeconds: 300,
        shockSessionsPerSecond: 200,
        shockSeconds: 60,
        scaleMultiplier: 10,
        requiredHeadroom: 0.4,
        poolBudget: Object.freeze({ http0: 10, http1: 10, resolution: 8, cron: 4, total: 32 }),
      }),
      eventOpenFixture: Object.freeze({
        fixtureUsers: 10_000,
        warmupSeconds: 120,
        timezone: "America/New_York",
        activatesBoundary: true,
        deterministicProvider: true,
      }),
    }),
    "home-open": Object.freeze({
      ...profile("home-open", homeOpenTraffic, {
        fixtureRaces: 20,
        defaultUsers: 5000,
        defaultDuration: "600s",
        defaultArrivalRatePerSecond: 1,
        defaultConcurrency: 5000,
        maxUsers: 5000,
        maxDurationSeconds: 900,
        maxArrivalRatePerSecond: 500,
        queue: { workerServiceRatePerSecond: 500, lagThresholdMs: 30_000 },
      }),
      version: "2.3.0",
      ladder: Object.freeze({
        smoke: Object.freeze({ rate: 1, seconds: 120 }),
        warmupSeconds: 120,
        measurementSeconds: 600,
        rates: Object.freeze([2, 5, 10, 20, 30, 40, 60, 80, 100, 150, 225, 340, 500]),
        hardCap: 500,
        boundaryRepeats: 3,
      }),
      homeOpen: Object.freeze({
        schema: "home-open-session-v1",
        clientHeaderProfile: "current-home-2.3.11-ios-v1",
        clientFeatures: CURRENT_IOS_CLIENT_FEATURES,
        arrivalBucketMs: 1000,
        allSettledDeadlineMs: 15_000,
        resolutionPollWaitMs: Object.freeze([750, 1500, 3000, 5000]),
        globalSummaryPollWaitMs: Object.freeze([750, 1500, 3000, 5000]),
        suggestedRaces404Policy: "contract-failure-no-legacy-fanout",
        criticalEndpoints: Object.freeze([
          "POST /steps/sync-v2", "POST /steps", "GET /home/race-card",
          "GET /races", "GET /shop/catalog", "GET /friends", "GET /auth/me",
        ]),
      }),
    }),
    "races-tab-open": Object.freeze({
      ...profile("races-tab-open", racesTabOpenTraffic, {
        fixtureRaces: 20,
        defaultUsers: 5000,
        defaultDuration: "600s",
        defaultArrivalRatePerSecond: 5,
        defaultConcurrency: 5000,
        maxUsers: 5000,
        maxDurationSeconds: 900,
        maxArrivalRatePerSecond: 500,
        queue: { workerServiceRatePerSecond: 500, lagThresholdMs: 30_000 },
      }),
      version: "2.0.0",
      racesTabOpen: Object.freeze({
        schema: "races-tab-open-session-v2",
        expectedProjectionVersion: RACES_TAB_PROJECTION_VERSION,
        requiredCoverageVariants: RACES_TAB_REQUIRED_COVERAGE_VARIANTS,
        clientHeaderProfile: "current-races-2.3.11-ios-v1",
        clientFeatures: CURRENT_IOS_CLIENT_FEATURES,
        requestTimeoutMs: 15_000,
        iterationDeadlineMs: 31_000,
        gracefulStopMs: 32_000,
        friendsSelection: "fixture-zero-friends",
        friendsCacheAgeMs: 5_000,
        discovery404Policy: "contract-failure-no-legacy-fanout",
      }),
    }),
    "frozen-step-sync-burst": profile(
      "frozen-step-sync-burst",
      [
        entry("POST", "/steps", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { steps: "integer", date: "YYYY-MM-DD", skipRaceResolution: true }, allowedStatuses: [200, 400, 429], weight: 1, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
        entry("POST", "/steps/samples", { fixturePrerequisites: ["synthetic-user", "active-race"], headers: { "X-App-Version": "1.1.0" }, payloadShape: { samples: "bounded-realistic-window" }, allowedStatuses: [200, 400, 429], weight: 1, readOnly: false, disposableWrite: true, persona: "legacy", queue: true }),
      ],
      {
        fixtureRaces: 3,
        defaultUsers: 100,
        defaultDuration: "60s",
        defaultArrivalRatePerSecond: 15.2,
        defaultConcurrency: 100,
        maxUsers: 500,
        maxDurationSeconds: 120,
        maxArrivalRatePerSecond: 50,
        queue: { payloadDistribution: "456 paired legacy cycles in one minute", workerServiceRatePerSecond: 5 },
      }
    ),
    "current-step-sync-burst": profile(
      "current-step-sync-burst",
      [
        entry("POST", "/steps/sync-v2", { fixturePrerequisites: ["synthetic-user", "active-race"], payloadShape: { steps: "integer", samples: "bounded-array", clientRequestId: "deterministic" }, allowedStatuses: [202, 400, 409, 429, 503], weight: 1, readOnly: false, disposableWrite: true, persona: "current", queue: true }),
      ],
      {
        fixtureRaces: 3,
        ambiguousRetryEvery: 20,
        defaultUsers: 100,
        defaultDuration: "60s",
        // 480 total writes = approximately 456 logical cycles plus 5% exact
        // same-key/body ambiguous replays.
        defaultArrivalRatePerSecond: 8,
        defaultConcurrency: 100,
        maxUsers: 500,
        maxDurationSeconds: 120,
        maxArrivalRatePerSecond: 50,
        queue: { retrySameKey: "every twentieth request exactly replays the previous same-user key/body", workerServiceRatePerSecond: 5 },
      }
    ),
    event_provisioning_10000: profile(
      "event_provisioning_10000",
      eventTraffic,
      {
        defaultUsers: 10_000,
        defaultDuration: "720s",
        defaultArrivalRatePerSecond: 75,
        defaultConcurrency: 100,
        fixtureRaces: 3,
        maxUsers: 10_000,
        maxDurationSeconds: 720,
        maxArrivalRatePerSecond: 100,
        eventReliability: {
          kind: "PROVISIONING",
          deadlineSeconds: 600,
          projectionDeadlineSeconds: 300,
          minimumLeadSeconds: 12 * 60 * 60,
          planningHorizonSeconds: 36 * 60 * 60,
        },
      },
    ),
    event_boundary_10000: profile(
      "event_boundary_10000",
      eventTraffic,
      {
        defaultUsers: 10_000,
        defaultDuration: "720s",
        defaultArrivalRatePerSecond: 75,
        defaultConcurrency: 1000,
        fixtureRaces: 3,
        maxUsers: 10_000,
        maxDurationSeconds: 720,
        maxArrivalRatePerSecond: 100,
        eventReliability: { kind: "HEALTHY_BOUNDARY" },
      },
    ),
    event_provider_outage_10000: profile(
      "event_provider_outage_10000",
      eventTraffic,
      {
        defaultUsers: 10_000,
        defaultDuration: "720s",
        defaultArrivalRatePerSecond: 75,
        defaultConcurrency: 100,
        fixtureRaces: 3,
        maxUsers: 10_000,
        maxDurationSeconds: 720,
        maxArrivalRatePerSecond: 100,
        eventReliability: { kind: "PROVIDER_OUTAGE", outageSeconds: 60 },
      },
    ),
  };
}

function validateProfileRegistry(registry = PROFILES) {
  const names = ["smoke", "home", "races", "race-details", "full-app", "contention", "event-open-surge", "home-open", "races-tab-open", "frozen-step-sync-burst", "current-step-sync-burst", "event_provisioning_10000", "event_boundary_10000", "event_provider_outage_10000"];
  for (const name of names) {
    const profile = registry[name];
    const expectedVersion = name === "home-open" ? "2.3.0" :
      name === "races-tab-open" ? "2.0.0" : "1.0.0";
    if (!profile || profile.schema !== PROFILE_SCHEMA || profile.version !== expectedVersion || profile.name !== name || !profile.entries.length) throw new Error(`invalid load profile: ${name}`);
    for (const item of profile.entries) {
      if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(item.method) || !item.path.startsWith("/")) throw new Error(`invalid load profile path: ${name}`);
      if (!Number.isFinite(item.weight) || item.weight < 0 || item.weight > 100) throw new Error(`invalid load profile weight: ${name}`);
      if (!Array.isArray(item.allowedStatuses) || item.allowedStatuses.some((status) => !Number.isInteger(status))) throw new Error(`invalid load profile statuses: ${name}`);
      if (!["legacy", "current"].includes(item.persona)) throw new Error(`invalid load profile persona: ${name}`);
      if (!item.readOnly && !item.disposableWrite) throw new Error(`non-disposable write in load profile: ${name}`);
    }
    if (profile.eventReliability) {
      const event = profile.eventReliability;
      if (event.fixtureUsers !== 10_000 || event.warmupSeconds !== 120 ||
          event.measurementSeconds !== 600 || event.repetitions !== 3 ||
          event.background?.authenticatedHttpPerSecond !== 25 ||
          event.background?.resolutionJobsPerSecond !== 50) {
        throw new Error(`invalid global-event capacity contract: ${name}`);
      }
    }
  }
  return true;
}

function parseDuration(value, fallback = "300s") {
  const match = String(value ?? fallback).trim().match(/^(\d+(?:\.\d+)?)(s|m|h)$/i);
  if (!match) throw new Error("duration must use Ns, Nm, or Nh");
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2].toLowerCase()]);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error("duration must be between 1 second and 1 hour");
  return Math.ceil(seconds);
}

function boundedInt(value, name, min, max, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return parsed;
}

function parseLoadParameters(options = {}) {
  const profile = String(options.profile || "");
  if (!PROFILES[profile]) throw new Error(`unknown profile: ${profile || "(missing)"}`);
  const config = PROFILES[profile];
  const users = boundedInt(options.users, "users", 1, config.limits.maxUsers, config.defaults.users);
  const durationSeconds = parseDuration(options.duration, config.defaults.duration);
  if (durationSeconds > config.limits.maxDurationSeconds) throw new Error(`duration exceeds ${profile} profile limit`);
  const arrivalRatePerSecond = Number(options.arrivalRate === undefined ? config.defaults.arrivalRatePerSecond : options.arrivalRate);
  if (!Number.isFinite(arrivalRatePerSecond) || arrivalRatePerSecond <= 0 || arrivalRatePerSecond > config.limits.maxArrivalRatePerSecond) throw new Error(`arrivalRate must be greater than 0 and at most ${config.limits.maxArrivalRatePerSecond}`);
  const timeoutMs = boundedInt(options.timeoutMs, "timeoutMs", 100, 30000, 5000);
  const concurrency = boundedInt(options.concurrency, "concurrency", 1, Math.min(1000, config.limits.maxUsers), config.defaults.concurrency || Math.min(users, 25));
  return { profile, users, arrivalRatePerSecond, durationSeconds, timeoutMs, concurrency };
}

function normalizeHost(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

function isPrivateHost(value) {
  const host = String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  if (net.isIPv4(host)) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 169 && octets[1] === 254);
  }
  return net.isIPv6(host) && (host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host));
}

function classifyTarget({ target, baseUrl, databaseUrl } = {}) {
  if (target !== "capacity-vm") throw new Error("explicit target declaration capacity-vm is required");
  if (!baseUrl) throw new Error("approved capacity baseUrl is required");
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error("approved capacity baseUrl must be a URL"); }
  const host = normalizeHost(baseUrl);
  if (!/^https?:$/.test(parsed.protocol) || !host || /(^|[.-])(prod|production|steptracker-api\.org)([.-]|$)/i.test(host)) throw new Error("production or unapproved capacity target rejected");
  if (!/^((10|127)\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|\[?::1\]?$)/.test(host)) throw new Error("capacity target must be a private or loopback host");
  if (databaseUrl) {
    let db;
    try { db = new URL(databaseUrl); } catch { throw new Error("database URL must be valid"); }
    const name = decodeURIComponent(db.pathname.slice(1)).toLowerCase();
    if (!isPrivateHost(db.hostname)) throw new Error("capacity database target must use a private or loopback host");
    if (!name || /(^|[_-])(prod|production|steptracker)([_-]|$)/i.test(name) || /prod|production/i.test(db.hostname)) throw new Error("production database target rejected");
    if (!/(^|[_-])(capacity|test)([_-]|$)/.test(name)) throw new Error("database name must identify a capacity or test database");
  }
  return { kind: "capacity-vm", host, baseUrl: `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}` };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] || 0;
}

function buildResult({ runId, target, baseUrl, commit = null, profile, profileVersion = PROFILES[profile]?.version || null, startedAt, endedAt, parameters, samples = [], safety = {}, queue = {}, infrastructure = {} }) {
  const elapsedSeconds = Math.max(0.001, (new Date(endedAt) - new Date(startedAt)) / 1000);
  const endpoints = {};
  for (const sample of samples) {
    const key = sample.endpoint;
    const bucket = endpoints[key] ||= { requests: 0, status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, timeout: 0, unexpected: 0 }, latencyMs: { p50: 0, p95: 0, p99: 0 }, _latencies: [] };
    bucket.requests += 1;
    if (sample.timeout) bucket.status.timeout += 1;
    else bucket.status[`${Math.floor(sample.status / 100)}xx`] = (bucket.status[`${Math.floor(sample.status / 100)}xx`] || 0) + 1;
    if (sample.unexpectedStatus) bucket.status.unexpected += 1;
    bucket._latencies.push(Number(sample.latencyMs) || 0);
  }
  const requestCount = samples.length;
  let errorCount = 0;
  for (const bucket of Object.values(endpoints)) {
    errorCount += bucket.status.timeout + bucket.status["5xx"] + bucket.status.unexpected;
    bucket.latencyMs = { p50: percentile(bucket._latencies, 50), p95: percentile(bucket._latencies, 95), p99: percentile(bucket._latencies, 99) };
    delete bucket._latencies;
  }
  const personas = { legacy: samples.filter((sample) => sample.persona === "legacy").length, current: samples.filter((sample) => sample.persona === "current").length };
  return redactResult({ schema: RESULT_SCHEMA, runId, target, baseUrl: redactBaseUrl(baseUrl), commit, profile, profileVersion, startedAt, endedAt, parameters, summary: { requests: requestCount, throughputPerSecond: requestCount / elapsedSeconds, errorRate: requestCount ? errorCount / requestCount : 0, latencyMs: { p50: percentile(samples.map((s) => s.latencyMs || 0), 50), p95: percentile(samples.map((s) => s.latencyMs || 0), 95), p99: percentile(samples.map((s) => s.latencyMs || 0), 99) }, stopReason: "completed" }, personas, queue: { enqueued: 0, completed: 0, lagMs: { p95: 0 }, drainSeconds: 0, ...queue }, infrastructure: { cpu: {}, memory: {}, db: {}, redis: {}, ...infrastructure }, endpoints, safety });
}

function redactBaseUrl(value) {
  try { const url = new URL(value); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`; } catch { return "redacted"; }
}

function redactResult(value) {
  const forbidden = new Set(["authorization", "cookie", "cookies", "token", "accesstoken", "refreshtoken", "sessiontoken", "setcookie", "apikey", "body", "payload", "requestbody", "responsebody", "email", "rawpayload", "secret", "password", "devicetoken"]);
  if (Array.isArray(value)) return value.map((item) => redactResult(item));
  if (!value || typeof value !== "object") return typeof value === "string" && /@/.test(value) ? "redacted" : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.has(key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase())).map(([key, item]) => [key, redactResult(item)]));
}

module.exports = { PROFILE_SCHEMA, PROFILES, RESULT_SCHEMA, buildResult, classifyTarget, parseLoadParameters, redactResult, validateProfileRegistry };
