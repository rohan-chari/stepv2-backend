const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const { stepInputIntake: defaultStepInputIntake } = require("../services/stepInputIntake");

class StepSampleError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepSampleError";
    if (statusCode) this.statusCode = statusCode;
  }
}

const VALID_RECORDING_METHODS = new Set([
  "unknown",
  "active",
  "automatic",
  "manual",
]);

function normalizeSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new StepSampleError("samples must be an array", 400);
  }
  const normalizedSamples = samples.map((sample) => {
    const normalized = { ...sample };
    if (typeof normalized.recordingMethod === "string") {
      normalized.recordingMethod = normalized.recordingMethod.trim().toLowerCase();
      if (!VALID_RECORDING_METHODS.has(normalized.recordingMethod)) {
        throw new StepSampleError(
          "recordingMethod must be one of unknown, active, automatic, or manual",
          400
        );
      }
      if (normalized.recordingMethod === "manual") {
        throw new StepSampleError("manual step samples are not allowed", 400);
      }
    }
    return normalized;
  });
  for (const sample of normalizedSamples) {
    if (!sample.periodStart || !sample.periodEnd || sample.steps == null) {
      throw new StepSampleError(
        "Each sample requires periodStart, periodEnd, and steps",
        400
      );
    }
  }
  return normalizedSamples;
}

function removeOverlaps(samples) {
  if (samples.length <= 1) return samples;
  const parsed = samples.map((sample) => ({
    ...sample,
    _start: new Date(sample.periodStart).getTime(),
    _end: new Date(sample.periodEnd).getTime(),
  }));
  return parsed
    .filter((sample) => !parsed.some((other) =>
      other !== sample &&
      other._start >= sample._start &&
      other._end <= sample._end &&
      other._end - other._start < sample._end - sample._start
    ))
    .map(({ _start, _end, ...sample }) => sample);
}

function buildRecordStepSamples(dependencies = {}) {
  const stepInputIntake = dependencies.stepInputIntake || defaultStepInputIntake;
  const settings = dependencies.appSettings || defaultAppSettings;
  const now = dependencies.now || (() => new Date());

  return async function recordStepSamples({ userId, samples, timeZone }) {
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new StepSampleError("samples must be a non-empty array", 400);
    }
    const cleaned = removeOverlaps(normalizeSamples(samples));
    const [burstCoalescing, queuedGenerationMerge] = await Promise.all([
      isStrictFlagEnabled(settings, "raceResolutionBurstCoalescingV1Enabled"),
      isStrictFlagEnabled(settings, "raceResolutionQueuedGenerationMergeV1Enabled"),
    ]);
    await stepInputIntake({
      userId,
      daily: null,
      samples: cleaned,
      timeZone,
      requestTimestamp: now(),
      endpoint: "samples",
      burstCoalescing,
      queuedGenerationMerge,
    });
    return { count: cleaned.length };
  };
}

const recordStepSamples = buildRecordStepSamples();

module.exports = {
  buildRecordStepSamples,
  recordStepSamples,
  StepSampleError,
  normalizeSamples,
  removeOverlaps,
};
