const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

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
});
