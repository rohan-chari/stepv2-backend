#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const {
  ADMIN_EXPOSED_FLAGS,
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
} = require("../src/shared/config/appSettings");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "docs/runtime-control-disposition.yaml");
const EVIDENCE_AT = "2026-08-20T04:23:00Z";

const retainedDb = new Set([
  "capacityPhaseMetricsV1Enabled",
  "homeServiceBannerEnabled",
  "homeServiceBannerMessage",
  "racePreviewEnabled",
]);
const deploymentProtocolDb = new Set([
  "raceQueueV2ClaimingDisabled",
  "inlineRaceResolutionFallback",
]);
const requestApiDb = new Set([
  "raceProgressLeanProjectionV1Enabled",
  "legacyUploaderStepSamplePrefetchV1Enabled",
  "raceMessageLeanAccessV1Enabled",
  "raceListSqlSummaryV1Enabled",
  "apiRaceListCompactV1Enabled",
  "apiRaceBootstrapCompactV1Enabled",
  "homeRaceCardLeanLiveV1Enabled",
  "homeRaceCardParallelOptionalV1Enabled",
  "homeRaceCardSnapshotReuseV1Enabled",
  "publicRaceCountSqlV1Enabled",
  "apiRaceMessageConditionalV1Enabled",
  "apiRacePowerupTargetContextV1Enabled",
  "racePowerupLeanUseContextV1Enabled",
  "apiLeaderboardCompactV1Enabled",
  "apiRaceBootstrapV1Enabled",
  "apiRaceProgressCompactV1Enabled",
  "apiRaceMessageStreamsV1Enabled",
  "apiFriendsSummaryV1Enabled",
  "apiAuthShellV1Enabled",
  "apiHomeShellV1Enabled",
  "apiGetCoinsV1Enabled",
  "apiPublicRaceBrowserV1Enabled",
  "apiRankedV2CompactV1Enabled",
  "apiProfileStatsV1Enabled",
  "apiImpactNoticesEnabled",
  "apiImpactSummariesEnabled",
  "apiReviewPromptEnabled",
  "apiInboxV1Enabled",
  "apiShopBootstrapV1Enabled",
  "apiStaticEtagsV1Enabled",
  "apiTournamentDetailV1Enabled",
  "apiRaceChatWatermarkCacheV1Enabled",
]);
const redisDb = new Set([
  "redisCacheCatalogsEnabled",
  "redisCacheMessagesEnabled",
  "redisStandingsEnabled",
  "redisCacheUserBitsEnabled",
  "redisCacheAuthMeEnabled",
  "redisCacheDiscardCapEnabled",
  "redisPresentationGenerationGuardEnabled",
  "redisCacheLeaderboardEnabled",
  "redisCacheFriendsEnabled",
  "redisFriendSearchRateLimitEnabled",
  "redisCacheHomeActiveGlobalEventEnabled",
  "redisCacheHomeImpactSummaryEnabled",
  "redisCacheHomeInboxUnreadEnabled",
]);
const workerDb = new Set([
  "raceResolutionDisplayArtifactReuseV1Enabled",
  "raceResolutionReasonAwareV1Enabled",
  "raceResolutionBurstCoalescingV1Enabled",
  "raceResolutionQueuedGenerationMergeV1Enabled",
  "raceResolutionBulkWriteV1Enabled",
  "raceResolutionPostTasksV1Enabled",
  "raceResolutionNudgeBatchV1Enabled",
  "raceResolutionAdaptiveDrainV1Enabled",
  "raceResolutionPostTaskAdaptiveDrainV1Enabled",
  "raceResolutionPendingImpactOnlyV1Enabled",
  "raceResolutionNarrowDefenseQueryV1Enabled",
  "raceResolutionActiveImpactBulkPersistV1Enabled",
  "raceResolutionPostTaskFastHandoffV1Enabled",
  "raceResolutionNoopInputSuppressionV1Enabled",
]);
const productDb = new Set([
  "teamRacesEnabled",
  "tournamentsEnabled",
  "quickCreateRaceCtaEnabled",
  "customRaceWindowEnabled",
  "discoverableIdentityOnboardingEnrollmentEnabled",
  "racesInviteDecisionGateEnabled",
  "quickRaceShareAutoFriendEnabled",
  "seededRaceBucketsEnabled",
  "racePayoutDoubleRolloutPercent",
  "payoutRoundingV1Enabled",
  "raceExitActionsEnabled",
  "stepSampleBucketMinutes",
  "onboardingV2Enabled",
  "onboardingV3Enabled",
  "onboardingInviteCodeEnabled",
  "tutorialMandatoryEnabled",
  "bannerAdsEnabled",
  "dualBoxBannersEnabled",
  "seededGeometricPayoutsEnabled",
  "seededInactivityPruneEnabled",
  "apiActiveImpactNoticesV1Enabled",
  "apiCompletedImpactPopupEnabled",
  "fundedPrizePoolsEnabled",
  "buyInEditEnabled",
  "openUserRaceDiscoveryEnabled",
  "setupInviteCodePromptEnabled",
  "homeInviteModalEnabled",
  "localGlobalStepEventsEnabled",
  "localGlobalStepEventRetentionEnabled",
  "adminMetricsV2DashboardEnabled",
  "adminMetricsV2TelemetryEnabled",
  "seededInactivityAutoEnrollOffEnabled",
  "accessoryCompatibilityEnforcement",
]);

