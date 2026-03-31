const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ===========================================================================
// SCENARIO A — Same calendar date, half-hour offset
// ===========================================================================
// You (user-est) are in America/New_York (EDT, UTC-4).
// Friend (user-india) is in Asia/Kolkata (IST, UTC+5:30).
// You start a race at 9:00 AM ET on March 30, 2026.
//
//   UTC:   2026-03-30  13:00
//   ET:    2026-03-30  09:00 AM
//   IST:   2026-03-30  06:30 PM
//
// Steps only count AFTER that instant.
// ===========================================================================

// ===========================================================================
// SCENARIO B — Date crossing (ET evening → India next morning)
// ===========================================================================
// You start a race at 7:30 PM ET on March 30, 2026.
//
//   UTC:   2026-03-30  23:30
//   ET:    2026-03-30  07:30 PM   (still March 30)
//   IST:   2026-03-31  05:00 AM   (already March 31!)
//
// Steps only count AFTER that instant. The calendar date is different
// between the two participants, but the cutoff is the same UTC moment.
// ===========================================================================

const RACE_START_A = new Date("2026-03-30T13:00:00.000Z"); // 9 AM ET / 6:30 PM IST
const RACE_START_B = new Date("2026-03-30T23:30:00.000Z"); // 7:30 PM ET / 5:00 AM IST (Mar 31)

const TZ_ET = "America/New_York";
const TZ_INDIA = "Asia/Kolkata";

// ---------------------------------------------------------------------------
// Scenario A step samples (all UTC)
// ---------------------------------------------------------------------------
const SAMPLES_A = [
  // ── ET user: pre-race ──
  //  7–8 AM ET  =  11:00–12:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 400 },
  //  8–9 AM ET  =  12:00–13:00 UTC  (ends at race start)
  { userId: "user-est", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 300 },
  // ── ET user: post-race ──
  //  9–10 AM ET = 13:00–14:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
  // 10–11 AM ET = 14:00–15:00 UTC
  { userId: "user-est", periodStart: "2026-03-30T14:00:00.000Z", periodEnd: "2026-03-30T15:00:00.000Z", steps: 700 },

  // ── India user: pre-race (IST = UTC+5:30) ──
  //  4:30–5:30 PM IST = 11:00–12:00 UTC
  { userId: "user-india", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 120 },
  //  5:30–6:30 PM IST = 12:00–13:00 UTC  (ends exactly at race start)
  { userId: "user-india", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 250 },
  // ── India user: post-race ──
  //  6:30–7:30 PM IST = 13:00–14:00 UTC  (starts at race start)
  { userId: "user-india", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 900 },
  //  7:30–8:30 PM IST = 14:00–15:00 UTC
  { userId: "user-india", periodStart: "2026-03-30T14:00:00.000Z", periodEnd: "2026-03-30T15:00:00.000Z", steps: 650 },
];

// ---------------------------------------------------------------------------
// Scenario B step samples (all UTC) — race starts at 23:30 UTC
// ---------------------------------------------------------------------------
const SAMPLES_B = [
  // ── ET user: pre-race ──
  //  5:30–6:30 PM ET = 21:30–22:30 UTC
  { userId: "user-est", periodStart: "2026-03-30T21:30:00.000Z", periodEnd: "2026-03-30T22:30:00.000Z", steps: 400 },
  //  6:30–7:30 PM ET = 22:30–23:30 UTC  (ends at race start)
  { userId: "user-est", periodStart: "2026-03-30T22:30:00.000Z", periodEnd: "2026-03-30T23:30:00.000Z", steps: 350 },
  // ── ET user: post-race ──
  //  7:30–8:30 PM ET = 23:30–00:30 UTC  (crosses UTC midnight)
  { userId: "user-est", periodStart: "2026-03-30T23:30:00.000Z", periodEnd: "2026-03-31T00:30:00.000Z", steps: 600 },
  //  8:30–9:30 PM ET = 00:30–01:30 UTC  (after UTC midnight, still March 30 ET)
  { userId: "user-est", periodStart: "2026-03-31T00:30:00.000Z", periodEnd: "2026-03-31T01:30:00.000Z", steps: 800 },

  // ── India user: pre-race ──
  //  3:00–4:00 AM IST Mar 31 = 21:30–22:30 UTC Mar 30
  { userId: "user-india", periodStart: "2026-03-30T21:30:00.000Z", periodEnd: "2026-03-30T22:30:00.000Z", steps: 200 },
  //  4:00–5:00 AM IST Mar 31 = 22:30–23:30 UTC Mar 30  (ends at race start)
  { userId: "user-india", periodStart: "2026-03-30T22:30:00.000Z", periodEnd: "2026-03-30T23:30:00.000Z", steps: 300 },
  // ── India user: post-race ──
  //  5:00–6:00 AM IST Mar 31 = 23:30–00:30 UTC  (crosses UTC midnight)
  { userId: "user-india", periodStart: "2026-03-30T23:30:00.000Z", periodEnd: "2026-03-31T00:30:00.000Z", steps: 500 },
  //  6:00–7:00 AM IST Mar 31 = 00:30–01:30 UTC  (after UTC midnight, still March 31 IST)
  { userId: "user-india", periodStart: "2026-03-31T00:30:00.000Z", periodEnd: "2026-03-31T01:30:00.000Z", steps: 700 },
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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

function makeParticipant(id, userId, displayName, baselineSteps, raceStart) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    joinedAt: raceStart,
    baselineSteps,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    user: { displayName },
  };
}

