const HOME_CAPACITY_PARITY_ENV_NAMES = Object.freeze([
  "ADS_BOX_REROLL_ENABLED",
  "ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED",
  "ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED",
  "AD_COIN_REWARD_AMOUNT",
  "AD_COIN_REWARD_DAILY_CAP",
  "APNS_PRODUCTION",
  "APNS_SESSION_REUSE_ENABLED",
  "ASYNC_RACE_RESOLUTION_CONCURRENCY",
  "BOUNTY_PAYOUT_COINS",
  "CHARACTER_POWERS_ENABLED",
  "DAILY_REWARD_REMINDERS_DISABLED",
  "DAILY_SPIN_RARE_COINS_SHARE",
  "IMPOSTER_ENABLED",
  "NODE_ENV",
  "PIGGY_BANK_COIN_CAP",
  "PIGGY_BANK_STEPS_PER_COIN",
  "PLACEMENT_DISTRIBUTED_CLAIM_ENABLED",
  "PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED",
  "PLACEMENT_LEAN_BASELINE_WRITES_ENABLED",
  "POWERUP_UNLOCK_DAILY_CAP",
  "POWERUP_UNLOCK_MAX_SHORTFALL",
  "RACE_ENDING_REMINDER_DISABLED",
  "RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS",
  "RACE_PAYOUT_DOUBLE_RECONCILE_ENABLED",
  "RACE_RESOLVE_DEBOUNCE_MS",
  "RAINSTORM_MULTIPLICATIVE_ENABLED",
  "S3_PRESIGNED_URL_EXPIRES_SECONDS",
  "STEP_MILESTONE_REMINDERS_DISABLED",
  "STEP_SYNC_BULK_ENABLED",
  "SYNC_V2_INLINE_UPLOADER_RECONCILIATION",
  "ZOOMIES_PUSH_DISABLED",
]);

const HOME_CAPACITY_PARITY_ENV_ALLOWLIST = new Set(HOME_CAPACITY_PARITY_ENV_NAMES);

function assertHomeCapacityParityOverlay(overlay = {}) {
  const names = Object.keys(overlay).sort();
  const unknown = names.filter((name) => !HOME_CAPACITY_PARITY_ENV_ALLOWLIST.has(name));
  const missing = HOME_CAPACITY_PARITY_ENV_NAMES.filter((name) => !Object.hasOwn(overlay, name));
  if (unknown.length || missing.length) {
    throw new Error(`capacity parity overlay mismatch (unknown: ${unknown.join(",") || "none"}; missing: ${missing.join(",") || "none"})`);
  }
  for (const name of names) if (!String(overlay[name] || "").trim()) {
    throw new Error(`capacity production parity overlay is missing ${name}`);
  }
  return true;
}

module.exports = { HOME_CAPACITY_PARITY_ENV_ALLOWLIST, HOME_CAPACITY_PARITY_ENV_NAMES,
  assertHomeCapacityParityOverlay };
