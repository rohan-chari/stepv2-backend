const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");
const {
  buildResolveRaceState,
} = require("../../src/modules/races/services/raceStateResolution");

// ===========================================================================
// BUG 1: Race step undercount.
//
// SPEC: A race must NEVER count fewer steps than the user's authoritative
// daily total for the covered period. For each local day AFTER the start day
// (dayAfterStartDate .. today, in the participant's time zone), the race counts
//   max(that day's step_sample sum, that day's daily `steps` row)
// and sums those per-day maxes. The START DAY stays samples-only so pre-race
// steps already in the daily total are NOT counted toward the race.
//
// Expectations below are derived from the SPEC, not from the source.
// ===========================================================================

const RACE_START = new Date("2026-06-01T13:00:00.000Z"); // 9 AM ET, Jun 1
const TZ_ET = "America/New_York";

// ---------------------------------------------------------------------------
// Step sample store: time-sliced sum (matches prod sumStepsInWindow semantics).
// ---------------------------------------------------------------------------
function createStepSampleStore(samples) {
  return {
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const ws = new Date(windowStart).getTime();
      const we = new Date(windowEnd).getTime();
      let total = 0;
      for (const s of samples) {
        if (s.userId !== userId) continue;
        const ss = new Date(s.periodStart).getTime();
        const se = new Date(s.periodEnd).getTime();
        const dur = se - ss;
        if (dur <= 0) continue;
        const os = Math.max(ss, ws);
        const oe = Math.min(se, we);
        const od = oe - os;
        if (od <= 0) continue;
        total += Math.round(s.steps * (od / dur));
      }
      return total;
    },
    async findByUserIdAndTimeRange(userId, start, end) {
      const ws = new Date(start).getTime();
      const we = new Date(end).getTime();
      return samples.filter(
        (s) =>
          s.userId === userId &&
          new Date(s.periodEnd).getTime() > ws &&
          new Date(s.periodStart).getTime() < we
      );
    },
  };
}

// Daily `steps` rows keyed by user; date is a YYYY-MM-DD local date string.
function createStepsStore(rangeRecords = {}) {
  return {
    async findByUserIdAndDate(userId, date) {
      return (rangeRecords[userId] || []).find((r) => r.date === date) || null;
    },
    async findByUserIdAndDateRange(userId, from, to) {
      return (rangeRecords[userId] || []).filter(
        (r) => r.date >= from && r.date <= to
      );
    },
  };
}

// ===========================================================================
// DISPLAY PATH (getRaceProgress)
// ===========================================================================

function makeDisplayDeps({ samples, rangeRecords, now: nowFn } = {}) {
  const updates = [];
  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 1000000,
    startedAt: RACE_START,
    endsAt: new Date("2026-06-08T13:00:00.000Z"),
    powerupsEnabled: false,
    powerupStepInterval: 0,
    participants: [
      {
        id: "rp-1",
        userId: "user-1",
        status: "ACCEPTED",
        joinedAt: RACE_START,
        baselineSteps: 0,
        finishedAt: null,
        bonusSteps: 0,
        nextBoxAtSteps: 0,
        powerupSlots: 3,
        user: { displayName: "TestUser" },
      },
    ],
  };

  return {
    updates,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(samples || []),
      Steps: createStepsStore(rangeRecords || {}),
      RaceParticipant: {
        async findById(id) { return { id, powerupSlots: 3 }; },
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
        async countOccupiedSlots() { return 0; },
        async findSlotPowerups() { return []; },
        async countQueuedByParticipant() { return 0; },
        async findQueuedByParticipant() { return []; },
        async update() {},
      },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: nowFn || (() => new Date("2026-06-02T15:00:00.000Z")),
    },
  };
}

function displayStepsFor(result, userId) {
  return result.participants.find((p) => p.userId === userId).totalSteps;
}

// ===========================================================================
// SETTLEMENT PATH (buildResolveRaceState -> calculateBaseAdjusted)
// ===========================================================================

function makeSettlementCtx({ samples, rangeRecords, now } = {}) {
  const participantUpdates = [];
  const participants = [
    {
      id: "rp-1",
      userId: "user-1",
      status: "ACCEPTED",
      totalSteps: 0,
      bonusSteps: 0,
      baselineSteps: 0,
      joinedAt: RACE_START,
      powerupSlots: 3,
      nextBoxAtSteps: 0,
      placement: null,
      finishedAt: null,
      finishTotalSteps: null,
      user: { id: "user-1", displayName: "TestUser" },
    },
  ];
  const race = {
    id: "race-1",
    name: "Test Race",
    status: "ACTIVE",
    targetSteps: 0, // time-based: never finishes, just tracks totals
    timeBased: true,
    startedAt: RACE_START,
    endsAt: new Date("2026-06-08T13:00:00.000Z"),
    powerupsEnabled: false,
    powerupStepInterval: null,
    participants,
  };

  const sampleStore = createStepSampleStore(samples || []);
  const stepsStore = createStepsStore(rangeRecords || {});

  const deps = {
    Race: {
      async findById() {
        return { ...race, participants: participants.map((p) => ({ ...p })) };
      },
    },
    RaceParticipant: {
      async updateTotalSteps(id, totalSteps) {
        participantUpdates.push({ id, totalSteps });
      },
      async markFinished() {},
      async setPlacement() {},
    },
    Steps: stepsStore,
    StepSample: sampleStore,
    RaceActiveEffect: {
      async findEffectsForRaceByType() { return []; },
    },
    RacePowerupEvent: {
      async findByRaceAsc() { return []; },
    },
    completeRace: async () => {},
    now: () => now || new Date("2026-06-02T15:00:00.000Z"),
  };

  return { participantUpdates, deps };
}

