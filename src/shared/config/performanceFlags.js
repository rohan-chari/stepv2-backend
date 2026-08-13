function positiveFlag(value) {
  return value === "true";
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  const number = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, number));
}

function readPerformanceFlags(env = process.env) {
  return {
    placementDistributedClaimEnabled: positiveFlag(
      env.PLACEMENT_DISTRIBUTED_CLAIM_ENABLED
    ),
    placementInertPushSuppressionEnabled: positiveFlag(
      env.PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED
    ),
    placementLeanBaselineWritesEnabled: positiveFlag(
      env.PLACEMENT_LEAN_BASELINE_WRITES_ENABLED
    ),
    stepSyncBulkEnabled: positiveFlag(env.STEP_SYNC_BULK_ENABLED),
    apnsSessionReuseEnabled: positiveFlag(env.APNS_SESSION_REUSE_ENABLED),
    placementBaselineWriteConcurrency: boundedInteger(
      env.PLACEMENT_BASELINE_WRITE_CONCURRENCY,
      4,
      1,
      8
    ),
    stepSyncPushConcurrency: boundedInteger(
      env.STEP_SYNC_PUSH_CONCURRENCY,
      8,
      1,
      16
    ),
  };
}

function logPerformanceFlags(logger = console, env = process.env) {
  const flags = readPerformanceFlags(env);
  logger.log("[PERFORMANCE_FLAGS]", flags);
  return flags;
}

module.exports = {
  boundedInteger,
  logPerformanceFlags,
  positiveFlag,
  readPerformanceFlags,
};