function makeDeps({ raceStart, samples, participants, dailyRecords, rangeRecords, now: nowFn } = {}) {
  const start = raceStart || RACE_START_A;
  const updates = [];

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: start,
    endsAt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
    powerupsEnabled: false,
    powerupStepInterval: 0,
    participants: participants || [
      makeParticipant("rp-est", "user-est", "EST User", 1500, start),
      makeParticipant("rp-india", "user-india", "India User", 450, start),
    ],
  };

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(samples || SAMPLES_A),
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
      RacePowerup: { async findHeldByParticipant() { return []; }, async countMysteryBoxesByParticipant() { return 0; }, async findMysteryBoxesByParticipant() { return []; } },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: nowFn || (() => new Date("2026-03-30T16:00:00.000Z")),
    },
  };
}

function stepsFor(result, userId) {
  return result.participants.find((p) => p.userId === userId).totalSteps;
}

// ===========================================================================
// SCENARIO A — Same day, half-hour offset (9 AM ET = 6:30 PM IST)
// ===========================================================================

test("A: India user — only steps after 6:30 PM IST count (900 + 650 = 1550)", async () => {
  const { deps } = makeDeps();
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 1550);
});

test("A: ET user — only steps after 9:00 AM ET count (500 + 700 = 1200)", async () => {
  const { deps } = makeDeps();
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 1200);
});

