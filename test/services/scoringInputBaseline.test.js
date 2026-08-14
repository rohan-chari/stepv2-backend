const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertBaselineAuthorized,
} = require("../../scripts/baseline-race-scoring-input-versions");

test("baseline is disabled by default and test execution requires an explicit switch", () => {
  assert.throws(
    () => assertBaselineAuthorized({ databaseUrl: "postgresql://x/y_test", env: {} }),
    /disabled/
  );
  assert.doesNotThrow(() =>
    assertBaselineAuthorized({
      databaseUrl: "postgresql://x/y_test",
      env: { RACE_SCORING_INPUT_BASELINE_DISABLED: "false" },
    })
  );
});

test("non-test baseline requires an exact production confirmation", () => {
  assert.throws(
    () =>
      assertBaselineAuthorized({
        databaseUrl: "postgresql://x/live",
        env: { RACE_SCORING_INPUT_BASELINE_DISABLED: "false" },
      }),
    /confirmation/
  );
  assert.doesNotThrow(() =>
    assertBaselineAuthorized({
      databaseUrl: "postgresql://x/live",
      env: {
        RACE_SCORING_INPUT_BASELINE_DISABLED: "false",
        RACE_SCORING_INPUT_BASELINE_CONFIRM_DATABASE: "live",
      },
    })
  );
});
