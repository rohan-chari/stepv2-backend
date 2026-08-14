const assert = require("node:assert/strict");
const test = require("node:test");

const {
  runBoundedRaceResolutionJobs,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

test("one lane does not start a second race-resolution job before the first settles", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;

  const ticking = runBoundedRaceResolutionJobs(1, async () => {
    calls += 1;
    await first;
    return { id: "first" };
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  releaseFirst();
  assert.equal(await ticking, 1);
});

test("two lanes claim and process distinct race-resolution jobs concurrently", async () => {
  const releases = [];
  let calls = 0;
  const started = [];

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    const id = ++calls;
    started.push(id);
    await new Promise((resolve) => releases.push(resolve));
    return { id: `job-${id}` };
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  releases.forEach((release) => release());
  assert.equal(await ticking, 2);
});

test("three lanes claim and process distinct race-resolution jobs concurrently", async () => {
  const releases = [];
  const started = [];

  const ticking = runBoundedRaceResolutionJobs(3, async () => {
    const id = started.length + 1;
    started.push(id);
    await new Promise((resolve) => releases.push(resolve));
    return { id: `job-${id}` };
  });

  await Promise.resolve();
  assert.deepEqual(started, [1, 2, 3]);
  releases.forEach((release) => release());
  assert.equal(await ticking, 3);
});

test("an empty lane does not prevent a claimed sibling job from completing", async () => {
  let calls = 0;
  const completed = await runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    return calls === 1 ? { id: "only-job" } : null;
  });

  assert.equal(completed, 1);
  assert.equal(calls, 2);
});

test("a failed lane waits for its running sibling before surfacing the failure", async () => {
  let releaseSibling;
  const sibling = new Promise((resolve) => {
    releaseSibling = resolve;
  });
  let calls = 0;
  let settled = false;

  const ticking = runBoundedRaceResolutionJobs(2, async () => {
    calls += 1;
    if (calls === 1) throw new Error("claim database unavailable");
    await sibling;
    return { id: "sibling" };
  });
  ticking.catch(() => {
    settled = true;
  });

  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(settled, false, "the helper must retain the sibling lane");

  releaseSibling();
  await assert.rejects(ticking, /claim database unavailable/);
  assert.equal(settled, true);
});

// ── Phase 2b shadow summary (pure) ────────────────────────────────────────────
// These are the serialization properties an integration test cannot express:
// the exact JSON shape of the emitted fields, including the tri-state that must
// survive as the STRING "UNKNOWN" and the closed-enum clamp on the reason.
const {
  summarizeClosureShadow,
  NULL_CLOSURE_SHADOW_FIELDS,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  TRAIL_MINE_ESCALATION_UNKNOWN,
} = require("../../src/modules/races/services/raceScoringDependencyClosure");

test("the shadow summary emits only aggregate fields for a closure plan", () => {
  const summary = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1", "p2"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: false,
      mines: [],
      participantTotals: { p9: { participantId: "p9", totalSteps: 12345 } },
      retainedUnresolvedSources: [],
    },
    7
  );
  assert.deepEqual(Object.keys(summary).sort(), Object.keys(NULL_CLOSURE_SHADOW_FIELDS).sort());
  assert.deepEqual(summary, {
    shadowClosurePlan: "DEPENDENCY_CLOSURE",
    shadowClosureFallbackReason: null,
    shadowClosureCount: 2,
    shadowSourceCount: 1,
    shadowMinesActive: false,
    shadowWouldEscalateOnMine: null,
    shadowPlannerMs: 7,
    shadowRetainedSourceCount: 0,
  });
  // The in-memory handoffs (ids, totals) never reach the serialized line.
  assert.equal(JSON.stringify(summary).includes("12345"), false);
  assert.equal(JSON.stringify(summary).includes("p9"), false);
});

test("the shadow summary serializes the Trail Mine tri-state as the string UNKNOWN", () => {
  const summary = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: true,
      mines: [{ id: "m1" }],
      participantTotals: {},
      retainedUnresolvedSources: [],
    },
    3,
    () => TRAIL_MINE_ESCALATION_UNKNOWN
  );
  assert.equal(summary.shadowWouldEscalateOnMine, "UNKNOWN");
  assert.equal(
    JSON.stringify(summary).includes('"shadowWouldEscalateOnMine":"UNKNOWN"'),
    true
  );
  // A definite verdict stays a boolean, never the string "true".
  const definite = summarizeClosureShadow(
    {
      plan: "DEPENDENCY_CLOSURE",
      participantIds: ["p1"],
      sourceParticipantIds: ["p1"],
      fallbackReason: null,
      minesActive: true,
      mines: [{ id: "m1" }],
      participantTotals: {},
    },
    3,
    () => true
  );
  assert.equal(definite.shadowWouldEscalateOnMine, true);
  assert.equal(definite.shadowRetainedSourceCount, null);
});

test("the shadow summary clamps a FULL plan's reason to the closed enum and sizes no closure", () => {
  const known = summarizeClosureShadow(
    {
      plan: "FULL",
      participantIds: [],
      sourceParticipantIds: ["p1", "p2"],
      fallbackReason: "RACE_WIDE_EFFECT_ACTIVE",
      minesActive: false,
    },
    1
  );
  assert.equal(known.shadowClosurePlan, "FULL");
  assert.equal(known.shadowClosureFallbackReason, "RACE_WIDE_EFFECT_ACTIVE");
  assert.equal(known.shadowClosureCount, null, "a FULL plan sizes no closure");
  assert.equal(known.shadowSourceCount, 2);
  assert.equal(known.shadowWouldEscalateOnMine, null);

  const unknownReason = summarizeClosureShadow(
    { plan: "FULL", participantIds: [], sourceParticipantIds: [], fallbackReason: "free text" },
    1
  );
  assert.equal(
    unknownReason.shadowClosureFallbackReason,
    null,
    "an off-enum reason must not widen the rollout dimension"
  );
});

test("the shadow summary of a missing planner result keeps only the measured duration", () => {
  assert.deepEqual(summarizeClosureShadow(null, 12), {
    ...NULL_CLOSURE_SHADOW_FIELDS,
    shadowPlannerMs: 12,
  });
});
