const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Race Completion — race ends after top 3 finish (or all if <3 participants)
// Placement is determined by finishedAt order (who crossed first).
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    finishedAt: null,
    placement: null,
    user: { displayName },
    ...overrides,
  };
}

const RACE_START = new Date("2026-03-28T08:00:00Z");
const NOW = new Date("2026-03-30T12:00:00Z");

function makeDeps(overrides = {}) {
  const finishCalls = [];
  const completeCalls = [];
  const placementCalls = [];

  const participants = overrides.participants || [];

  return {
    finishCalls,
    completeCalls,
    placementCalls,
    deps: {
      Race: {
        async findById() {
          return {
            id: "race-1",
            status: "ACTIVE",
            targetSteps: overrides.targetSteps || 10000,
            startedAt: RACE_START,
            endsAt: new Date("2026-04-04T08:00:00Z"),
            powerupsEnabled: false,
            powerupStepInterval: null,
            participants,
          };
        },
      },
      StepSample: {
        async sumStepsInWindow(userId, start, end) {
          if (overrides.sumStepsInWindow) {
            return overrides.sumStepsInWindow(userId, start, end);
          }
          const p = participants.find((p) => p.userId === userId);
          return p?._rawSteps || 0;
        },
      },
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async updateTotalSteps() {},
        async markFinished(id, time) { finishCalls.push({ id, time }); },
        async setPlacement(id, placement) { placementCalls.push({ id, placement }); },
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType() { return []; },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return []; },
        async countMysteryBoxesByParticipant() { return 0; },
        async findMysteryBoxesByParticipant() { return []; },
      },
      expireEffects: async () => {},
      completeRace: async (data) => { completeCalls.push(data); },
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

// ===========================================================================
// 2-person race — completes after 1st place finishes
// ===========================================================================

test("2-person race: completes when 1st place finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 5000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-1");
  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

test("2-person race: does NOT wait for 2nd place", async () => {
  // Only user-1 crosses target — race should complete immediately
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.completeCalls.length, 1);
});

// ===========================================================================
// 3-person race — completes after all 3 finish (since exactly 3 participants)
// ===========================================================================

test("3-person race: does NOT complete when only 1st finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 5000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  // user-1 should be marked finished
  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-1");
  // But race should NOT complete yet
  assert.equal(ctx.completeCalls.length, 0);
});

test("3-person race: does NOT complete when only 2 have finished", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  // user-2 should be marked finished
  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-2");
  // Race still should NOT complete — waiting for 3rd
  assert.equal(ctx.completeCalls.length, 0);
});

test("3-person race: completes when 3rd finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 13000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-3", "race-1", "America/New_York");

  // user-3 should be marked finished
  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-3");
  // NOW the race completes
  assert.equal(ctx.completeCalls.length, 1);
  // Winner is still user-1 (first to cross)
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

// ===========================================================================
// 4+ person race — completes after top 3 finish
// ===========================================================================

test("4-person race: does NOT complete when only 1st finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 5000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 2000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.completeCalls.length, 0);
});

test("4-person race: does NOT complete when only 2 have finished", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 2000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.completeCalls.length, 0);
});

test("4-person race: completes when 3rd place finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 18000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 4000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-3", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-3");
  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

test("4-person race: 4th place finishing does NOT trigger a second completion", async () => {
  // Race already completed after top 3 — 4th crossing should not re-complete
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 20000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 18000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-30T08:00:00Z"), placement: 3,
      }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-4", "race-1", "America/New_York");

  // user-4 should be marked finished
  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.finishCalls[0].id, "rp-4");
  // But completeRace should NOT be called again
  assert.equal(ctx.completeCalls.length, 0);
});

// ===========================================================================
// Placement assignment
// ===========================================================================

test("1st person to cross target gets placement 1", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 5000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  const p1Placement = ctx.placementCalls.find((c) => c.id === "rp-1");
  assert.ok(p1Placement, "placement should be set for user-1");
  assert.equal(p1Placement.placement, 1);
});

test("2nd person to cross target gets placement 2", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  const p2Placement = ctx.placementCalls.find((c) => c.id === "rp-2");
  assert.ok(p2Placement, "placement should be set for user-2");
  assert.equal(p2Placement.placement, 2);
});

