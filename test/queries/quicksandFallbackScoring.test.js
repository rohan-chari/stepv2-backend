const assert = require("node:assert/strict");
const test = require("node:test");
const { computeEffectModifiers } = require("../../src/modules/races/services/effectiveStepScoring");

test("Quicksand no-sample fallback freezes only steps accrued after application", async () => {
  const effect = {
    type: "QUICKSAND",
    startsAt: new Date("2026-07-22T10:00:00Z"),
    expiresAt: new Date("2026-07-22T12:00:00Z"),
    status: "ACTIVE",
    metadata: { stepsAtFreezeStart: 80 },
  };
  const result = await computeEffectModifiers(
    [effect], 100, "victim",
    { async sumStepsInWindow() { return 0; } },
    false
  );
  assert.equal(result.frozenSteps, 20);
});
