const USER_FANOUT_LEGACY_CONTROLS = new Set([
  "LIVE_PLACEMENT_DISABLED",
  "DAILY_MOVER_DISABLED",
  "DAILY_REWARD_REMINDERS_DISABLED",
  "STEP_MILESTONE_REMINDERS_DISABLED",
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
]);

const AD_VALUE_LEGACY_CONTROLS = Object.freeze({
  extraSpin: { name: "ADS_EXTRA_SPIN_ENABLED", defaultEnabled: true },
  coinReward: { name: "ADS_COIN_REWARD_ENABLED", defaultEnabled: true },
  boxReroll: { name: "ADS_BOX_REROLL_ENABLED", defaultEnabled: false },
  payoutPrepare: {
    name: "ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED",
    defaultEnabled: false,
  },
  payoutClaim: {
    name: "ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED",
    defaultEnabled: false,
  },
  payoutReconcile: {
    name: "RACE_PAYOUT_DOUBLE_RECONCILE_ENABLED",
    defaultEnabled: false,
  },
});

function strictlyTrue(value) {
  return value === "true";
}

function userFanoutDisabled(legacyName, env = process.env) {
  if (!USER_FANOUT_LEGACY_CONTROLS.has(legacyName)) {
    throw new Error(`Unknown user fan-out legacy control: ${legacyName}`);
  }
  return (
    strictlyTrue(env.OPS_USER_FANOUTS_DISABLED) || strictlyTrue(env[legacyName])
  );
}

function destructiveCleanupDisabled(legacyName, env = process.env) {
  if (!DESTRUCTIVE_CLEANUP_LEGACY_CONTROLS.has(legacyName)) {
    throw new Error(`Unknown destructive cleanup legacy control: ${legacyName}`);
  }
  return (
    strictlyTrue(env.OPS_DESTRUCTIVE_CLEANUPS_DISABLED) ||
    strictlyTrue(env[legacyName])
  );
}

function raceResolutionIntakeDisabled(env = process.env) {
  return (
    strictlyTrue(env.OPS_RACE_RESOLUTION_INTAKE_DISABLED) ||
    strictlyTrue(env.ASYNC_RACE_RESOLUTION_DISABLED)
  );
}

function raceResolutionWorkerDisabled(env = process.env) {
  return (
    strictlyTrue(env.OPS_RACE_RESOLUTION_WORKER_DISABLED) ||
    strictlyTrue(env.ASYNC_RACE_RESOLUTION_WORKER_DISABLED)
  );
}

function raceResolutionPostTaskWorkerDisabled(env = process.env) {
  return (
    strictlyTrue(env.OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED) ||
    strictlyTrue(env.RACE_RESOLUTION_POST_TASK_WORKER_DISABLED)
  );
}

function adValueEnabled(kind, env = process.env) {
  const legacy = AD_VALUE_LEGACY_CONTROLS[kind];
  if (!legacy) throw new Error(`Unknown ad-value kind: ${kind}`);
  if (strictlyTrue(env.OPS_AD_VALUE_ISSUANCE_DISABLED)) return false;
  const value = env[legacy.name];
  return legacy.defaultEnabled ? value !== "false" : value === "true";
}

module.exports = {
  USER_FANOUT_LEGACY_CONTROLS,
  DESTRUCTIVE_CLEANUP_LEGACY_CONTROLS,
  AD_VALUE_LEGACY_CONTROLS,
  userFanoutDisabled,
  destructiveCleanupDisabled,
  raceResolutionIntakeDisabled,
  raceResolutionWorkerDisabled,
  raceResolutionPostTaskWorkerDisabled,
  adValueEnabled,
};
