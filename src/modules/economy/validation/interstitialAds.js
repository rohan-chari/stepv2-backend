const { isSafeAppVersion } = require("../../../shared/validation/appVersion");
const {
  INTERSTITIAL_PLACEMENTS,
  INTERSTITIAL_PLATFORMS,
  SESSION_MAX_AGE_MS,
  IMPRESSION_MAX_AGE_MS,
  IMPRESSION_FUTURE_SKEW_MS,
} = require("../constants/interstitialAds");
const {
  InvalidInterstitialRequestError,
  InvalidInterstitialPermitRequestError,
  InvalidInterstitialImpressionError,
  InvalidInterstitialPermitIdError,
} = require("../errors/interstitialAds");

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isCanonicalUuid(value) {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseTimestamp(value) {
  if (typeof value !== "string" || !RFC3339_TIMESTAMP.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function validSessionStart(value, now) {
  const parsed = parseTimestamp(value);
  if (!parsed) return null;
  const age = now.getTime() - parsed.getTime();
  if (age < 0 || age > SESSION_MAX_AGE_MS) return null;
  return parsed;
}

function parseEligibilityQuery(req, now) {
  const params = new URL(req.originalUrl, "http://localhost").searchParams;
  const allowed = new Set(["placement", "sessionId", "sessionStartedAt"]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new InvalidInterstitialRequestError();
  }
  if ([...allowed].some((key) => params.getAll(key).length !== 1)) {
    throw new InvalidInterstitialRequestError();
  }
  const placement = params.get("placement");
  const sessionId = params.get("sessionId");
  const sessionStartedAt = validSessionStart(params.get("sessionStartedAt"), now);
  if (
    !INTERSTITIAL_PLACEMENTS.has(placement) ||
    !isCanonicalUuid(sessionId) ||
    !sessionStartedAt
  ) {
    throw new InvalidInterstitialRequestError();
  }
  return { placement, sessionId, sessionStartedAt };
}

function parsePermitBody(body, now) {
  if (!exactKeys(body, ["placement", "sessionId", "sessionStartedAt", "appVersion", "platform"])) {
    throw new InvalidInterstitialPermitRequestError();
  }
  const sessionStartedAt = validSessionStart(body.sessionStartedAt, now);
  if (
    !INTERSTITIAL_PLACEMENTS.has(body.placement) ||
    !isCanonicalUuid(body.sessionId) ||
    !sessionStartedAt ||
    !isSafeAppVersion(body.appVersion) ||
    !INTERSTITIAL_PLATFORMS.has(body.platform)
  ) {
    throw new InvalidInterstitialPermitRequestError();
  }
  return { ...body, sessionStartedAt };
}

function parseImpressionBody(body, now) {
  if (!exactKeys(body, [
    "eventId",
    "permitId",
    "placement",
    "sessionId",
    "occurredAt",
    "appVersion",
    "platform",
  ])) {
    throw new InvalidInterstitialImpressionError();
  }
  const occurredAt = parseTimestamp(body.occurredAt);
  const age = occurredAt ? now.getTime() - occurredAt.getTime() : NaN;
  if (
    !isCanonicalUuid(body.eventId) ||
    !isCanonicalUuid(body.permitId) ||
    !INTERSTITIAL_PLACEMENTS.has(body.placement) ||
    !isCanonicalUuid(body.sessionId) ||
    !occurredAt ||
    age > IMPRESSION_MAX_AGE_MS ||
    age < -IMPRESSION_FUTURE_SKEW_MS ||
    !isSafeAppVersion(body.appVersion) ||
    !INTERSTITIAL_PLATFORMS.has(body.platform)
  ) {
    throw new InvalidInterstitialImpressionError();
  }
  return { ...body, occurredAt };
}

function parsePermitId(value) {
  if (!isCanonicalUuid(value)) throw new InvalidInterstitialPermitIdError();
  return value;
}

module.exports = {
  CANONICAL_UUID,
  isCanonicalUuid,
  parseEligibilityQuery,
  parsePermitBody,
  parseImpressionBody,
  parsePermitId,
};
