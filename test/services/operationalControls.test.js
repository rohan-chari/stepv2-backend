const assert = require("node:assert/strict");
const test = require("node:test");

const {
  adValueEnabled,
  destructiveCleanupDisabled,
  raceResolutionIntakeDisabled,
  raceResolutionPostTaskWorkerDisabled,
  raceResolutionWorkerDisabled,
  userFanoutDisabled,
} = require("../../src/shared/config/operationalControls");
const {
  buildAppSettings,
  PERMANENT_FLAGS,
} = require("../../src/shared/config/appSettings");

test("user fan-outs honor the consolidated brake and their legacy brake", () => {
  assert.equal(userFanoutDisabled("LIVE_PLACEMENT_DISABLED", {}), false);
  assert.equal(
    userFanoutDisabled("LIVE_PLACEMENT_DISABLED", {
      OPS_USER_FANOUTS_DISABLED: "true",
      LIVE_PLACEMENT_DISABLED: "false",
    }),
    true,
  );
  assert.equal(
    userFanoutDisabled("LIVE_PLACEMENT_DISABLED", {
      OPS_USER_FANOUTS_DISABLED: "false",
      LIVE_PLACEMENT_DISABLED: "true",
    }),
    true,
  );
});

test("destructive cleanups honor the consolidated brake and their legacy brake", () => {
  assert.equal(
    destructiveCleanupDisabled("STEP_SAMPLE_RETENTION_DISABLED", {}),
    false,
  );
  assert.equal(
    destructiveCleanupDisabled("STEP_SAMPLE_RETENTION_DISABLED", {
      OPS_DESTRUCTIVE_CLEANUPS_DISABLED: "true",
    }),
    true,
  );
  assert.equal(
    destructiveCleanupDisabled("STEP_SAMPLE_RETENTION_DISABLED", {
      STEP_SAMPLE_RETENTION_DISABLED: "true",
    }),
    true,
  );
});

test("resolution intake, core worker, and post-task worker have independent brakes", () => {
  assert.equal(raceResolutionIntakeDisabled({}), false);
  assert.equal(
    raceResolutionIntakeDisabled({ ASYNC_RACE_RESOLUTION_DISABLED: "true" }),
    true,
  );
  assert.equal(
    raceResolutionIntakeDisabled({
      OPS_RACE_RESOLUTION_INTAKE_DISABLED: "true",
    }),
    true,
  );
  assert.equal(
    raceResolutionWorkerDisabled({
      OPS_RACE_RESOLUTION_INTAKE_DISABLED: "true",
    }),
    false,
  );
  assert.equal(
    raceResolutionWorkerDisabled({
      ASYNC_RACE_RESOLUTION_WORKER_DISABLED: "true",
    }),
    true,
  );
  assert.equal(
    raceResolutionPostTaskWorkerDisabled({
      RACE_RESOLUTION_POST_TASK_WORKER_DISABLED: "true",
    }),
    true,
  );
  assert.equal(
    raceResolutionPostTaskWorkerDisabled({
      OPS_RACE_RESOLUTION_WORKER_DISABLED: "true",
    }),
    false,
  );
});

test("ad-value master brake wins while legacy switches keep their exact polarity", () => {
  assert.equal(adValueEnabled("extraSpin", {}), true);
  assert.equal(adValueEnabled("coinReward", {}), true);
  assert.equal(adValueEnabled("boxReroll", {}), false);
  assert.equal(adValueEnabled("payoutPrepare", {}), false);
  assert.equal(adValueEnabled("payoutClaim", {}), false);
  assert.equal(adValueEnabled("payoutReconcile", {}), false);

  assert.equal(adValueEnabled("extraSpin", { ADS_EXTRA_SPIN_ENABLED: "false" }), false);
  assert.equal(adValueEnabled("coinReward", { ADS_COIN_REWARD_ENABLED: "false" }), false);
  assert.equal(adValueEnabled("boxReroll", { ADS_BOX_REROLL_ENABLED: "true" }), true);
  assert.equal(
    adValueEnabled("payoutPrepare", {
      ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED: "true",
    }),
    true,
  );
  assert.equal(
    adValueEnabled("payoutClaim", {
      ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED: "true",
    }),
    true,
  );
  assert.equal(
    adValueEnabled("payoutReconcile", {
      RACE_PAYOUT_DOUBLE_RECONCILE_ENABLED: "true",
    }),
    true,
  );

  for (const kind of [
    "extraSpin",
    "coinReward",
    "boxReroll",
    "payoutPrepare",
    "payoutClaim",
    "payoutReconcile",
  ]) {
    assert.equal(
      adValueEnabled(kind, {
        OPS_AD_VALUE_ISSUANCE_DISABLED: "true",
        ADS_EXTRA_SPIN_ENABLED: "true",
        ADS_COIN_REWARD_ENABLED: "true",
        ADS_BOX_REROLL_ENABLED: "true",
        ADS_RACE_PAYOUT_DOUBLE_PREPARE_ENABLED: "true",
        ADS_RACE_PAYOUT_DOUBLE_CLAIM_ENABLED: "true",
        RACE_PAYOUT_DOUBLE_RECONCILE_ENABLED: "true",
      }),
      false,
    );
  }
});

test("unknown legacy ownership or ad kind is rejected", () => {
  assert.throws(() => userFanoutDisabled("TYPO_DISABLED", {}), /Unknown user fan-out/);
  assert.throws(
    () => destructiveCleanupDisabled("TYPO_DISABLED", {}),
    /Unknown destructive cleanup/,
  );
  assert.throws(() => adValueEnabled("typo", {}), /Unknown ad-value kind/);
});

test("graduated controls reject writes and deployment-protocol controls stay out of admin settings", async () => {
  const prisma = {
    appSetting: {
      findMany: async () => [],
    },
  };
  const settings = buildAppSettings({ prisma, allowPermanentOverrides: false });

  assert.equal(PERMANENT_FLAGS.teamRacesEnabled, true);
  await assert.rejects(
    settings.setFlag("teamRacesEnabled", false),
    /Unknown setting: teamRacesEnabled/,
  );
  const adminSettings = await settings.getAllFlags();
  assert.equal("teamRacesEnabled" in adminSettings, false);
  assert.equal("raceQueueV2ClaimingDisabled" in adminSettings, false);
  assert.equal("inlineRaceResolutionFallback" in adminSettings, false);
  assert.equal(adminSettings.capacityPhaseMetricsV1Enabled, false);
  assert.equal(adminSettings.racePreviewEnabled, false);
  assert.equal(adminSettings.homeServiceBannerEnabled, false);
});