function settlementStepsFor(ctx, id) {
  const u = ctx.participantUpdates.find((x) => x.id === id);
  return u ? u.totalSteps : undefined;
}

// ===========================================================================
// Fixtures matching the prod incident.
// ===========================================================================

// Start day (Jun 1) post-race samples: 1200 total.
const START_DAY_SAMPLES = [
  { userId: "user-1", periodStart: "2026-06-01T13:00:00.000Z", periodEnd: "2026-06-01T14:00:00.000Z", steps: 500 },
  { userId: "user-1", periodStart: "2026-06-01T14:00:00.000Z", periodEnd: "2026-06-01T15:00:00.000Z", steps: 700 },
];

// ---------------------------------------------------------------------------
// (a) Subsequent FULL day: daily(10349) > samples(2953) -> day contributes 10349.
//     (Mirrors prod: Jun 2 daily total 10,349 but samples summed only 2,953.)
// ---------------------------------------------------------------------------

const CASE_A_SAMPLES = [
  ...START_DAY_SAMPLES,
  // Jun 2 partial samples summing to 2953 (incomplete HealthKit sync).
  { userId: "user-1", periodStart: "2026-06-02T12:00:00.000Z", periodEnd: "2026-06-02T13:00:00.000Z", steps: 1500 },
  { userId: "user-1", periodStart: "2026-06-02T13:00:00.000Z", periodEnd: "2026-06-02T14:00:00.000Z", steps: 1453 },
];
const CASE_A_RANGE = {
  "user-1": [{ date: "2026-06-02", steps: 10349 }],
};
// now is on Jun 3 so Jun 2 is a complete past day.
const CASE_A_NOW = () => new Date("2026-06-03T18:00:00.000Z");