test("A: India user — pre-6:30 PM IST steps are excluded", async () => {
  // Only pre-race samples for India user
  const { deps } = makeDeps({
    samples: [
      { userId: "user-india", periodStart: "2026-03-30T11:00:00.000Z", periodEnd: "2026-03-30T12:00:00.000Z", steps: 120 },
      { userId: "user-india", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 250 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 0, RACE_START_A)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 0);
});

test("A: India user — sample ending at 6:30 PM IST (= race start) is excluded", async () => {
  // 5:30–6:30 PM IST = 12:00–13:00 UTC, periodEnd exactly at race start
  const { deps } = makeDeps({
    samples: [
      { userId: "user-india", periodStart: "2026-03-30T12:00:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 250 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 0, RACE_START_A)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 0);
});

test("A: India user — sample starting at 6:30 PM IST (= race start) is included", async () => {
  const { deps } = makeDeps({
    samples: [
      { userId: "user-india", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 900 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 450, RACE_START_A)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 900);
});

test("A: half-hour boundary — sample from 6:00–6:30 PM IST (12:30–13:00 UTC) is excluded", async () => {
  // This 30-minute sample ends exactly at race start
  const { deps } = makeDeps({
    samples: [
      { userId: "user-india", periodStart: "2026-03-30T12:30:00.000Z", periodEnd: "2026-03-30T13:00:00.000Z", steps: 90 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 0, RACE_START_A)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 0);
});

test("A: half-hour boundary — sample from 6:30–7:00 PM IST (13:00–13:30 UTC) is included", async () => {
  const { deps } = makeDeps({
    samples: [
      { userId: "user-india", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T13:30:00.000Z", steps: 420 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 450, RACE_START_A)],
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 420);
});

test("A: cross-timezone — ET and India users see consistent totals", async () => {
  const { deps } = makeDeps();

  const fromET = buildGetRaceProgress(deps);
  const resultET = await fromET("user-est", "race-1", TZ_ET);

  const fromIndia = buildGetRaceProgress(deps);
  const resultIndia = await fromIndia("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(resultET, "user-est"), stepsFor(resultIndia, "user-est"),
    "ET user total should be the same regardless of requester timezone");
  assert.equal(stepsFor(resultET, "user-india"), stepsFor(resultIndia, "user-india"),
    "India user total should be the same regardless of requester timezone");

  assert.equal(stepsFor(resultET, "user-est"), 1200);
  assert.equal(stepsFor(resultET, "user-india"), 1550);
});

// ===========================================================================
// SCENARIO B — Date crossing (7:30 PM ET Mar 30 = 5:00 AM IST Mar 31)
//
// The race starts 30 minutes before UTC midnight. This is a stress test:
// the ET user is on March 30, the India user is already on March 31.
// ALL post-race steps must count regardless of which UTC day they fall on.
// ===========================================================================

test("B: India user — all steps after 5:00 AM IST Mar 31 count (500 + 700 = 1200)", async () => {
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: SAMPLES_B,
    participants: [
      makeParticipant("rp-india", "user-india", "India User", 500, RACE_START_B),
    ],
    // Check at 7:00 AM IST Mar 31 = 01:30 UTC Mar 31
    now: () => new Date("2026-03-31T01:30:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  // 5:00–6:00 AM IST (500) + 6:00–7:00 AM IST (700) — both after race start
  assert.equal(stepsFor(result, "user-india"), 1200);
});

test("B: ET user — all steps after 7:30 PM ET Mar 30 count (600 + 800 = 1400)", async () => {
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: SAMPLES_B,
    participants: [
      makeParticipant("rp-est", "user-est", "EST User", 1500, RACE_START_B),
    ],
    // Check at 9:30 PM ET Mar 30 = 01:30 UTC Mar 31
    now: () => new Date("2026-03-31T01:30:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  // 7:30–8:30 PM ET (600) + 8:30–9:30 PM ET (800) — both after race start
  assert.equal(stepsFor(result, "user-est"), 1400);
});

test("B: India user — pre-race steps (before 5:00 AM IST) are excluded", async () => {
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: [
      // 3:00–4:00 AM IST = 21:30–22:30 UTC
      { userId: "user-india", periodStart: "2026-03-30T21:30:00.000Z", periodEnd: "2026-03-30T22:30:00.000Z", steps: 200 },
      // 4:00–5:00 AM IST = 22:30–23:30 UTC (ends at race start)
      { userId: "user-india", periodStart: "2026-03-30T22:30:00.000Z", periodEnd: "2026-03-30T23:30:00.000Z", steps: 300 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 0, RACE_START_B)],
    now: () => new Date("2026-03-31T01:30:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 0);
});

test("B: ET user — pre-race steps (before 7:30 PM ET) are excluded", async () => {
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: [
      // 5:30–6:30 PM ET = 21:30–22:30 UTC
      { userId: "user-est", periodStart: "2026-03-30T21:30:00.000Z", periodEnd: "2026-03-30T22:30:00.000Z", steps: 400 },
      // 6:30–7:30 PM ET = 22:30–23:30 UTC (ends at race start)
      { userId: "user-est", periodStart: "2026-03-30T22:30:00.000Z", periodEnd: "2026-03-30T23:30:00.000Z", steps: 350 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 0, RACE_START_B)],
    now: () => new Date("2026-03-31T01:30:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 0);
});

test("B: India user — 6:00 AM IST step (1.5 hrs after start, past UTC midnight) still counts", async () => {
  // This is the critical edge case: the sample at 00:30–01:30 UTC is after
  // the race start (23:30 UTC) but past UTC midnight. It must still count.
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: [
      // Only the 6:00–7:00 AM IST sample = 00:30–01:30 UTC Mar 31
      { userId: "user-india", periodStart: "2026-03-31T00:30:00.000Z", periodEnd: "2026-03-31T01:30:00.000Z", steps: 700 },
    ],
    participants: [makeParticipant("rp-india", "user-india", "India User", 500, RACE_START_B)],
    now: () => new Date("2026-03-31T02:00:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-india", "race-1", TZ_INDIA);

  assert.equal(stepsFor(result, "user-india"), 700);
});

test("B: ET user — 8:30 PM ET step (1 hr after start, past UTC midnight) still counts", async () => {
  // Same edge case from ET perspective: 00:30–01:30 UTC is after the
  // 23:30 UTC race start but on the next UTC calendar day
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: [
      // Only the 8:30–9:30 PM ET sample = 00:30–01:30 UTC Mar 31
      { userId: "user-est", periodStart: "2026-03-31T00:30:00.000Z", periodEnd: "2026-03-31T01:30:00.000Z", steps: 800 },
    ],
    participants: [makeParticipant("rp-est", "user-est", "EST User", 1500, RACE_START_B)],
    now: () => new Date("2026-03-31T02:00:00.000Z"),
  });
  const getRaceProgress = buildGetRaceProgress(deps);

  const result = await getRaceProgress("user-est", "race-1", TZ_ET);

  assert.equal(stepsFor(result, "user-est"), 800);
});

test("B: cross-timezone — both users see correct totals despite different calendar dates", async () => {
  const { deps } = makeDeps({
    raceStart: RACE_START_B,
    samples: SAMPLES_B,
    now: () => new Date("2026-03-31T01:30:00.000Z"),
  });

  const fromET = buildGetRaceProgress(deps);
  const resultET = await fromET("user-est", "race-1", TZ_ET);

  const fromIndia = buildGetRaceProgress(deps);
  const resultIndia = await fromIndia("user-india", "race-1", TZ_INDIA);

  // Both perspectives should agree on totals
  assert.equal(stepsFor(resultET, "user-est"), stepsFor(resultIndia, "user-est"),
    "ET user total should match across timezone perspectives");
  assert.equal(stepsFor(resultET, "user-india"), stepsFor(resultIndia, "user-india"),
    "India user total should match across timezone perspectives");

  // ET user: 600 + 800 = 1400
  assert.equal(stepsFor(resultET, "user-est"), 1400);
  // India user: 500 + 700 = 1200
  assert.equal(stepsFor(resultET, "user-india"), 1200);
});
