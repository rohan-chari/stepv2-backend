const { Router } = require("express");
const { prisma: defaultPrisma } = require("../../db");
const { buildRequireAuth } = require("../../middleware/requireAuth");

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
]);

const ALLOWED_CONTEXT = {
  source: new Set(["onboarding", "profile", "races", "empty_state", "share_link"]),
  race_state: new Set(["active", "pending"]),
  result: new Set(["granted", "denied", "dismissed", "unsupported", "failed"]),
  mode: new Set(["solo", "team", "tournament"]),
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
};

const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
// PackageInfo.version is numeric/dotted. Permit a bounded build/prerelease
// suffix plus the explicit client fallback, but not arbitrary free-form text.
const SAFE_APP_VERSION = /^(?:unknown|\d{1,4}(?:\.\d{1,4}){1,3}(?:[+-][A-Za-z0-9.-]{1,16})?)$/;
const ALLOWED_PLATFORMS = new Set(["ios", "android", "other"]);

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
    !SAFE_APP_VERSION.test(event.appVersion)
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

  return {
    id,
    onboardingSessionId,
    name: event.name,
    context: validateContext(event.context),
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

  router.use(requireAuth);
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
      const data = [];
      for (const event of events) {
        if (isDroppableUnknownName(event)) continue;
        data.push({
          ...validateActivationEvent(event, receivedAt),
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