const envMetadata = {
  PRISMA_QUERY_EVENTS_ENABLED: ["retained_diagnostic", false, "literal true enables outside production; production true fails startup", "diagnostics", false],
  PLACEMENT_BASELINE_WRITE_CONCURRENCY: ["retained_numeric", 4, "integer clamped to 1..8", "performance", 4],
  STEP_SYNC_PUSH_CONCURRENCY: ["retained_numeric", 8, "integer clamped to 1..16", "performance", 8],
  OPS_USER_FANOUTS_DISABLED: ["retained_operational", null, "literal true disables all owned fan-outs", "operational_brakes", "false"],
  OPS_DESTRUCTIVE_CLEANUPS_DISABLED: ["retained_operational", null, "literal true disables all owned cleanup jobs", "operational_brakes", "false"],
  OPS_RACE_RESOLUTION_INTAKE_DISABLED: ["retained_operational", null, "literal true returns the existing pre-write sync-v2 503", "operational_brakes", "false"],
  OPS_RACE_RESOLUTION_WORKER_DISABLED: ["retained_operational", null, "literal true stops core durable claims", "operational_brakes", "false"],
  OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: ["retained_operational", null, "literal true stops post-task claims", "operational_brakes", "false"],
  OPS_AD_VALUE_ISSUANCE_DISABLED: ["retained_operational", null, "literal true disables every ad-value issuance path", "operational_brakes", "false"],
  ADMOB_SSV_SKIP_VERIFY: ["retained_nonproduction_security", false, "literal true skips verification; forbidden in production", "ad_security", false],
  APNS_PRODUCTION: ["deployment_config", null, "literal true selects APNs production", "push_config", null],
  CAPACITY_MODE: ["capacity_local_config", null, "literal true enables isolated capacity entrypoint", "capacity_local", false],
  CAPACITY_OUTBOUND_DISABLED: ["capacity_local_config", null, "capacity mode requires literal true", "capacity_local", true],
  CAPACITY_DATABASE_SSL_DISABLED: ["capacity_local_config", false, "literal true disables database TLS only after the run-bound capacity environment validates", "capacity_local", false],
  DB_POOL_MAX: ["capacity_local_config", 20, "integer 1..20 overrides the database pool only in validated capacity mode", "capacity_local", 20],
};

