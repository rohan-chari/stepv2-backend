const assert = require("node:assert/strict");
const test = require("node:test");

const {
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
} = require("../../src/shared/config/appSettings");
const {
  readPerformanceFlags,
} = require("../../src/shared/config/performanceFlags");

const NEW_PERMANENT_VALUES = Object.freeze({
  redisCacheCatalogsEnabled: true,
  redisCacheMessagesEnabled: true,
  redisStandingsEnabled: true,
  redisCacheUserBitsEnabled: true,
  redisCacheAuthMeEnabled: true,
  redisCacheDiscardCapEnabled: true,
  redisPresentationGenerationGuardEnabled: true,
  redisCacheLeaderboardEnabled: true,
  redisCacheFriendsEnabled: true,
  redisFriendSearchRateLimitEnabled: true,
  redisCacheHomeActiveGlobalEventEnabled: true,
  redisCacheHomeImpactSummaryEnabled: true,
  redisCacheHomeInboxUnreadEnabled: true,
  redisCacheRaceListEnabled: true,

  raceResolutionDisplayArtifactReuseV1Enabled: true,
  raceResolutionReasonAwareV1Enabled: true,
  raceResolutionBurstCoalescingV1Enabled: true,
  raceResolutionQueuedGenerationMergeV1Enabled: true,
  raceResolutionBulkWriteV1Enabled: true,
  raceResolutionPostTasksV1Enabled: true,
  raceResolutionNudgeBatchV1Enabled: true,
  raceResolutionAdaptiveDrainV1Enabled: true,
  raceResolutionPostTaskAdaptiveDrainV1Enabled: true,
  raceResolutionPendingImpactOnlyV1Enabled: true,
  raceResolutionNarrowDefenseQueryV1Enabled: true,
  raceResolutionActiveImpactBulkPersistV1Enabled: false,
  raceResolutionPostTaskFastHandoffV1Enabled: false,
  raceResolutionNoopInputSuppressionV1Enabled: false,

  teamRacesEnabled: true,
  tournamentsEnabled: true,
  quickCreateRaceCtaEnabled: true,
  customRaceWindowEnabled: true,
  discoverableIdentityOnboardingEnrollmentEnabled: true,
  racesInviteDecisionGateEnabled: true,
  quickRaceShareAutoFriendEnabled: true,
  seededRaceBucketsEnabled: true,
  racePayoutDoubleRolloutPercent: 100,
  payoutRoundingV1Enabled: true,
  raceExitActionsEnabled: true,
  stepSampleBucketMinutes: 5,
  onboardingV2Enabled: false,
  onboardingV3Enabled: true,
  onboardingInviteCodeEnabled: false,
  tutorialMandatoryEnabled: true,
  dualBoxBannersEnabled: true,
  seededGeometricPayoutsEnabled: true,
  seededInactivityPruneEnabled: true,
  apiActiveImpactNoticesV1Enabled: false,
  apiCompletedImpactPopupEnabled: false,
  fundedPrizePoolsEnabled: true,
  buyInEditEnabled: false,
  openUserRaceDiscoveryEnabled: true,
  setupInviteCodePromptEnabled: true,
  homeInviteModalEnabled: true,
  localGlobalStepEventsEnabled: true,
  localGlobalStepEventRetentionEnabled: true,
  adminMetricsV2DashboardEnabled: true,
  adminMetricsV2TelemetryEnabled: true,
  seededInactivityAutoEnrollOffEnabled: true,
  accessoryCompatibilityEnforcement: true,
});

const RETAINED_MUTABLE_VALUES = Object.freeze({
  activeCompetitionLimit: 20,
  capacityPhaseMetricsV1Enabled: false,
  racePreviewEnabled: false,
  raceQueueV2ClaimingDisabled: false,
  inlineRaceResolutionFallback: false,
  homeServiceBannerEnabled: false,
  homeServiceBannerMessage: "",
  homeServiceBannerContestSlug: "",
  bannerAdsEnabled: true,
});

test("remaining eligible AppSettings are permanent and only approved gates stay mutable", () => {
  assert.equal(Object.keys(PERMANENT_FLAGS).length, 92);
  for (const [key, value] of Object.entries(NEW_PERMANENT_VALUES)) {
    assert.equal(PERMANENT_FLAGS[key], value, key);
    assert.equal(Object.hasOwn(KNOWN_FLAGS, key), false, key);
  }
  assert.deepEqual(KNOWN_FLAGS, RETAINED_MUTABLE_VALUES);
});

test("graduated performance paths ignore stale environment switches", () => {
  const flags = readPerformanceFlags({
    PLACEMENT_DISTRIBUTED_CLAIM_ENABLED: "false",
    PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED: "false",
    PLACEMENT_LEAN_BASELINE_WRITES_ENABLED: "false",
    STEP_SYNC_BULK_ENABLED: "false",
    APNS_SESSION_REUSE_ENABLED: "false",
    PLACEMENT_BASELINE_WRITE_CONCURRENCY: "8",
    STEP_SYNC_PUSH_CONCURRENCY: "16",
  });
  assert.deepEqual(flags, {
    placementDistributedClaimEnabled: true,
    placementInertPushSuppressionEnabled: true,
    placementLeanBaselineWritesEnabled: true,
    stepSyncBulkEnabled: true,
    apnsSessionReuseEnabled: true,
    placementBaselineWriteConcurrency: 8,
    stepSyncPushConcurrency: 16,
  });
});
