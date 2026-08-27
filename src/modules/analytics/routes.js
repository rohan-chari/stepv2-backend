const { Router } = require("express");
const { prisma: defaultPrisma } = require("../../db");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const { isSafeAppVersion } = require("../../shared/validation/appVersion");

const MAX_BATCH_SIZE = 50;
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ALLOWED_EVENT_NAMES = new Set([
  "onboarding_started",
  "referral_continued",
  "health_cta_tapped",
  "daily_intro_viewed",
  "daily_opened",
  "starter_reward_claimed",
  "alert_card_enabled",
  "alert_card_dismissed",
  "tutorial_opened",
  "tutorial_completed",
  "tutorial_skipped",
  "public_browser_opened",
  "public_join_attempted",
  "public_join_succeeded",
  "public_join_failed",
  "race_creation_opened",
  "race_creation_succeeded",
  "invite_flow_opened",
  "invite_flow_sent",
  "race_started",
  // Onboarding revamp §5.9 / §6.4 — activation funnel. Widening the allowlist
  // can only increase what is accepted, so old clients are unaffected.
  "health_result",
  "health_escaped",
  "health_probe_inconclusive",
  "health_recovered",
  "notif_prompt_shown",
  "notif_result",
  "inviter_race_shown",
  "home_reached",
  // Demo race tutorial §5.9 / §6.3 — the three actions the playable demo
  // exists to teach. The demo's open/skip/complete funnel reuses the existing
  // tutorial_* names with source=onboarding; these three are the new ones.
  // Same reasoning as above: widening an allowlist can only increase what is
  // accepted, so no shipped client changes behavior. And because unknown names
  // soft-drop while keeping the 202, a newer app against an older backend loses
  // only these three events — the tutorial_* funnel still works.
  "demo_box_opened",
  "demo_powerup_used",
  "demo_won",
  // Invite-code onboarding step (spec §4). Same reasoning as every widening
  // above: accepting more names can only increase what lands, so no shipped
  // client changes behavior.
  "invite_code_step_shown",
  "invite_code_applied",
  "invite_code_skipped",
  // Clipboard-handoff funnel (spec part C). The iOS pasteboard handoff fails
  // silently and we have never known at which stage; these are the stages.
  //
  // THE OUTCOME IS ENCODED IN THE NAME, ON PURPOSE — do NOT "tidy" this into
  // one `install_attr` event with a context key. An unknown event NAME
  // soft-drops per event (below), but an unknown context key/value 400s the
  // ENTIRE batch, and the client retains failed batches — so against an older
  // backend one such event would poison every subsequent flush until it rolled
  // off the 50-event queue. Names are ordering-safe; context keys are not.
  "install_attr_deep_link",
  "install_attr_detect_miss",
  "install_attr_read_denied",
  "install_attr_read_no_code",
  "install_attr_code_captured",
  "install_attr_install_referrer",
  "install_attr_error",
  // Next-race discovery/create and invite-code relocation. New names are
  // additive; an older backend soft-drops them per event.
  "open_race_discovery_shown",
  "open_race_join_succeeded",
  "next_race_cta_shown",
  "next_race_cta_tapped",
  "quick_create_selected",
  "quick_create_succeeded",
  "quick_create_failed",
  "race_share_prompt_shown",
  "race_share_completed",
  "invite_code_setup_shown",
  "invite_code_setup_dismissed",
  "invite_code_setup_applied",
  "settings_invite_code_opened",
  "quick_race_auto_started",
  "race_share_referral_attributed",
  "race_share_referral_qualified",
  // Extra-spin CTA funnel. These are progress signals only: a completed ad
  // event is client-reported, while the signed SSV callback remains the only
  // authority that can mint or redeem an extra-daily-spin grant.
  "extra_spin_offer_shown",
  "extra_spin_cta_tapped",
  "extra_spin_ad_ready",
  "extra_spin_ad_not_ready",
  "extra_spin_ad_completed",
  "extra_spin_claim_succeeded",
  "health_connected",
  "race_leaderboard_viewed",
  // Natural-exit interstitial funnel and Race Detail visit distribution.
  // Unknown names soft-drop on older backends, preserving mixed-version
  // compatibility while these additive names land on the current backend.
  "interstitial_opportunity",
  "interstitial_skipped",
  "interstitial_show_attempted",
  "interstitial_load_succeeded",
  "interstitial_load_failed",
  "interstitial_dismissed",
  "interstitial_show_failed",
  "race_detail_visit_started",
  "race_detail_visit_ended",
  "race_detail_back_exit",
  "race_detail_exit_eligible",
]);