const retiredEnv = {
  ACTIVATION_EVENT_CLEANUP_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  ADMIN_METRICS_V2_CLEANUP_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  NOTIFICATION_CLEANUP_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  INBOX_EXPIRY_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  STEP_SAMPLE_RETENTION_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  RACE_RESOLUTION_POST_TASK_CLEANUP_DISABLED: [false, "cleanup runs behind OPS_DESTRUCTIVE_CLEANUPS_DISABLED"],
  ASYNC_RACE_RESOLUTION_DISABLED: [false, "intake runs behind OPS_RACE_RESOLUTION_INTAKE_DISABLED"],
  ASYNC_RACE_RESOLUTION_WORKER_DISABLED: [false, "worker runs behind OPS_RACE_RESOLUTION_WORKER_DISABLED"],
  RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: [false, "worker runs behind OPS_RACE_RESOLUTION_POST_TASK_WORKER_DISABLED"],
  DAILY_MOVER_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  DAILY_REWARD_REMINDERS_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  INBOX_DELIVERY_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  LIVE_PLACEMENT_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  HIGH_MULTIPLIER_PUSH_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  RACE_ENDING_REMINDER_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  STEP_MILESTONE_REMINDERS_DISABLED: [false, "fan-out runs behind OPS_USER_FANOUTS_DISABLED"],
  GLOBAL_EVENT_SUMMARY_DISABLED: [false, "scheduled job permanently runs"],
  LOCAL_GLOBAL_STEP_EVENTS_DISABLED: [false, "database launch gate remains authoritative"],
  PRIVATE_RACE_AUTOSTART_DISABLED: [false, "private auto-start permanently runs"],
  RACE_POLICY_AUTOSTART_DISABLED: [false, "race-policy auto-start permanently runs"],
  RACE_SCORING_INPUT_BASELINE_DISABLED: [false, "baseline job permanently runs"],
  ADS_EXTRA_SPIN_ENABLED: [true, "extra-spin value remains available behind OPS_AD_VALUE_ISSUANCE_DISABLED"],
  ADS_COIN_REWARD_ENABLED: [true, "coin reward remains available behind OPS_AD_VALUE_ISSUANCE_DISABLED"],
  ADS_BOX_REROLL_ENABLED: [true, "box reroll remains available behind OPS_AD_VALUE_ISSUANCE_DISABLED"],
  ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED: [true, "payout preparation remains available behind OPS_AD_VALUE_ISSUANCE_DISABLED"],
  ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED: [true, "payout claim remains available behind OPS_AD_VALUE_ISSUANCE_DISABLED"],
  RACE_PAYOUT_DOUBLE_RECONCILE_ENABLED: [true, "payout reconciliation permanently runs"],
  RAINSTORM_MULTIPLICATIVE_ENABLED: [true, "multiplicative scoring permanently runs"],
  PLACEMENT_DISTRIBUTED_CLAIM_ENABLED: [true, "distributed claims permanently run"],
  PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED: [true, "inert pushes are permanently suppressed"],
  PLACEMENT_LEAN_BASELINE_WRITES_ENABLED: [true, "lean baseline writes permanently run"],
  STEP_SYNC_BULK_ENABLED: [true, "bulk step sync permanently runs"],
  APNS_SESSION_REUSE_ENABLED: [true, "APNs sessions are permanently reused"],
  SYNC_V2_INLINE_UPLOADER_RECONCILIATION: [false, "sync v2 permanently returns DEFERRED"],
  PLACEMENT_BASELINE_RESYNC: [false, "one-tick migration path retired"],
  REFERRAL_IP_FALLBACK_NET_ENABLED: [false, "network-prefix referral attribution retired"],
  CHARACTER_POWERS_ENABLED: [false, "character race abilities are retired"],
  TURTLE_SHELL_DISABLED: [true, "character race abilities are retired"],
  ZOOMIES_PUSH_DISABLED: [true, "character race abilities are retired"],
  IMPOSTER_ENABLED: [false, "Imposter is tombstoned"],
};
for (const [name, [value, note]] of Object.entries(retiredEnv)) {
  envMetadata[name] = ["retired_env", value, note, "environment_cleanup", value];
}

