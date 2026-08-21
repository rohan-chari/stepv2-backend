const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");

const {
  buildManifest,
  collectRuntimeEnvironmentReads,
  verifyRuntimeEnvInventory,
} = require("../../scripts/generate-runtime-control-disposition");
const {
  ADMIN_EXPOSED_FLAGS,
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
} = require("../../src/shared/config/appSettings");

test("runtime-control manifest has unique complete control records", () => {
  verifyRuntimeEnvInventory();
  const manifest = buildManifest();
  const ids = manifest.controls.map((control) => control.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const control of manifest.controls) {
    for (const key of [
      "disposition", "permanentValue", "polarityDefault",
      "evidenceTimestamp", "deployFamily", "rollbackValue",
      "compatibilityConsumers", "adminExposed",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(control, key), true, `${control.id}.${key}`);
    }
  }
});

test("the manifest keeps operational settings mutable and records graduated controls", () => {
  const manifest = buildManifest();
  const byId = new Map(manifest.controls.map((control) => [control.id, control]));
  for (const [name, fallback] of Object.entries(KNOWN_FLAGS)) {
    const control = byId.get(`appSetting:${name}`);
    assert.ok(control, name);
    assert.equal(control.permanentValue, null, name);
    assert.equal(control.polarityDefault, fallback, name);
    assert.equal(control.adminExposed, ADMIN_EXPOSED_FLAGS.includes(name), name);
  }
  assert.equal(Object.keys(PERMANENT_FLAGS).length, 93);
  for (const [name, value] of Object.entries(PERMANENT_FLAGS)) {
    const control = byId.get(`retiredAppSetting:${name}`);
    assert.ok(control, name);
    assert.equal(
      control.disposition,
      value === false ? "retired_permanent_off" : "graduated_permanent",
      name,
    );
    assert.equal(control.permanentValue, value, name);
    assert.equal(control.adminExposed, false, name);
    assert.equal(byId.has(`appSetting:${name}`), false, name);
  }
});

test("eligible and explicitly approved recent families are permanent", () => {
  const byId = new Map(
    buildManifest().controls.map((control) => [control.id, control]),
  );
  for (const name of [
    "FUNDED_EXPOSURE_ENFORCEMENT_ENABLED",
    "FUNDED_PRIZE_V2_ENABLED",
  ]) {
    assert.equal(byId.has(`env:${name}`), false, name);
  }
  assert.equal(
    byId.get("retiredAppSetting:apiRaceListCompactV1Enabled").disposition,
    "graduated_permanent",
  );
  assert.equal(
    byId.get("retiredAppSetting:apiRaceListCompactV1Enabled").permanentValue,
    true,
  );
  for (const [id, value] of [
    ["retiredAppSetting:redisCacheCatalogsEnabled", true],
    ["retiredAppSetting:raceResolutionNoopInputSuppressionV1Enabled", false],
    ["retiredAppSetting:tutorialMandatoryEnabled", true],
    ["env:PLACEMENT_DISTRIBUTED_CLAIM_ENABLED", true],
    ["env:GLOBAL_EVENT_SUMMARY_DISABLED", false],
  ]) {
    assert.match(byId.get(id).disposition, /^(?:graduated_permanent|retired_permanent_off|retired_env)$/i, id);
    assert.equal(byId.get(id).permanentValue, value, id);
  }
  for (const [id, value] of [
    ["retiredAppSetting:localGlobalStepEventsEnabled", true],
    ["retiredAppSetting:adminMetricsV2DashboardEnabled", true],
    ["retiredAppSetting:accessoryCompatibilityEnforcement", true],
    ["retiredAppSetting:seededInactivityAutoEnrollOffEnabled", true],
    ["env:STEP_MILESTONE_REMINDERS_DISABLED", false],
  ]) {
    assert.match(byId.get(id).disposition, /^(?:graduated_permanent|retired_env)$/i, id);
    assert.equal(byId.get(id).permanentValue, value, id);
  }
  assert.equal(byId.has("appSetting:raceResolutionDependencyClosureV1Enabled"), false);
  assert.equal(byId.has("appSetting:raceResolutionDependencyClosureV1Percent"), false);
  for (const id of [
    "appSetting:raceQueueV2ClaimingDisabled",
    "appSetting:inlineRaceResolutionFallback",
  ]) {
    assert.equal(byId.get(id).disposition, "deployment_protocol", id);
    assert.equal(byId.get(id).adminExposed, false, id);
  }
});

test("source inventory independently covers bracket, helper, string, and numeric env reads", () => {
  const inventory = collectRuntimeEnvironmentReads();
  for (const name of [
    "ASYNC_RACE_RESOLUTION_CONCURRENCY",
    "TEAM_POOL_MULT_SHORT",
    "SESSION_TOKEN_SECRET",
    "S3_REGION",
    "S3_PUBLIC_BASE_URL",
    "S3_AVATAR_PREFIX",
    "S3_PRESIGNED_URL_EXPIRES_SECONDS",
    "OPS_USER_FANOUTS_DISABLED",
    "OPS_DESTRUCTIVE_CLEANUPS_DISABLED",
    "OPS_RACE_RESOLUTION_WORKER_DISABLED",
    "OPS_AD_VALUE_ISSUANCE_DISABLED",
  ]) {
    assert.equal(inventory.has(name), true, name);
  }
  const manifestByName = new Map(
    buildManifest().controls
      .filter((control) => control.id.startsWith("env:"))
      .map((control) => [control.name, control]),
  );
  for (const name of inventory.keys()) {
    assert.equal(manifestByName.has(name), true, `env:${name}`);
  }
  assert.equal(
    manifestByName.get("ASYNC_RACE_RESOLUTION_CONCURRENCY").kind,
    "numeric_environment",
  );
  assert.equal(
    manifestByName.get("SESSION_TOKEN_SECRET").kind,
    "string_environment",
  );
  for (const retiredName of [
    "GLOBAL_EVENT_SUMMARY_DISABLED",
    "PLACEMENT_DISTRIBUTED_CLAIM_ENABLED",
    "SYNC_V2_INLINE_UPLOADER_RECONCILIATION",
    "REFERRAL_IP_FALLBACK_NET_ENABLED",
  ]) {
    assert.equal(inventory.has(retiredName), false, retiredName);
    assert.equal(manifestByName.get(retiredName).disposition, "retired_env", retiredName);
  }
});

test("a newly discovered env read fails until it has explicit metadata", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-env-fixture-"));
  const fixture = path.join(fixtureRoot, "unclassified.js");
  fs.writeFileSync(
    fixture,
    'const sanitized = "x".replace(/[!\'()*]/g, "");\n' +
      'module.exports = [sanitized, process.env.NEW_UNCLASSIFIED_CONTROL];\n',
  );
  try {
    assert.throws(
      () => verifyRuntimeEnvInventory({ directories: [fixtureRoot] }),
      /NEW_UNCLASSIFIED_CONTROL.*explicit envMetadata/,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("checked-in runtime-control manifest is generated byte-for-byte", () => {
  const root = path.resolve(__dirname, "../..");
  const checkedIn = JSON.parse(
    fs.readFileSync(path.join(root, "docs/runtime-control-disposition.yaml"), "utf8"),
  );
  assert.deepEqual(checkedIn, buildManifest());
});