const METRICS_V2_EVENT_NAMES = new Set([
  "health_connected",
  "race_leaderboard_viewed",
]);

const INTERSTITIAL_EVENT_NAMES = new Set([
  "interstitial_opportunity",
  "interstitial_skipped",
  "interstitial_show_attempted",
  "interstitial_load_succeeded",
  "interstitial_load_failed",
  "interstitial_dismissed",
  "interstitial_show_failed",
]);
const RACE_DETAIL_VISIT_EVENT_NAMES = new Set([
  "race_detail_visit_started",
  "race_detail_visit_ended",
  "race_detail_back_exit",
  "race_detail_exit_eligible",
]);
const INTERSTITIAL_CONTEXT_KEYS = new Set(["placement", "reason", "result"]);
const RACE_DETAIL_VISIT_CONTEXT_KEYS = new Set([
  "entry_surface",
  "exit_kind",
  "scope_result",
  "dwell_bucket",
]);

const ALLOWED_CONTEXT = {
  source: new Set([
    "onboarding",
    "profile",
    "races",
    "empty_state",
    "share_link",
    "next_race",
    "healthkit",
  ]),
  race_state: new Set(["active", "pending"]),
  result: new Set([
    "granted",
    "denied",
    "dismissed",
    "unsupported",
    "failed",
    // Extra-spin CTA funnel: a bounded ad-load failure reason. `dismissed`
    // and `unsupported` above were already admissible and stay unchanged.
    "load_failed",
    "completed",
    "failed",
    "empty",
    "abandoned",
    "back_exit",
    "forward_exit",
    "short_visit",
    "ineligible_race",
    "rewarded_shown",
  ]),
  mode: new Set(["solo", "team", "tournament"]),
  surface: new Set(["home", "results"]),
  preset: new Set(["2_day", "7_day"]),
  race_count: new Set(["0", "1", "2", "3"]),
  attributed: new Set(["true", "false"]),
  deferred_install: new Set(["true", "false"]),
  error_code: new Set([
    "INVALID_QUICK_CREATE_CONFIG",
    "QUICK_CREATE_DISABLED",
    "QUICK_RACE_ALREADY_LIVE",
    "QUICK_RACE_MEMBERSHIP_LIMIT",
    "NETWORK",
    "UNKNOWN",
  ]),
  placement: new Set(["race_detail_exit", "race_results_exit"]),
  entry_surface: new Set(["home", "races", "public_races", "tournament"]),
  exit_kind: new Set(["back", "forward", "state_change", "auth_replace"]),
  scope_result: new Set(["active_accepted", "ineligible"]),
  dwell_bucket: new Set([
    "under_5s",
    "5_9s",
    "10_59s",
    "60_179s",
    "180s_plus",
  ]),
  reason: new Set([
    "unauthenticated",
    "unconfigured",
    "excluded_flow",
    "recent_fullscreen",
    "invalid_timezone",
    "acquisition_grace",
    "session_grace",
    "permit_active",
    "session_cap",
    "cooldown",
    "daily_cap",
    "backend_unsupported",
    "backend_unavailable",
    "not_ready",
    "show_failed",
    "account_changed",
  ]),
};