// Every environment read needs an explicit owner/disposition here. Keeping
// this finite inventory separate from source discovery is intentional: a new
// process.env read must fail CI until its operational semantics are reviewed.
const deploymentConfigEnv = [
  "ADMIN_APPLE_IDS", "ADMIN_EMAILS", "ADMIN_USER_IDS",
  "ADMOB_RACE_PAYOUT_DOUBLE_AD_UNIT_IDS", "AD_COIN_REWARD_AMOUNT",
  "AD_COIN_REWARD_DAILY_CAP", "ANDROID_PACKAGE",
  "ANDROID_SHA256_FINGERPRINTS", "ANDROID_UPDATE_URL", "APNS_BUNDLE_ID",
  "APNS_KEY_ID", "APNS_KEY_PATH", "APNS_SIGNING_KEY", "APNS_TEAM_ID",
  "APPLE_AUDIENCE", "APP_REVIEW_EMAIL", "APP_REVIEW_PASSWORD",
  "APP_STORE_URL", "APP_URL_SCHEME", "ASSET_BASE_URL",
  "ASYNC_RACE_RESOLUTION_CONCURRENCY", "BOUNTY_PAYOUT_COINS",
  "CACHE_ENV_PREFIX", "CACHE_INVALIDATE_RETRY_MS", "CAPACITY_AUTH_SECRET",
  "CAPACITY_DB_HOST_ALLOWLIST", "CAPACITY_DB_MARKER", "CAPACITY_DB_NAME",
  "CAPACITY_JWT_SECRET", "CAPACITY_PGBOUNCER_ADMIN_URL",
  "CAPACITY_PHASE_METRICS_SAMPLE_RATE", "CAPACITY_REDIS_HOST_ALLOWLIST",
  "CAPACITY_RUN_ID", "CRON_START_DELAY_MS", "DAILY_SPIN_RARE_COINS_SHARE",
  "DATABASE_URL", "FCM_SERVICE_ACCOUNT", "FCM_SERVICE_ACCOUNT_PATH",
  "FINE_BUCKET_MIN_APP_VERSION", "GLOBAL_STEP_EVENT_CRON_EXPECTED_OWNERS",
  "GLOBAL_STEP_EVENT_CRON_OWNER_ID", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_AUTH_CLIENT_ID", "HIGH_MULTIPLIER_PUSH_THRESHOLD", "HOST",
  "IOS_APP_ID", "IOS_UPDATE_URL", "LATEST_APP_VERSION",
  "LEADERBOARD_CACHE_LOCK_MS", "LEADERBOARD_CACHE_WAIT_MS",
  "MIN_SUPPORTED_APP_VERSION", "NODE_APP_INSTANCE", "NODE_ENV",
  "NODE_TEST_CONTEXT", "OG_IMAGE_URL", "PAYOUT_DROP_WINDOW_HOURS",
  "PEER_DATABASE_URL", "PIGGY_BANK_COIN_CAP", "PIGGY_BANK_STEPS_PER_COIN",
  "PLAY_STORE_URL", "PORT", "POWERUP_DISCARD_DAILY_COIN_CAP",
  "POWERUP_UNLOCK_DAILY_CAP", "POWERUP_UNLOCK_MAX_SHORTFALL",
  "PRIZE_COIN_UNIT", "PRIZE_POOL_MAX_COINS", "PROD_DATABASE_URL",
  "PUBLIC_BASE_URL", "RACE_PAYOUT_DOUBLE_MAX_BONUS_COINS",
  "RACE_QUEUE_V2_QUIET_PERIOD_MS", "RACE_RESOLVE_DEBOUNCE_MS", "REDIS_URL",
  "REFERRAL_DAILY_CAP", "REFERRAL_IP_FALLBACK_MAX_OPENS",
  "REFERRAL_IP_FALLBACK_NET_MAX_OPENS",
  "REFERRAL_IP_FALLBACK_WINDOW_HOURS", "REFERRAL_IP_HMAC_ACTIVE_VERSION",
  "REFERRAL_IP_HMAC_ENABLED_AT", "REFERRAL_IP_HMAC_SECRET_V*",
  "REFERRAL_MONTHLY_CAP", "REFERRAL_QUALIFY_WINDOW_DAYS",
  "REFERRAL_REFEREE_COINS", "REFERRAL_REFERRER_COINS", "S3_ACCESS_KEY_ID",
  "S3_AVATAR_PREFIX", "S3_BUCKET", "S3_PRESIGNED_URL_EXPIRES_SECONDS",
  "S3_PUBLIC_BASE_URL", "S3_REGION", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  "SESSION_TOKEN_SECRET", "STAGING_DATABASE_URL", "STEPS_PROCESS_ROLE",
  "TEAM_POOL_MULT_LONG",
  "TEAM_POOL_MULT_MID", "TEAM_POOL_MULT_SHORT",
];
for (const name of deploymentConfigEnv) {
  envMetadata[name] = [
    "deployment_config", null, "runtime value; see source consumers",
    "runtime_configuration", null,
  ];
}

const compatibilityFields = {
  characterPowersEnabled: false,
  teamRacesEnabled: true,
  customRaceWindowEnabled: true,
  onboardingV2Enabled: true,
  onboardingV3Enabled: true,
  onboardingInviteCodeEnabled: false,
  openUserRaceDiscoveryEnabled: true,
  quickCreateRaceCtaEnabled: true,
  setupInviteCodePromptEnabled: true,
  homeInviteModalEnabled: true,
  tutorialMandatoryEnabled: true,
  stepSampleBucketMinutes: 5,
};

