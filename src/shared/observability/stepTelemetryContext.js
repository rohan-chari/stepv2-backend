const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();
const transactionErrors = new WeakSet();

function runWithStepTelemetryContext(context, callback) {
  return storage.run(context, callback);
}

function recordStepTelemetryPhase(phase, durationMs) {
  const context = storage.getStore();
  const value = Number(durationMs);
  if (!context || typeof phase !== "string" || !Number.isFinite(value) || value < 0 || value > 86_400_000) {
    return false;
  }
  if (!context.phases) context.phases = {};
  if (!context.phaseObservations) context.phaseObservations = {};
  context.phases[phase] = (context.phases[phase] || 0) + value;
  if (!context.phaseObservations[phase]) context.phaseObservations[phase] = [];
  context.phaseObservations[phase].push(value);
  return true;
}

function currentStepTelemetryContext() {
  return storage.getStore() || null;
}

async function measureStepTelemetryPhase(phase, operation) {
  const startedAt = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    recordStepTelemetryPhase(phase, Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
}

function markStepTelemetryTransactionError(error) {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    transactionErrors.add(error);
  }
  return error;
}

function isStepTelemetryTransactionError(error) {
  return ((typeof error === "object" && error !== null) || typeof error === "function") &&
    transactionErrors.has(error);
}

module.exports = {
  runWithStepTelemetryContext,
  recordStepTelemetryPhase,
  currentStepTelemetryContext,
  measureStepTelemetryPhase,
  markStepTelemetryTransactionError,
  isStepTelemetryTransactionError,
};