// Context keys whose allowed values are a PATTERN rather than a finite Set,
// kept separate from ALLOWED_CONTEXT so that map keeps its
// "key -> Set of allowed strings" meaning.
//
// `step` is the 1-indexed tutorial step a user was on when they bailed
// (spec §5.11.8) — `tutorial_skipped` carries it, `tutorial_completed` does not,
// and the two together give the drop-off histogram. Range is deliberately 1..10,
// headroom over the 5 steps shipping now, so changing the tutorial's length
// never needs a backend deploy.
//
// THE WIRE TYPE IS A STRING, NOT A NUMBER. The client's context map is
// Map<String, String> and every other value on this endpoint ("granted",
// "onboarding", …) already serializes as a string. Accepting the bare number
// too would mean two wire formats for one key and mixed types in the stored
// JSON, which makes `context->>'step'` un-groupable — so a numeric 3 is
// rejected as firmly as "2.5". Anything invalid takes the existing
// disallowed-context 400 path; only unknown event NAMES soft-drop.
const ALLOWED_PATTERN_CONTEXT = {
  // "1".."10". Rejects "0", "11", "-1", "2.5", the zero-padded "03", and "".
  step: /^(?:[1-9]|10)$/,
  // Required next-race funnel identifiers. UUIDs are bounded and validated;
  // share targets are client-normalized tokens, never raw platform payloads.
  race_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  source_race_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  share_target: /^[A-Za-z0-9._:-]{1,64}$/,
  seconds_from_creation: /^(?:0|[1-9][0-9]{0,9})$/,
  qualification_latency_seconds: /^(?:0|[1-9][0-9]{0,9})$/,
};

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const ALLOWED_PLATFORMS = new Set(["ios", "android", "other"]);
const FOREGROUND_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_NOTIFICATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateOpaqueId(value, field, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !SAFE_ID.test(value)
  ) {
    throw validationError(`${field} is invalid`);
  }
  return value;
}

function validateContext(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationError("context must be an object");
  }
  const context = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const pattern = ALLOWED_PATTERN_CONTEXT[key];
    if (pattern) {
      // The typeof guard is load-bearing, not belt-and-braces: without it a
      // bare number 3, `null` or `true` would be stringified by the regex test
      // and 3 would sneak through as a second wire format.
      if (typeof rawValue !== "string" || !pattern.test(rawValue)) {
        throw validationError(`context.${key} is not allowed`);
      }
      context[key] = rawValue;
      continue;
    }
    const values = ALLOWED_CONTEXT[key];
    if (!values || typeof rawValue !== "string" || !values.has(rawValue)) {
      throw validationError(`context.${key} is not allowed`);
    }
    context[key] = rawValue;
  }
  return context;
}

function validateActivationEvent(event, now = new Date()) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw validationError("event must be an object");
  }
  const allowedKeys = new Set([
    "id",
    "onboardingSessionId",
    "name",
    "context",
    "appVersion",
    "platform",
    "timestamp",
  ]);
  for (const key of Object.keys(event)) {
    if (!allowedKeys.has(key)) throw validationError(`event.${key} is not allowed`);
  }

  const id = validateOpaqueId(event.id, "id");
  const onboardingSessionId = validateOpaqueId(
    event.onboardingSessionId,
    "onboardingSessionId",
    { optional: true }
  );
  if (!ALLOWED_EVENT_NAMES.has(event.name)) {
    throw validationError("name is not allowed");
  }
  if (
    typeof event.appVersion !== "string" ||
    event.appVersion.length < 1 ||
    event.appVersion.length > 32 ||
    !isSafeAppVersion(event.appVersion)
  ) {
    throw validationError("appVersion is invalid");
  }
  if (!ALLOWED_PLATFORMS.has(event.platform)) {
    throw validationError("platform is not allowed");
  }
  const occurredAt = new Date(event.timestamp);
  if (typeof event.timestamp !== "string" || Number.isNaN(occurredAt.getTime())) {
    throw validationError("timestamp is invalid");
  }
  const age = now.getTime() - occurredAt.getTime();
  if (age > MAX_EVENT_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
    throw validationError("timestamp is outside the accepted window");
  }

  const context = validateContext(event.context);
  if (
    INTERSTITIAL_EVENT_NAMES.has(event.name) &&
    Object.keys(context).some((key) => !INTERSTITIAL_CONTEXT_KEYS.has(key))
  ) {
    throw validationError("interstitial context is invalid");
  }
  if (
    RACE_DETAIL_VISIT_EVENT_NAMES.has(event.name) &&
    Object.keys(context).some((key) => !RACE_DETAIL_VISIT_CONTEXT_KEYS.has(key))
  ) {
    throw validationError("race detail visit context is invalid");
  }
  if (
    event.name === "health_connected" &&
    (Object.keys(context).length !== 1 || context.source !== "healthkit")
  ) {
    throw validationError("health_connected context is invalid");
  }
  if (
    event.name === "race_leaderboard_viewed" &&
    (Object.keys(context).length !== 1 || typeof context.race_id !== "string")
  ) {
    throw validationError("race_leaderboard_viewed context is invalid");
  }
  return {
    id,
    onboardingSessionId,
    name: event.name,
    context,
    appVersion: event.appVersion,
    platform: event.platform,
    occurredAt,
  };
}