function dbDisposition(name) {
  if (retainedDb.has(name)) return "retained_operational";
  if (deploymentProtocolDb.has(name)) return "deployment_protocol";
  throw new Error(`Missing disposition for mutable AppSetting ${name}`);
}

function permanentDeployFamily(name) {
  if (requestApiDb.has(name)) return "request_api";
  if (redisDb.has(name)) return "redis_fail_open";
  if (workerDb.has(name)) return "race_resolution_workers";
  if (productDb.has(name)) return "product_onboarding";
  throw new Error(`Missing deploy family for permanent AppSetting ${name}`);
}

function entryBase(id, name, kind) {
  return {
    id, name, kind, evidenceTimestamp: EVIDENCE_AT,
    compatibilityConsumers: [], adminExposed: false,
  };
}

function buildManifest() {
  const controls = [];
  for (const [name, fallback] of Object.entries(KNOWN_FLAGS).sort()) {
    controls.push({
      ...entryBase(`appSetting:${name}`, name, typeof fallback === "string" ? "string_app_setting" : typeof fallback === "number" ? "numeric_app_setting" : "boolean_app_setting"),
      disposition: dbDisposition(name), permanentValue: null,
      polarityDefault: fallback, deployFamily: "database_controls",
      rollbackValue: fallback,
      adminExposed: ADMIN_EXPOSED_FLAGS.includes(name),
    });
  }
  for (const [name, value] of Object.entries(PERMANENT_FLAGS).sort()) {
    controls.push({
      ...entryBase(
        `retiredAppSetting:${name}`,
        name,
        typeof value === "number"
          ? "numeric_app_setting"
          : "boolean_app_setting",
      ),
      disposition: value === false
        ? "retired_permanent_off"
        : "graduated_permanent",
      permanentValue: value,
      polarityDefault: value,
      deployFamily: permanentDeployFamily(name),
      rollbackValue: value,
    });
  }
  const runtimeEnvironmentReads = collectRuntimeEnvironmentReads();
  assertExplicitEnvironmentMetadata(runtimeEnvironmentReads);
  const environmentNames = [...new Set([
    ...Object.keys(envMetadata),
    ...runtimeEnvironmentReads.keys(),
  ])].sort();
  for (const name of environmentNames) {
    const metadata = envMetadata[name];
    const [disposition, permanentValue, polarityDefault, deployFamily, rollbackValue] = metadata;
    controls.push({
      ...entryBase(`env:${name}`, name, environmentKind(name, metadata)),
      disposition, permanentValue, polarityDefault, deployFamily, rollbackValue,
      compatibilityConsumers: disposition === "legacy_compatibility" ? ["older backend artifact rollback"] : [],
    });
  }
  for (const [name, value] of Object.entries(compatibilityFields).sort()) {
    controls.push({
      ...entryBase(`response:/auth/me.featureFlags.${name}`, name, "compatibility_response_field"),
      disposition: "retained_compatibility_constant", permanentValue: value,
      polarityDefault: value, deployFamily: "auth_contract", rollbackValue: value,
      compatibilityConsumers: ["frozen iOS clients", "frozen Android clients"],
    });
  }
  const ids = controls.map((control) => control.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate runtime-control IDs");
  return {
    generatedFrom: "scripts/generate-runtime-control-disposition.js",
    authoritativeSnapshot: EVIDENCE_AT,
    controls: controls.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptFiles(resolved));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(resolved);
  }
  return files;
}

