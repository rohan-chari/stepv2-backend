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