// True only for a structurally plausible event carrying a well-formed but
// unrecognised name. A MISSING or non-string name is malformed structure, not an
// unknown name, and still 400s via validateActivationEvent.
function isDroppableUnknownName(event) {
  return (
    !!event &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    typeof event.name === "string" &&
    !ALLOWED_EVENT_NAMES.has(event.name)
  );
}

function createAnalyticsRouter(dependencies = {}) {
  const router = Router();
  const prisma = dependencies.prisma || defaultPrisma;
  const requireAuth = dependencies.requireAuth || buildRequireAuth(dependencies);
  const now = dependencies.now || (() => new Date());
  const settings = dependencies.appSettings || defaultAppSettings;

  async function currentEpoch() {
    if (!(await settings.getFlag("adminMetricsV2TelemetryEnabled"))) return null;
    return prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
    });
  }

  function validAppVersion(value) {
    return isSafeAppVersion(value);
  }

  function parseForeground(body, receivedAt) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (!SAFE_SESSION_ID.test(body.sessionId || "")) return null;
    if (!validAppVersion(body.appVersion)) return null;
    if (typeof body.occurredAt !== "string") return null;
    const occurredAt = new Date(body.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) return null;
    const age = receivedAt.getTime() - occurredAt.getTime();
    if (age > FOREGROUND_MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS) return null;
    if (
      Object.keys(body).some(
        (key) => !["sessionId", "occurredAt", "appVersion"].includes(key)
      )
    ) return null;
    return { occurredAt, appVersion: body.appVersion };
  }

  router.use(requireAuth);

  router.post("/foreground", async (req, res) => {
    const receivedAt = now();
    const event = parseForeground(req.body, receivedAt);
    if (!event) {
      return res.status(400).json({
        error: "Invalid foreground analytics event",
        code: "INVALID_ANALYTICS_EVENT",
      });
    }
    try {
      const epoch = await currentEpoch();
      if (!epoch) {
        return res.status(202).json({ recorded: false, reason: "disabled" });
      }
      if (
        req.clientFeatures?.has("admin_metrics_v2") !== true ||
        req.user.isReviewAccount === true
      ) {
        return res
          .status(202)
          .json({ recorded: false, reason: "unsupported_platform" });
      }
      if (event.occurredAt < epoch.startedAt) {
        return res.status(202).json({ recorded: false, reason: "disabled" });
      }
      const activityDateRows = await prisma.$queryRaw`
        SELECT ((CAST(${event.occurredAt} AS timestamp) AT TIME ZONE 'UTC'
          AT TIME ZONE 'America/New_York')::date)::text AS activity_date`;
      const activityDate = activityDateRows[0].activity_date;
      await prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: {
            id: req.user.id,
            OR: [
              { metricsV2EligibleEpochId: null },
              { metricsV2EligibleEpochId: { not: epoch.id } },
            ],
          },
          data: {
            metricsV2EligibleAt: receivedAt,
            metricsV2EligibleEpochId: epoch.id,
          },
        });
        await tx.$executeRaw`
          INSERT INTO user_activity_days
            (user_id, activity_date, first_seen_at, last_seen_at,
             app_version, source, metadata_occurred_at)
          VALUES
            (${req.user.id}, CAST(${activityDate} AS date), ${event.occurredAt},
             ${event.occurredAt}, ${event.appVersion}, 'foreground', ${event.occurredAt})
          ON CONFLICT (user_id, activity_date) DO UPDATE SET
            first_seen_at = LEAST(user_activity_days.first_seen_at, EXCLUDED.first_seen_at),
            last_seen_at = GREATEST(user_activity_days.last_seen_at, EXCLUDED.last_seen_at),
            app_version = CASE
              WHEN EXCLUDED.metadata_occurred_at > user_activity_days.metadata_occurred_at
              THEN EXCLUDED.app_version ELSE user_activity_days.app_version END,
            metadata_occurred_at = GREATEST(
              user_activity_days.metadata_occurred_at,
              EXCLUDED.metadata_occurred_at
            )`;
      });
      return res.status(202).json({ recorded: true });
    } catch (error) {
      console.error("Foreground analytics ingestion error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/notification-open", async (req, res) => {
    const notificationId = req.body?.notificationId;
    if (
      typeof notificationId !== "string" ||
      !SAFE_NOTIFICATION_ID.test(notificationId) ||
      Object.keys(req.body || {}).some((key) => key !== "notificationId")
    ) {
      return res.status(400).json({
        error: "Invalid notification id",
        code: "INVALID_NOTIFICATION_ID",
      });
    }
    try {
      if (!(await currentEpoch())) {
        return res
          .status(202)
          .json({ attributed: false, reason: "disabled" });
      }
      const result = await prisma.pushDelivery.updateMany({
        where: {
          publicId: notificationId,
          userId: req.user.id,
          openedAt: null,
        },
        data: { openedAt: now() },
      });
      const attributed = result.count > 0 || await prisma.pushDelivery.count({
        where: { publicId: notificationId, userId: req.user.id },
      }) > 0;
      return res.status(202).json({ attributed });
    } catch (error) {
      console.error("Notification-open analytics ingestion error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/activation-events", async (req, res) => {
    try {
      const events = req.body?.events;
      if (!Array.isArray(events) || events.length < 1 || events.length > MAX_BATCH_SIZE) {
        throw validationError(`events must contain 1-${MAX_BATCH_SIZE} items`);
      }
      const receivedAt = now();
      // UNKNOWN NAMES ARE A PER-EVENT DROP, NOT A BATCH REJECTION (§6.4).
      // Batches are 1-50 events, so a single name from a newer client used to
      // poison a whole batch of otherwise valid events — the exact failure mode
      // that makes adding a client event depend on deploy order. Everything
      // else (malformed structure, unknown top-level keys, bad
      // appVersion/platform, disallowed CONTEXT values, out-of-window
      // timestamps) keeps its existing 400.
      const validated = [];
      for (const event of events) {
        if (isDroppableUnknownName(event)) continue;
        validated.push(validateActivationEvent(event, receivedAt));
      }
      const hasMetricsV2Event = validated.some((event) =>
        METRICS_V2_EVENT_NAMES.has(event.name)
      );
      const metricsEpoch = hasMetricsV2Event ? await currentEpoch() : null;
      const data = [];
      for (const event of validated) {
        if (
          METRICS_V2_EVENT_NAMES.has(event.name) &&
          (!metricsEpoch ||
            req.user.isReviewAccount === true ||
            event.platform !== "ios")
        ) {
          continue;
        }
        data.push({
          ...event,
          userId: req.user.id,
        });
      }
      if (data.length === 0) {
        return res.status(202).json({ accepted: 0, inserted: 0 });
      }
      const result = await prisma.activationEvent.createMany({
        data,
        skipDuplicates: true,
      });
      return res.status(202).json({ accepted: data.length, inserted: result.count });
    } catch (error) {
      if (error.statusCode === 400) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Activation analytics ingestion error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createAnalyticsRouter,
  validateActivationEvent,
  ALLOWED_EVENT_NAMES,
  ALLOWED_CONTEXT,
  ALLOWED_PATTERN_CONTEXT,
  MAX_BATCH_SIZE,
};