test("3rd person to cross target gets placement 3", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 18000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 4000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-3", "race-1", "America/New_York");

  const p3Placement = ctx.placementCalls.find((c) => c.id === "rp-3");
  assert.ok(p3Placement, "placement should be set for user-3");
  assert.equal(p3Placement.placement, 3);
});

test("4th person to cross gets no podium placement (null or 4+)", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 20000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 18000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-30T08:00:00Z"), placement: 3,
      }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-4", "race-1", "America/New_York");

  const p4Placement = ctx.placementCalls.find((c) => c.id === "rp-4");
  // 4th place should get placement 4 (not a podium spot, but still tracked)
  assert.ok(p4Placement, "placement should be set for user-4");
  assert.equal(p4Placement.placement, 4);
});

// ===========================================================================
// Multiple people crossing target in the same progress tick
// ===========================================================================

test("Multiple people crossing target simultaneously get correct placements", async () => {
  // Both user-1 and user-2 cross the target in the same tick, no one has finished before
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 3000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  // Both should be marked finished
  assert.equal(ctx.finishCalls.length, 2);

  // Both get placements
  assert.equal(ctx.placementCalls.length, 2);

  // Higher steps = 1st (user-1 at 12000 beats user-2 at 11000)
  const p1 = ctx.placementCalls.find((c) => c.id === "rp-1");
  const p2 = ctx.placementCalls.find((c) => c.id === "rp-2");
  assert.equal(p1.placement, 1);
  assert.equal(p2.placement, 2);
});

test("All 3 crossing simultaneously in a 3-person race completes it", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 13000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 3);
  assert.equal(ctx.completeCalls.length, 1);
  // Winner is user-1 (highest steps when crossing simultaneously)
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");

  const p1 = ctx.placementCalls.find((c) => c.id === "rp-1");
  const p2 = ctx.placementCalls.find((c) => c.id === "rp-2");
  const p3 = ctx.placementCalls.find((c) => c.id === "rp-3");
  assert.equal(p1.placement, 1);
  assert.equal(p2.placement, 2);
  assert.equal(p3.placement, 3);
});

// ===========================================================================
// Winner is always the first to cross, not the highest stepper
// ===========================================================================

test("Winner is the first to cross even if a later finisher has more steps", async () => {
  // user-1 finished first with 12000 steps
  // user-2 finishes now with 15000 steps (more than user-1)
  // user-1 should still be the winner
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 15000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-3", "race-1", "America/New_York");

  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});

// ===========================================================================
// 1-person race (edge case)
// ===========================================================================

test("1-person race: completes immediately when they finish", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", { _rawSteps: 12000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-1", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");

  const p1 = ctx.placementCalls.find((c) => c.id === "rp-1");
  assert.equal(p1.placement, 1);
});

// ===========================================================================
// 5-person race — still top 3 triggers completion
// ===========================================================================

test("5-person race: does NOT complete after 2nd finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 20000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 5000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 4000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-5", "user-5", "Eve", { _rawSteps: 2000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-2", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.completeCalls.length, 0);
});

test("5-person race: completes when 3rd finishes", async () => {
  const ctx = makeDeps({
    targetSteps: 10000,
    participants: [
      makeParticipant("rp-1", "user-1", "Alice", {
        _rawSteps: 20000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T10:00:00Z"), placement: 1,
      }),
      makeParticipant("rp-2", "user-2", "Bob", {
        _rawSteps: 16000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0,
        finishedAt: new Date("2026-03-29T14:00:00Z"), placement: 2,
      }),
      makeParticipant("rp-3", "user-3", "Carol", { _rawSteps: 11000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-4", "user-4", "Dave", { _rawSteps: 4000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
      makeParticipant("rp-5", "user-5", "Eve", { _rawSteps: 2000, joinedAt: RACE_START, baselineSteps: 0, nextBoxAtSteps: 0 }),
    ],
  });

  await buildGetRaceProgress(ctx.deps)("user-3", "race-1", "America/New_York");

  assert.equal(ctx.finishCalls.length, 1);
  assert.equal(ctx.completeCalls.length, 1);
  assert.equal(ctx.completeCalls[0].winnerUserId, "user-1");
});
