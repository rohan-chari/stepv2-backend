const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Scenario: Race started on Mar 30. We're now on Mar 31.
// Subsequent days (after start day) should use StepSamples when available,
// falling back to daily Step records only when no samples exist.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z"); // 9 AM ET
const TZ_ET = "America/New_York";

// Samples across two days
const SAMPLES = [
  // Start day (Mar 30) — post-race
  { userId: "user-1", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
  { userId: "user-1", periodStart: "2026-03-30T14:00:00.000Z", periodEnd: "2026-03-30T15:00:00.000Z", steps: 700 },
  // Subsequent day (Mar 31) — samples exist
  { userId: "user-1", periodStart: "2026-03-31T12:00:00.000Z", periodEnd: "2026-03-31T13:00:00.000Z", steps: 1000 },
  { userId: "user-1", periodStart: "2026-03-31T13:00:00.000Z", periodEnd: "2026-03-31T14:00:00.000Z", steps: 800 },
];

function createStepSampleStore(samples) {
  return {
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const ws = new Date(windowStart).getTime();
      const we = new Date(windowEnd).getTime();
      return samples
        .filter(
          (s) =>
            s.userId === userId &&
            new Date(s.periodEnd).getTime() > ws &&
            new Date(s.periodStart).getTime() < we
        )
        .reduce((sum, s) => sum + s.steps, 0);
    },
  };
}

function createStepsStore(dailyRecords = {}, rangeRecords = {}) {
  return {
    async findByUserIdAndDate(userId, date) {
      return dailyRecords[`${userId}:${date}`] || null;
    },
    async findByUserIdAndDateRange(userId, from, to) {
      return (rangeRecords[userId] || []).filter(
        (r) => r.date >= from && r.date <= to
      );
    },
  };
}

function makeParticipant(id, userId, displayName) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    powerupSlots: 3,
    user: { displayName },
  };
}

function makeDeps({ samples, participants, dailyRecords, rangeRecords, now: nowFn } = {}) {
  const updates = [];

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-06T13:00:00.000Z"),
    powerupsEnabled: false,
    powerupStepInterval: 0,
    participants: participants || [
      makeParticipant("rp-1", "user-1", "TestUser"),
    ],
  };

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(samples || SAMPLES),
      Steps: createStepsStore(dailyRecords || {}, rangeRecords || {}),
      RaceParticipant: {
        async updateTotalSteps(id, totalSteps) { updates.push({ id, totalSteps }); },
        async markFinished() {},
        async setPlacement() {},
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
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: nowFn || (() => new Date("2026-03-31T15:00:00.000Z")), // 11 AM ET on Mar 31
    },
  };
}

function stepsFor(result, userId) {
  return result.participants.find((p) => p.userId === userId).totalSteps;
}

// ===========================================================================
// Subsequent days use StepSamples
// ===========================================================================

test("subsequent days use StepSamples when available, not daily records", async () => {
  // Daily records say 5000 for Mar 31, but samples only total 1800
  // Samples should win since they're more precise
  const { deps } = makeDeps({
    rangeRecords: {
      "user-1": [{ date: "2026-03-31", steps: 5000 }],
    },
  });
  const getRaceProgress = buildGetRaceProgress(deps);
  const result = await getRaceProgress("user-1", "race-1", TZ_ET);

  // Start day: 500 + 700 = 1200
  // Subsequent (Mar 31): samples = 1000 + 800 = 1800 (NOT 5000 from daily record)
  assert.equal(stepsFor(result, "user-1"), 3000);
});

test("subsequent days fall back to daily records when no samples exist", async () => {
  // No samples for Mar 31, so daily records are used
  const samplesStartDayOnly = SAMPLES.filter(
    (s) => s.periodStart.startsWith("2026-03-30")
  );
  const { deps } = makeDeps({
    samples: samplesStartDayOnly,
    rangeRecords: {
      "user-1": [{ date: "2026-03-31", steps: 2000 }],
    },
  });
  const getRaceProgress = buildGetRaceProgress(deps);
  const result = await getRaceProgress("user-1", "race-1", TZ_ET);

  // Start day: 500 + 700 = 1200
  // Subsequent: no samples → daily record = 2000
  assert.equal(stepsFor(result, "user-1"), 3200);
});

test("subsequent days with samples but no daily records uses samples", async () => {
  // Samples exist for Mar 31 but no daily step record
  const { deps } = makeDeps({
    rangeRecords: {},
  });
  const getRaceProgress = buildGetRaceProgress(deps);
  const result = await getRaceProgress("user-1", "race-1", TZ_ET);

  // Start day: 500 + 700 = 1200
  // Subsequent: samples = 1000 + 800 = 1800
  assert.equal(stepsFor(result, "user-1"), 3000);
});

test("multi-day race accumulates samples across all subsequent days", async () => {
  const multiDaySamples = [
    // Start day (Mar 30)
    { userId: "user-1", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
    // Day 2 (Mar 31)
    { userId: "user-1", periodStart: "2026-03-31T12:00:00.000Z", periodEnd: "2026-03-31T13:00:00.000Z", steps: 1000 },
    // Day 3 (Apr 1)
    { userId: "user-1", periodStart: "2026-04-01T14:00:00.000Z", periodEnd: "2026-04-01T15:00:00.000Z", steps: 2000 },
  ];
  const { deps } = makeDeps({
    samples: multiDaySamples,
    now: () => new Date("2026-04-01T16:00:00.000Z"), // Apr 1 noon ET
  });
  const getRaceProgress = buildGetRaceProgress(deps);
  const result = await getRaceProgress("user-1", "race-1", TZ_ET);

  // Start day: 500
  // Subsequent (Mar 31 + Apr 1): 1000 + 2000 = 3000
  assert.equal(stepsFor(result, "user-1"), 3500);
});
