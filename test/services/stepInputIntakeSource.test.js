const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");

test("canonical intake has one full canonical sample read and bounded uploader race discovery", () => {
  const intake = fs.readFileSync(path.join(root, "src/modules/steps/services/stepInputIntake.js"), "utf8");
  assert.doesNotMatch(intake, /beforeSamples/);
  assert.match(intake, /canonicalInput/);
  assert.match(intake, /FROM races race\s+JOIN race_participants participant/);
  assert.doesNotMatch(intake, /participants:\s*\{/);
  assert.match(
    intake,
    /UPDATE users\s+SET last_step_sync_at = GREATEST/,
    "the sync timestamp must reuse the intake transaction's checked-out connection",
  );
});

test("step command setting reads are sequential and post-commit emission is best-effort", () => {
  for (const relative of [
    "src/modules/steps/commands/recordSteps.js",
    "src/modules/steps/commands/recordStepSamples.js",
    "src/modules/steps/commands/recordStepSyncV2.js",
  ]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /Promise\.all\(\[\s*isStrictFlagEnabled/);
  }
  const recordSteps = fs.readFileSync(path.join(root, "src/modules/steps/commands/recordSteps.js"), "utf8");
  assert.match(recordSteps, /step event emission failed/);
});
