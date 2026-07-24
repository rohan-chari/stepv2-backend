const crypto = require("crypto");
const { compareVersions } = require("../../utils/appVersion");

// Canonicalization + hashing for POST /steps/sync-v2 idempotency (§6.4).
//
// The server derives a stable SHA-256 over a canonical representation of the
// request so that a same-key replay with canonically-equivalent input returns
// the stored response, while a same-key reuse with DIFFERENT normalized input is
// a 409 conflict. The client is contractually required to build one immutable
// normalized payload per attempt group and reuse it for its single retry, so a
// conforming client never trips the conflict path.
//
// Canonical rules (must match the frontend's normalization):
//   * drop unknown top-level fields (forward-compat);
//   * `date` is the YYYY-MM-DD string;
//   * `steps` and every sample `steps` are integers;
//   * samples are sorted by periodStart, then periodEnd;
//   * sample timestamps are UTC ISO-8601 with milliseconds;
//   * optional sample string fields are carried through when present;
//   * sample `metadata` object keys are recursively sorted;
//   * hash is SHA-256 of the canonical UTF-8 JSON.

class StepSyncValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "StepSyncValidationError";
    this.code = "INVALID_STEP_SYNC";
    this.statusCode = 400;
  }
}

// Must admit a complete day at the finest supported granularity: 288 5-min
// buckets per 24h, plus tz-shift slack (a DST/travel day can span up to 28h of
// wall clock) => 28h * 12 = 336. Sized for 24 hourly buckets (48) until the
// 2026-07-23 incident: flipping stepSampleBucketMinutes to 5 made every >4h-active
// user's sync 400 here, a total sync outage for them.
const MAX_SAMPLES = 336;

// Sub-hourly payloads are gated at the first app version whose fine-grained
// health read normalizes bucket sums (2026-07-23 incident #2: earlier readers
// count a boundary-straddling raw chunk once per bucket touched, inflating
// totals; a device that persisted bucketMinutes=5 from an earlier flag window
// keeps sending fine payloads on cold-start syncs regardless of what /auth/me
// serves now). ONE sub-hourly sample is always allowed — every hourly client
// ends its payload with an in-progress partial bucket. Fails open on
// absent/garbled versions: builds that old cannot produce fine buckets.
const FINE_SAMPLE_MIN_APP_VERSION =
  process.env.FINE_BUCKET_MIN_APP_VERSION || "1.7.1";
const SUB_HOURLY_MS = 59 * 60 * 1000;

function assertFineSamplesAllowed(samples, clientAppVersion) {
  const belowFloor =
    compareVersions(clientAppVersion, FINE_SAMPLE_MIN_APP_VERSION) === -1;
  if (!belowFloor) return;
  const subHourly = samples.filter((s) => {
    const start = new Date(s.periodStart).getTime();
    const end = new Date(s.periodEnd).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end - start < SUB_HOURLY_MS;
  });
  if (subHourly.length > 1) {
    throw new StepSyncValidationError(
      `sub-hourly samples require app ${FINE_SAMPLE_MIN_APP_VERSION} or newer`
    );
  }
}
const MAX_IDEMPOTENCY_KEY_LENGTH = 36;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sample string passthrough fields (validation of `recordingMethod`/manual
// rejection reuses the existing recordStepSamples rules during persistence).
const SAMPLE_STRING_FIELDS = [
  "sourceName",
  "sourceId",
  "sourceDeviceId",
  "deviceModel",
  "recordingMethod",
];

function isInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

// Recursively sort object keys so metadata serializes deterministically. Arrays
// keep their order (order is meaningful); primitives pass through.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function toUtcIsoMs(value, field) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StepSyncValidationError(`Invalid ${field} timestamp`);
  }
  return date.toISOString(); // always UTC, millisecond precision (…Z)
}

// Validate the idempotency key: canonical UUID, capped at 36 chars.
function validateIdempotencyKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    throw new StepSyncValidationError("Idempotency-Key header is required");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !UUID_RE.test(key)) {
    throw new StepSyncValidationError("Idempotency-Key must be a canonical UUID");
  }
  return key;
}

// Build the canonical request object + its SHA-256 hex. Throws
// StepSyncValidationError (400 / INVALID_STEP_SYNC) on invalid shape. Does NOT
// enforce manual-sample rejection or overlap cleaning — those reuse the existing
// recordStepSamples rules at persistence time.
function canonicalizeStepSyncRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new StepSyncValidationError("Request body must be an object");
  }

  const { date, steps, samples } = body;

  if (typeof date !== "string" || !DATE_RE.test(date)) {
    throw new StepSyncValidationError("date must be a YYYY-MM-DD string");
  }
  if (!isInteger(steps) || steps < 0) {
    throw new StepSyncValidationError("steps must be a non-negative integer");
  }
  if (!Array.isArray(samples)) {
    throw new StepSyncValidationError("samples must be an array");
  }
  if (samples.length > MAX_SAMPLES) {
    throw new StepSyncValidationError(`samples must not exceed ${MAX_SAMPLES} entries`);
  }

  const canonicalSamples = samples.map((sample) => {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
      throw new StepSyncValidationError("each sample must be an object");
    }
    if (sample.periodStart == null || sample.periodEnd == null) {
      throw new StepSyncValidationError(
        "each sample requires periodStart, periodEnd, and steps"
      );
    }
    if (!isInteger(sample.steps) || sample.steps < 0) {
      throw new StepSyncValidationError("each sample steps must be a non-negative integer");
    }

    const canonical = {
      periodStart: toUtcIsoMs(sample.periodStart, "periodStart"),
      periodEnd: toUtcIsoMs(sample.periodEnd, "periodEnd"),
      steps: sample.steps,
    };
    for (const field of SAMPLE_STRING_FIELDS) {
      if (sample[field] != null) {
        canonical[field] = String(sample[field]);
      }
    }
    if (sample.metadata != null) {
      canonical.metadata = sortKeysDeep(sample.metadata);
    }
    return canonical;
  });

  // Sort by periodStart, then periodEnd (ISO strings sort chronologically).
  canonicalSamples.sort((a, b) => {
    if (a.periodStart !== b.periodStart) {
      return a.periodStart < b.periodStart ? -1 : 1;
    }
    if (a.periodEnd !== b.periodEnd) {
      return a.periodEnd < b.periodEnd ? -1 : 1;
    }
    return 0;
  });

  const canonical = { date, steps, samples: canonicalSamples };
  const json = JSON.stringify(canonical);
  const hash = crypto.createHash("sha256").update(json, "utf8").digest("hex");

  return { canonical, hash, json };
}

module.exports = {
  assertFineSamplesAllowed,
  StepSyncValidationError,
  canonicalizeStepSyncRequest,
  validateIdempotencyKey,
  sortKeysDeep,
  MAX_SAMPLES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
};
