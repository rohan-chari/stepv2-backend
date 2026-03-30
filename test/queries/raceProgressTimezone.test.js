const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
// You (user-est) are in America/New_York (EDT, UTC-4).
// Friend (user-la) is in America/Los_Angeles (PDT, UTC-7).
// You start a race at 9:00 AM ET on March 30, 2026.
//
// That single instant in UTC:      2026-03-30T13:00:00.000Z
//   In New York (EDT, UTC-4):      9:00 AM  March 30
//   In Los Angeles (PDT, UTC-7):   6:00 AM  March 30
//
// Business rules:
//   - Steps only count AFTER the race starts
//   - For the ET user: steps count after 9:00 AM ET
//   - For the LA user: steps count after 6:00 AM PT
//   - The ET user's steps must NOT count at 6:00 AM ET
//     (that's 10:00 AM UTC — 3 hours before the 1:00 PM UTC race start)
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z"); // 9 AM ET / 6 AM PT
const TZ_ET = "America/New_York";
const TZ_LA = "America/Los_Angeles";

// ---------------------------------------------------------------------------
// Step samples — UTC timestamps as stored in step_samples table
// ---------------------------------------------------------------------------
const ALL_SAMPLES = [
  // ── ET user: pre-race ──
  //  5–6 AM ET  =  09:00–10:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T09:00:00.000Z", periodEnd: "2026-03-30T10:00:00.000Z", steps: 200 },
  //  6–7 AM ET  =  10:00–11:00 UTC  ← the "6 AM ET" edge case
  { userId: "user-est", periodStart: "2026-03-30T10:00:00.000Z", periodEnd: "2026-03-30T11:00:00.000Z", steps: 600 },
  //  7–8 AM ET  =  11:00–12:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 400 },
  //  8–9 AM ET  =  12:00–13:00 UTC  (periodEnd === race start exactly)
  { userId: "user-est", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 300 },
  // ── ET user: post-race ──
  //  9–10 AM ET = 13:00–14:00 UTC   ← first post-start hour
  { userId: "user-est", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
  // 10–11 AM ET = 14:00–15:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T14:00:00.000Z", periodEnd: "2026-03-30T15:00:00.000Z", steps: 700 },

  // ── LA user: pre-race ──
  //  3–4 AM PT  =  10:00–11:00 UTC
  { userId: "user-la", periodStart: "2026-03-30T10:00:00.000Z", periodEnd: "2026-03-30T11:00:00.000Z", steps: 100 },
  //  4–5 AM PT  =  11:00–12:00 UTC
  { userId: "user-la", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 150 },
  //  5–6 AM PT  =  12:00–13:00 UTC  (periodEnd === race start exactly)
  { userId: "user-la", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 200 },
  // ── LA user: post-race ──
  //  6–7 AM PT  =  13:00–14:00 UTC  ← first post-start hour
  { userId: "user-la", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 800 },
  //  7–8 AM PT  =  14:00–15:00 UTC
  { userId: "user-la", periodStart: "2026-03-30T14:00:00.000Z", periodEnd: "2026-03-30T15:00:00.000Z", steps: 600 },
];

// ---------------------------------------------------------------------------
// Mocks — mirror real model query semantics
// ---------------------------------------------------------------------------

/**
 * Mirrors StepSample.sumStepsInWindow SQL:
 *   period_end > windowStart AND period_start < windowEnd
 */
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

function makeParticipant(id, userId, displayName, baselineSteps) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
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
      makeParticipant("rp-est", "user-est", "EST User", 1500),
      makeParticipant("rp-la", "user-la", "LA User", 450),
    ],
  };

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(samples || ALL_SAMPLES),
      Steps: createStepsStore(dailyRecords || {}, rangeRecords || {}),
      RaceParticipant: {
        async updateTotalSteps(id, totalSteps) { updates.push({ id, totalSteps }); },
        async markFinished() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType() { return []; },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
      },
      RacePowerup: { async findHeldByParticipant() { return []; } },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: nowFn || (() => new Date("2026-03-30T19:00:00.000Z")), // 3 PM ET
    },
  };
}

function stepsFor(result, userId) {
  return result.participants.find((p) => p.userId === userId).totalSteps;
}

// ===========================================================================
// Steps only count after 9:00 AM ET for me, after 6:00 AM PT for them
// ===========================================================================