test("display: subsequent full day uses the LARGER daily total over incomplete samples", async () => {
  const { deps } = makeDisplayDeps({
    samples: CASE_A_SAMPLES,
    rangeRecords: CASE_A_RANGE,
    now: CASE_A_NOW,
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ_ET);
  // Start day samples: 1200; Jun 2 max(2953, 10349) = 10349; Jun 3 has nothing.
  assert.equal(displayStepsFor(result, "user-1"), 1200 + 10349);
});

test("settlement: subsequent full day uses the LARGER daily total over incomplete samples", async () => {
  const ctx = makeSettlementCtx({
    samples: CASE_A_SAMPLES,
    rangeRecords: CASE_A_RANGE,
    now: CASE_A_NOW(),
  });
  await buildResolveRaceState(ctx.deps)({ raceId: "race-1", timeZone: TZ_ET });
  assert.equal(settlementStepsFor(ctx, "rp-1"), 1200 + 10349);
});

// ---------------------------------------------------------------------------
// (b) Subsequent partial/today day: samples(2433) > daily(78) -> contributes 2433.
//     (Mirrors prod: Jun 3 daily row stale at 78 while samples summed 2,433.)
// ---------------------------------------------------------------------------

const CASE_B_SAMPLES = [
  ...START_DAY_SAMPLES,
  // Jun 2 (today) samples summing to 2433; daily row is a stale 78.
  { userId: "user-1", periodStart: "2026-06-02T12:00:00.000Z", periodEnd: "2026-06-02T13:00:00.000Z", steps: 1200 },
  { userId: "user-1", periodStart: "2026-06-02T13:00:00.000Z", periodEnd: "2026-06-02T14:00:00.000Z", steps: 1233 },
];
const CASE_B_RANGE = {
  "user-1": [{ date: "2026-06-02", steps: 78 }],
};
const CASE_B_NOW = () => new Date("2026-06-02T15:00:00.000Z"); // today is Jun 2

test("display: subsequent (today) day uses the LARGER samples over a stale daily row", async () => {
  const { deps } = makeDisplayDeps({
    samples: CASE_B_SAMPLES,
    rangeRecords: CASE_B_RANGE,
    now: CASE_B_NOW,
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ_ET);
  // Start day samples 1200; Jun 2 max(2433, 78) = 2433.
  assert.equal(displayStepsFor(result, "user-1"), 1200 + 2433);
});

test("settlement: subsequent (today) day uses the LARGER samples over a stale daily row", async () => {
  const ctx = makeSettlementCtx({
    samples: CASE_B_SAMPLES,
    rangeRecords: CASE_B_RANGE,
    now: CASE_B_NOW(),
  });
  await buildResolveRaceState(ctx.deps)({ raceId: "race-1", timeZone: TZ_ET });
  assert.equal(settlementStepsFor(ctx, "rp-1"), 1200 + 2433);
});

// ---------------------------------------------------------------------------
// (c) Both in one multi-day race -> per-day max summed.
//     Jun 2: daily 10349 > samples 2953 -> 10349
//     Jun 3 (today): samples 2433 > daily 78 -> 2433
// ---------------------------------------------------------------------------

const CASE_C_SAMPLES = [
  ...START_DAY_SAMPLES,
  // Jun 2 incomplete samples (2953).
  { userId: "user-1", periodStart: "2026-06-02T12:00:00.000Z", periodEnd: "2026-06-02T13:00:00.000Z", steps: 1500 },
  { userId: "user-1", periodStart: "2026-06-02T13:00:00.000Z", periodEnd: "2026-06-02T14:00:00.000Z", steps: 1453 },
  // Jun 3 (today) samples (2433).
  { userId: "user-1", periodStart: "2026-06-03T12:00:00.000Z", periodEnd: "2026-06-03T13:00:00.000Z", steps: 1200 },
  { userId: "user-1", periodStart: "2026-06-03T13:00:00.000Z", periodEnd: "2026-06-03T14:00:00.000Z", steps: 1233 },
];
const CASE_C_RANGE = {
  "user-1": [
    { date: "2026-06-02", steps: 10349 },
    { date: "2026-06-03", steps: 78 },
  ],
};
const CASE_C_NOW = () => new Date("2026-06-03T15:00:00.000Z"); // today is Jun 3

test("display: multi-day race sums the PER-DAY max of samples vs daily", async () => {
  const { deps } = makeDisplayDeps({
    samples: CASE_C_SAMPLES,
    rangeRecords: CASE_C_RANGE,
    now: CASE_C_NOW,
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ_ET);
  // Start day 1200; Jun 2 max(2953,10349)=10349; Jun 3 max(2433,78)=2433.
  assert.equal(displayStepsFor(result, "user-1"), 1200 + 10349 + 2433);
});

test("settlement: multi-day race sums the PER-DAY max of samples vs daily", async () => {
  const ctx = makeSettlementCtx({
    samples: CASE_C_SAMPLES,
    rangeRecords: CASE_C_RANGE,
    now: CASE_C_NOW(),
  });
  await buildResolveRaceState(ctx.deps)({ raceId: "race-1", timeZone: TZ_ET });
  assert.equal(settlementStepsFor(ctx, "rp-1"), 1200 + 10349 + 2433);
});

// ---------------------------------------------------------------------------
// (d) Start day stays samples-only (pre-race steps excluded).
//     A large daily row for the START day must NOT inflate the race total.
// ---------------------------------------------------------------------------

const CASE_D_SAMPLES = [
  // Only post-race start-day samples (1200). No subsequent-day samples.
  ...START_DAY_SAMPLES,
];
const CASE_D_RANGE = {
  // Start-day daily row is huge (includes pre-race morning steps) — must be
  // ignored for the start day. No subsequent days exist yet (today == start day).
  "user-1": [{ date: "2026-06-01", steps: 9999 }],
};
const CASE_D_NOW = () => new Date("2026-06-01T16:00:00.000Z"); // still the start day

test("display: start day stays samples-only and excludes pre-race daily steps", async () => {
  const { deps } = makeDisplayDeps({
    samples: CASE_D_SAMPLES,
    rangeRecords: CASE_D_RANGE,
    now: CASE_D_NOW,
  });
  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ_ET);
  // Only the post-start samples count: 1200. The 9999 daily row is excluded.
  assert.equal(displayStepsFor(result, "user-1"), 1200);
});

test("settlement: start day stays samples-only and excludes pre-race daily steps", async () => {
  const ctx = makeSettlementCtx({
    samples: CASE_D_SAMPLES,
    rangeRecords: CASE_D_RANGE,
    now: CASE_D_NOW(),
  });
  await buildResolveRaceState(ctx.deps)({ raceId: "race-1", timeZone: TZ_ET });
  assert.equal(settlementStepsFor(ctx, "rp-1"), 1200);
});

// ---------------------------------------------------------------------------
// Parity guard: identical inputs -> identical totals across both paths.
// ---------------------------------------------------------------------------

test("display and settlement agree on the corrected per-day-max total", async () => {
  const { deps: displayDeps } = makeDisplayDeps({
    samples: CASE_C_SAMPLES,
    rangeRecords: CASE_C_RANGE,
    now: CASE_C_NOW,
  });
  const displayResult = await buildGetRaceProgress(displayDeps)(
    "user-1",
    "race-1",
    TZ_ET
  );

  const ctx = makeSettlementCtx({
    samples: CASE_C_SAMPLES,
    rangeRecords: CASE_C_RANGE,
    now: CASE_C_NOW(),
  });
  await buildResolveRaceState(ctx.deps)({ raceId: "race-1", timeZone: TZ_ET });

  assert.equal(
    displayStepsFor(displayResult, "user-1"),
    settlementStepsFor(ctx, "rp-1")
  );
});
