const assert = require("node:assert/strict");
const test = require("node:test");

const { calculateBaseAdjusted } = require("../../src/services/raceStateResolution");

const TZ = "America/New_York";

// Daily race anchored to ET midnight: [06-25 00:00 ET, 06-26 00:00 ET] =
// [2026-06-25T04:00Z, 2026-06-26T04:00Z] (EDT, UTC-4).
const RACE_STARTED_AT = new Date("2026-06-25T04:00:00Z");

function stepSampleMock(windowStartToSteps = {}) {
  return {
    async sumStepsInWindow(_userId, start) {
      return windowStartToSteps[new Date(start).toISOString()] ?? 0;
    },
  };
}

function stepsMock({ byDate = {}, range = [] } = {}) {
  return {
    async findByUserIdAndDate(_userId, date) {
      return byDate[date] != null ? { steps: byDate[date] } : null;
    },
    async findByUserIdAndDateRange() {
      return range;
    },
  };
}

test("pre-registrant (starts at local midnight) uses the daily total when samples haven't synced", async () => {
  const result = await calculateBaseAdjusted({
    participant: { userId: "u", joinedAt: new Date("2026-06-24T20:00:00Z") }, // opted in early
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({ byDate: { "2026-06-25": 5000 } }),
    stepSampleModel: stepSampleMock({ "2026-06-25T04:00:00.000Z": 0 }), // no hourly samples
    now: new Date("2026-06-25T18:00:00Z"),
  });

  assert.equal(result.baseAdjusted, 5000); // daily fallback, NOT 0
  assert.equal(result.hasSampleData, false);
});

test("pre-registrant takes max(samples, daily) on the start day", async () => {
  const result = await calculateBaseAdjusted({
    participant: { userId: "u", joinedAt: RACE_STARTED_AT },
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({ byDate: { "2026-06-25": 5000 } }),
    stepSampleModel: stepSampleMock({ "2026-06-25T04:00:00.000Z": 6200 }), // samples larger
    now: new Date("2026-06-25T18:00:00Z"),
  });

  assert.equal(result.baseAdjusted, 6200);
  assert.equal(result.hasSampleData, true);
});

test("mid-day late joiner stays sample-only (daily total must NOT leak pre-join steps)", async () => {
  const result = await calculateBaseAdjusted({
    participant: { userId: "u", joinedAt: new Date("2026-06-25T15:00:00Z") }, // joined mid-day
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({ byDate: { "2026-06-25": 5000 } }), // full-day total, must be ignored
    stepSampleModel: stepSampleMock({ "2026-06-25T15:00:00.000Z": 1200 }),
    now: new Date("2026-06-25T18:00:00Z"),
  });

  assert.equal(result.baseAdjusted, 1200); // only post-join samples
});

test("settlement at the exact ET midnight boundary does NOT add the next day's steps", async () => {
  const result = await calculateBaseAdjusted({
    participant: { userId: "u", joinedAt: RACE_STARTED_AT },
    raceStartedAt: RACE_STARTED_AT,
    timeZone: TZ,
    stepsModel: stepsMock({
      byDate: { "2026-06-25": 8000, "2026-06-26": 9999 }, // 06-26 is AFTER the race
      range: [{ date: "2026-06-26", steps: 9999 }],
    }),
    stepSampleModel: stepSampleMock({ "2026-06-25T04:00:00.000Z": 8000 }),
    now: new Date("2026-06-26T04:00:00Z"), // settlementTime = race endsAt (exact boundary)
  });

  assert.equal(result.baseAdjusted, 8000); // NOT 8000 + 9999
});
