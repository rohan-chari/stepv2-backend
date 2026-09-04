const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  resolutionWakeOptions,
} = require("../../src/modules/steps/commands/recordStepSyncV2");

test("step sync uses lock-and-revalidate semantics without broad repeatable-read snapshots", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/modules/steps/commands/recordStepSyncV2.js"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /isolationLevel:\s*["']RepeatableRead["']/,
    "shared race queue rows must wait and merge instead of aborting every sync on a stale snapshot",
  );
  assert.doesNotMatch(
    source,
    /could not serialize access|SERIALIZATION_RETRIES|isSerializationConflict/,
    "ordinary queue contention must not be handled by replaying the whole step transaction",
  );
  assert.match(
    source,
    /SUMMARY_CAPTURE_CLOSURE_CHANGED/,
    "the rare summary dependency-change retry must remain explicit and narrowly scoped",
  );
  assert.doesNotMatch(
    source,
    /const existing = await stepSyncRequestModel\.findByKey\(userId, idempotencyKey\)/,
    "a fresh unique idempotency key must not pay for a preflight read before its atomic insert",
  );
});

test("step sync classifies durable resolution wakes from committed intake scope", () => {
  assert.deepEqual(
    resolutionWakeOptions({ hasFullScopeResolutionWork: false }),
    { workKind: "ordinary" },
  );
  assert.deepEqual(
    resolutionWakeOptions({ hasFullScopeResolutionWork: true }),
    { workKind: "full-trigger" },
  );
  assert.deepEqual(
    resolutionWakeOptions(null),
    {},
  );
});

test("summary capture snapshots mutable scoring facts without a broad dependency lock", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/modules/steps/services/globalEventSummaryCapture.js"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /FROM user_scoring_input_versions[\s\S]{0,300}ORDER BY user_id ASC[\s\S]{0,80}FOR UPDATE/,
    "captures in different races must not serialize on shared scoring-input rows",
  );
  assert.match(
    source,
    /WITH dependencies AS MATERIALIZED[\s\S]*FROM step_samples sample[\s\S]*UNION ALL[\s\S]*FROM steps daily[\s\S]*UNION ALL[\s\S]*FROM user_scoring_input_versions version/,
    "samples, daily totals, and generation witnesses must share one statement snapshot",
  );
  assert.match(
    source,
    /inputVersions\.length !== dependencyUserIds\.length/,
    "capture must reject an incomplete generation-witness snapshot",
  );
});

test("summary capture keeps the uploader scoring fence before race C0 for rolling workers", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/modules/steps/services/globalEventSummaryCapture.js"),
    "utf8",
  );
  const captureStart = source.indexOf("async function lockEligibleSummaryCaptureDependencies");
  const uploaderFence = source.indexOf(
    'WHERE user_id=$1\n      FOR UPDATE`,\n    userId',
    captureStart,
  );
  const raceFence = source.indexOf("await acquireRaceWriteFences(tx, raceIds)", captureStart);

  assert.ok(uploaderFence > captureStart, "capture must retain the uploader's scoring-input fence");
  assert.ok(raceFence > uploaderFence, "the uploader fence must precede race C0");
});