function staticEnvironmentName(value) {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
  if (/^[A-Z][A-Z0-9_]*\*$/.test(value)) return value;
  return null;
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end" || key === "loc") continue;
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function isProcessEnv(node) {
  return node?.type === "MemberExpression" &&
    node.computed === false &&
    node.object?.type === "Identifier" &&
    node.object.name === "process" &&
    node.property?.type === "Identifier" &&
    node.property.name === "env";
}

function containsProcessEnv(node) {
  let found = false;
  walkAst(node, (candidate) => {
    if (isProcessEnv(candidate)) found = true;
  });
  return found;
}

function staticMemberName(property) {
  if (property?.type === "Identifier") {
    return staticEnvironmentName(property.name);
  }
  if (property?.type === "Literal" && typeof property.value === "string") {
    return staticEnvironmentName(property.value);
  }
  if (property?.type === "TemplateLiteral") {
    let value = "";
    for (let index = 0; index < property.quasis.length; index += 1) {
      value += property.quasis[index].value.cooked ?? property.quasis[index].value.raw;
      if (index < property.expressions.length) value += "*";
    }
    return staticEnvironmentName(value);
  }
  return null;
}

function collectRuntimeEnvironmentReads({
  directories = [path.join(ROOT, "src")],
} = {}) {
  const found = new Map();
  for (const file of directories.flatMap((directory) => javascriptFiles(directory))) {
    const source = fs.readFileSync(file, "utf8");
    const ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
    });
    const environmentAliases = new Set();
    walkAst(ast, (node) => {
      if (
        node.type === "AssignmentPattern" &&
        node.left?.type === "Identifier" &&
        containsProcessEnv(node.right)
      ) {
        environmentAliases.add(node.left.name);
      }
      if (
        node.type === "VariableDeclarator" &&
        node.id?.type === "Identifier" &&
        containsProcessEnv(node.init)
      ) {
        environmentAliases.add(node.id.name);
      }
    });
    let hasDynamicEnvironmentLookup = false;
    walkAst(ast, (node) => {
      if (node.type !== "MemberExpression") return;
      const direct = isProcessEnv(node.object);
      const aliased = node.object?.type === "Identifier" &&
        environmentAliases.has(node.object.name);
      if (!direct && !aliased) return;
      const name = staticMemberName(node.property);
      if (!name) {
        if (node.computed) hasDynamicEnvironmentLookup = true;
        return;
      }
      const relative = path.relative(ROOT, file);
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(relative);
    });
    // A helper such as env[legacy.name] deliberately separates the read from
    // its finite key table. In those files, uppercase string literals are the
    // independently discoverable key inventory feeding the computed lookup.
    if (hasDynamicEnvironmentLookup) {
      walkAst(ast, (node) => {
        if (node.type !== "Literal" || typeof node.value !== "string") return;
        const name = staticEnvironmentName(node.value);
        if (!name) return;
        const relative = path.relative(ROOT, file);
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(relative);
      });
    }
  }
  return found;
}

function environmentKind(name, metadata) {
  if (
    /(?:_CONCURRENCY|_MS|_HOURS|_DAYS|_COINS|_CAP|_RATE|_PERCENT|_THRESHOLD|_MAX_OPENS|_EXPECTED_OWNERS|_EXPIRES_SECONDS|_MULT_(?:SHORT|MID|LONG)|_VERSION|^PORT$)$/.test(name)
  ) {
    return "numeric_environment";
  }
  const [disposition, permanentValue, polarityDefault] = metadata;
  if (
    typeof permanentValue === "boolean" ||
    /literal (?:true|false)|default (?:on|off)/i.test(String(polarityDefault)) ||
    ["retained_operational", "retained_nonproduction_security", "retired_env", "legacy_compatibility"].includes(disposition)
  ) {
    return "boolean_environment";
  }
  return "string_environment";
}

function assertExplicitEnvironmentMetadata(found) {
  const missing = [...found.keys()]
    .filter((name) => !Object.prototype.hasOwnProperty.call(envMetadata, name))
    .sort();
  if (missing.length) {
    throw new Error(
      `${missing.join(", ")} missing explicit envMetadata`,
    );
  }
}

function verifyRuntimeEnvInventory(options = {}) {
  assertExplicitEnvironmentMetadata(collectRuntimeEnvironmentReads(options));
}

function serialize(manifest) {
  // JSON is a strict subset of YAML 1.2 and gives CI a dependency-free,
  // deterministic representation while keeping the requested .yaml artifact.
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (require.main === module) {
  verifyRuntimeEnvInventory();
  const rendered = serialize(buildManifest());
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
    if (current !== rendered) {
      console.error("docs/runtime-control-disposition.yaml is stale; regenerate it");
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(OUTPUT, rendered);
    console.log(path.relative(ROOT, OUTPUT));
  }
}

module.exports = {
  buildManifest,
  collectRuntimeEnvironmentReads,
  verifyRuntimeEnvInventory,
};
