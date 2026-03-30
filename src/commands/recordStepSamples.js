const { StepSample } = require("../models/stepSample");

class StepSampleError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepSampleError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildRecordStepSamples(dependencies = {}) {
  const stepSampleModel = dependencies.StepSample || StepSample;

  return async function recordStepSamples({ userId, samples }) {
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new StepSampleError("samples must be a non-empty array", 400);
    }

    if (samples.length > 168) {
      // Max 7 days * 24 hours = 168 hourly buckets
      throw new StepSampleError("Too many samples (max 168)", 400);
    }

    for (const s of samples) {
      if (!s.periodStart || !s.periodEnd || s.steps == null) {
        throw new StepSampleError("Each sample requires periodStart, periodEnd, and steps", 400);
      }
    }

    await stepSampleModel.upsertBatch(userId, samples);

    return { count: samples.length };
  };
}

const recordStepSamples = buildRecordStepSamples();

module.exports = { buildRecordStepSamples, recordStepSamples, StepSampleError };
