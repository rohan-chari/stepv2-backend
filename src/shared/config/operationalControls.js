const USER_FANOUT_LEGACY_CONTROLS = new Set([
  "LIVE_PLACEMENT_DISABLED",
  "DAILY_MOVER_DISABLED",
  "DAILY_REWARD_REMINDERS_DISABLED",
  "HIGH_MULTIPLIER_PUSH_DISABLED",
  "RACE_ENDING_REMINDER_DISABLED",
  "INBOX_DELIVERY_DISABLED",
]);

const DESTRUCTIVE_CLEANUP_LEGACY_CONTROLS = new Set([
  "ACTIVATION_EVENT_CLEANUP_DISABLED",
  "ADMIN_METRICS_V2_CLEANUP_DISABLED",
  "NOTIFICATION_CLEANUP_DISABLED",
  "INBOX_EXPIRY_DISABLED",
  "STEP_SAMPLE_RETENTION_DISABLED",
  "RACE_RESOLUTION_POST_TASK_CLEANUP_DISABLED",
  "GIVEAWAY_RETENTION_DISABLED",
]);

const AD_VALUE_KINDS = new Set([
  "extraSpin",
  "coinReward",
  "boxReroll",
  "payoutPrepare",
  "payoutClaim",
  "payoutReconcile",
]);

function strictlyTrue(value) {
  return value === "true";
}

function userFanoutDisabled(legacyName, env = process.env) {
  if (legacyName != null && !USER_FANOUT_LEGACY_CONTROLS.has(legacyName)) {
    throw new Error(`Unknown user fan-out legacy control: ${legacyName}`);
  }
  return strictlyTrue(env.OPS_USER_FANOUTS_DISABLED);
}

function destructiveCleanupDisabled(legacyName, env = process.env) {
  if (!DESTRUCTIVE_CLEANUP_LEGACY_CONTROLS.has(legacyName)) {
    throw new Error(`Unknown destructive cleanup legacy control: ${legacyName}`);
  }
  return strictlyTrue(env.OPS_DESTRUCTIVE_CLEANUPS_DISABLED);
}

function raceResolutionIntakeDisabled(env = process.env) {
  return strictlyTrue(env.OPS_RACE_RESOLUTION_INTAKE_DISABLED);
}

function raceResolutionWorkerDisabled(env = process.env) {
  return strictlyTrue(env.OPS_RACE_RESOLUTION_WORKER_DISABLED);
}

function raceResolutionPostTaskWorkerDisabled(env = process.env) {
  return strictlyTrue(env.OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED);
}

function adValueEnabled(kind, env = process.env) {
  if (!AD_VALUE_KINDS.has(kind)) throw new Error(`Unknown ad-value kind: ${kind}`);
  return !strictlyTrue(env.OPS_AD_VALUE_ISSUANCE_DISABLED);
}

module.exports = {
  USER_FANOUT_LEGACY_CONTROLS,
  DESTRUCTIVE_CLEANUP_LEGACY_CONTROLS,
  AD_VALUE_KINDS,
  userFanoutDisabled,
  destructiveCleanupDisabled,
  raceResolutionIntakeDisabled,
  raceResolutionWorkerDisabled,
  raceResolutionPostTaskWorkerDisabled,
  adValueEnabled,
};