test("ET user: only steps taken after 9:00 AM ET count toward the race", async () => {
  const { deps } = makeDeps();
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // Post-race: 9–10 AM ET (500) + 10–11 AM ET (700) = 1200
  // Pre-race 5–9 AM ET (200+600+400+300 = 1500) must be excluded
  assert.equal(stepsFor(result, "user-est"), 1200);
});

test("LA user: only steps taken after 6:00 AM PT count toward the race", async () => {
  const { deps } = makeDeps();
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-la", "race-1", TZ_LA);

  // Post-race: 6–7 AM PT (800) + 7–8 AM PT (600) = 1400
  // Pre-race 3–6 AM PT (100+150+200 = 450) must be excluded
  assert.equal(stepsFor(result, "user-la"), 1400);
});

// ===========================================================================
// My (ET user) steps must NOT start counting at 6:00 AM ET
// ===========================================================================

test("ET user: steps at 6:00 AM ET do NOT count — 6 AM ET is not 6 AM PT", async () => {
  // Only the 6–7 AM ET sample exists (= 10–11 AM UTC, 3 hours before race)
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T10:00:00.000Z", periodEnd: "2026-03-30T11:00:00.000Z", steps: 600 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 0);
});

test("ET user: steps from 6:00–9:00 AM ET are all excluded", async () => {
  // Pre-race hours only: 6–7, 7–8, 8–9 AM ET (total 1300 steps)
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T10:00:00.000Z", periodEnd: "2026-03-30T11:00:00.000Z", steps: 600 },
      { userId: "user-est", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 400 },
      { userId: "user-est", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 300 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // None of the 1300 pre-race steps should count
  assert.equal(stepsFor(result, "user-est"), 0);
});

test("ET user: each pre-race hour (6, 7, 8 AM ET) individually produces 0 race steps", async () => {
  const preRaceHours = [
    { label: "6–7 AM ET", start: "2026-03-30T10:00:00.000Z", end: "2026-03-30T11:00:00.000Z", steps: 600 },
    { label: "7–8 AM ET", start: "2026-03-30T11:00:00.000Z", end: "2026-03-30T12:00:00.000Z", steps: 400 },
    { label: "8–9 AM ET", start: "2026-03-30T12:00:00.000Z", end: "2026-03-30T13:00:00.000Z", steps: 300 },
  ];

  for (const hour of preRaceHours) {
    const { deps } = makeDeps({
      samples: [{ userId: "user-est", periodStart: hour.start, periodEnd: hour.end, steps: hour.steps }],
      participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
    });
    const getRaceProgress = buildGetRaceProgress(deps);

    const result = await getRaceProgress("user-est", "race-1", TZ_ET);

    assert.equal(stepsFor(result, "user-est"), 0, `${hour.label}: ${hour.steps} steps should NOT count`);
  }
});

test("LA user: each pre-race hour (3, 4, 5 AM PT) individually produces 0 race steps", async () => {
  const preRaceHours = [
    { label: "3–4 AM PT", start: "2026-03-30T10:00:00.000Z", end: "2026-03-30T11:00:00.000Z", steps: 100 },
    { label: "4–5 AM PT", start: "2026-03-30T11:00:00.000Z", end: "2026-03-30T12:00:00.000Z", steps: 150 },
    { label: "5–6 AM PT", start: "2026-03-30T12:00:00.000Z", end: "2026-03-30T13:00:00.000Z", steps: 200 },
  ];

  for (const hour of preRaceHours) {
    const { deps } = makeDeps({
      samples: [{ userId: "user-la", periodStart: hour.start, periodEnd: hour.end, steps: hour.steps }],
      participants: [makeParticipant("rp-la", "user-la", "LA User", 0)],
    });
    const getRaceProgress = buildGetRaceProgress(deps);

    const result = await getRaceProgress("user-la", "race-1", TZ_LA);

    assert.equal(stepsFor(result, "user-la"), 0, `${hour.label}: ${hour.steps} steps should NOT count`);
  }
});

// ===========================================================================
// Boundary precision at race start instant
// ===========================================================================

test("boundary: sample ending exactly at race start time is excluded", async () => {
  // 8–9 AM ET: periodEnd = 13:00:00.000Z === race start
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 300 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 0);
});

test("boundary: sample starting exactly at race start time is included", async () => {
  // 9–10 AM ET: periodStart = 13:00:00.000Z === race start
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 1500)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 500);
});

test("boundary: sample ending 1ms before race start is excluded", async () => {
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T12:50:00.000Z", periodEnd: "2026-03-30T12:59:59.999Z", steps: 100 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 0);
});

