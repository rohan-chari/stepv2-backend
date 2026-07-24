// Structural guard: effect scoring must read CLOSED buckets only.
//
// The prod bug (Maizehhh, 2026-07-24) was that the effect segment walk summed
// step samples including the still-filling in-progress bucket. Proration cuts a
// sample across its STAMPED span, so an open bucket gets re-cut on every
// recompute -- a ghost-pepper freeze then bled the victim's score down while she
// stood still and paid ~1.5x for steps walked while frozen.
//
// The fix routes the segment walk through `sumClosedStepsInWindows`. These are
// guards, not behavior tests (the behavior lives in
// test/integration/open-bucket-effect-scoring.test.js): they fail if a scoring
// model stops offering the closed variant and silently falls back to open-bucket
// sums, which would resurrect the bug without breaking any other assertion.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const { StepSample } = require("../../src/modules/steps/models/stepSample");
const {
  computeEffectModifiers,
} = require("../../src/modules/races/services/effectiveStepScoring");

const HOUR_MS = 60 * 60 * 1000;

function pepper(now) {
  return [
    {
      type: "GHOST_PEPPER",
      status: "ACTIVE",
      startsAt: new Date(now - 2 * HOUR_MS),
      expiresAt: new Date(now),
      metadata: { boostMs: HOUR_MS, freezeMs: HOUR_MS, multiplier: 3 },
    },
  ];
}

describe("effect scoring reads closed buckets only (structural guards)", () => {
  it("the real StepSample model exposes the batched closed-bucket sum", () => {
    assert.equal(
      typeof StepSample.sumClosedStepsInWindows,
      "function",
      "StepSample.sumClosedStepsInWindows is what the effect segment walk binds to"
    );
  });

  it("the home card's scoped sample model implements the closed variant too", () => {
    // Source-level guard: the scoped model is built inline inside the query and
    // has no exported handle. If it loses this method the home card silently
    // scores effects off OPEN buckets while GET /races/:id/progress uses closed
    // ones -- the two totals would disagree with nothing else failing.
    const src = fs.readFileSync(
      path.join(__dirname, "../../src/modules/home/getHomeRaceCard.js"),
      "utf8"
    );
    assert.ok(
      /async sumClosedStepsInWindows\(/.test(src),
      "getHomeRaceCard's scopedStepSamples must implement sumClosedStepsInWindows"
    );
  });

  it("the segment walk calls the CLOSED sum, not the open one", async () => {
    const now = Date.now();
    const calls = [];
    const model = {
      async sumStepsInWindows(_userId, windows) {
        calls.push("open");
        return windows.map(() => 100);
      },
      async sumClosedStepsInWindows(_userId, windows, at) {
        calls.push("closed");
        assert.ok(at != null, "the closed sum must receive `now`");
        return windows.map(() => 100);
      },
    };

    await computeEffectModifiers(pepper(now), 1000, "u1", model, true, null, new Date(now));

    assert.ok(calls.includes("closed"), "expected the closed-bucket sum to be used");
    assert.ok(!calls.includes("open"), `open-bucket sum must not be used, got ${calls.join(",")}`);
  });

  it("falls back cleanly for a model without the closed variant", async () => {
    // Older/external callers (e.g. the hitchhike clipped-sample wrapper) supply
    // only the open-bucket methods. They must keep scoring rather than throw.
    const now = Date.now();
    const model = {
      async sumStepsInWindow(_userId, _start, _end) {
        return 100;
      },
    };

    const r = await computeEffectModifiers(pepper(now), 1000, "u1", model, true, null, new Date(now));
    // Boost hour at 3x contributes (3-1)x100; the freeze hour contributes 100 frozen.
    assert.equal(r.buffedSteps, 200);
    assert.equal(r.frozenSteps, 100);
  });
});