test("boundary: sample starting 1ms after race start is included", async () => {
  const { deps } = makeDeps({
    samples: [
      { userId: "user-est", periodStart: "2026-03-30T13:00:00.001Z", periodEnd: "2026-03-30T13:15:00.000Z", steps: 75 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 1500)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 75);
});

// ===========================================================================
// Baseline fallback (when step samples are unavailable)
// ===========================================================================

test("baseline fallback: ET user without samples uses daily total minus baseline", async () => {
  const { deps } = makeDeps({
    samples: [], // no samples
    dailyRecords: { "user-est:2026-03-30": { steps: 3500 } },
    participants: [makeParticipant("rp-est", "user-est", "EST User", 1500)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // 3500 today - 1500 at race start = 2000 post-race
  assert.equal(stepsFor(result, "user-est"), 2000);
});

test("baseline fallback: LA user without samples uses daily total minus baseline", async () => {
  const { deps } = makeDeps({
    samples: [],
    dailyRecords: { "user-la:2026-03-30": { steps: 2000 } },
    participants: [makeParticipant("rp-la", "user-la", "LA User", 450)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-la", "race-1", TZ_LA);

  // 2000 - 450 = 1550
  assert.equal(stepsFor(result, "user-la"), 1550);
});

test("no samples and no baseline: start day steps are 0 to avoid over-counting", async () => {
  const { deps } = makeDeps({
    samples: [],
    dailyRecords: { "user-est:2026-03-30": { steps: 5000 } },
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // baseline=0 and no samples → should NOT blindly count all 5000
  assert.equal(stepsFor(result, "user-est"), 0);
});

test("baseline fallback: daily total less than baseline floors to 0", async () => {
  const { deps } = makeDeps({
    samples: [],
    dailyRecords: { "user-est:2026-03-30": { steps: 1000 } },
    participants: [makeParticipant("rp-est", "user-est", "EST User", 1500)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // Math.max(0, 1000 - 1500) = 0, not -500
  assert.equal(stepsFor(result, "user-est"), 0);
});

// ===========================================================================
// Subsequent full days
// ===========================================================================

test("subsequent full days after start day count entirely for both users", async () => {
  const { deps } = makeDeps({
    rangeRecords: {
      "user-est": [
        { date: "2026-03-31", steps: 10000 },
        { date: "2026-04-01", steps: 8000 },
      ],
      "user-la": [
        { date: "2026-03-31", steps: 12000 },
        { date: "2026-04-01", steps: 9000 },
      ],
    },
    // Check on April 1 so subsequent days are in range
    now: () => new Date("2026-04-01T20:00:00.000Z"),
  });

  const getRaceProgress = buildGetRaceProgress(deps);

  const estResult = await getRaceProgress("user-est", "race-1", TZ_ET);
  // Start day samples: 500+700=1200, subsequent: 10000+8000=18000
  assert.equal(stepsFor(estResult, "user-est"), 19200);

  const laResult = await getRaceProgress("user-la", "race-1", TZ_LA);
  // Start day samples: 800+600=1400, subsequent: 12000+9000=21000
  assert.equal(stepsFor(laResult, "user-la"), 22400);
});

test("no subsequent days counted when progress is checked on the start day", async () => {
  const { deps } = makeDeps({
    rangeRecords: {
      // These exist but shouldn't be reached
      "user-est": [{ date: "2026-03-31", steps: 99999 }],
    },
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // Only start-day samples: 500+700=1200 (not 1200+99999)
  assert.equal(stepsFor(result, "user-est"), 1200);
});

// ===========================================================================
// Cross-timezone consistency
// ===========================================================================

test("both participants see identical step totals regardless of requester timezone", async () => {
  const { deps } = makeDeps();

  // ET user checks from ET timezone
  const fromET = buildGetRaceProgress(deps);
  const resultET = await fromET("user-est", "race-1", TZ_ET);

  // LA user checks from LA timezone
  const fromLA = buildGetRaceProgress(deps);
  const resultLA = await fromLA("user-la", "race-1", TZ_LA);

  // Both should report the same totals for both participants
  assert.equal(stepsFor(resultET, "user-est"), stepsFor(resultLA, "user-est"),
    "ET user total should not depend on requester timezone");
  assert.equal(stepsFor(resultET, "user-la"), stepsFor(resultLA, "user-la"),
    "LA user total should not depend on requester timezone");

  assert.equal(stepsFor(resultET, "user-est"), 1200);
  assert.equal(stepsFor(resultET, "user-la"), 1400);
});
