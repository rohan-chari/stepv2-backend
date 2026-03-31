const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Step Calendar — returns daily steps + goal-met status for a given month
//
// Schema context:
//   Step: { userId, steps, stepGoal, date }
//   User: { stepGoal (default 5000) }
//
// Expected response shape:
//   { days: [{ date: "YYYY-MM-DD", steps: number, stepGoal: number, goalMet: boolean }] }
//
// Rules:
//   - Returns all days of the requested month
//   - Days with step records show the actual steps and the stepGoal locked at recording time
//   - Days with no data show steps: 0, goalMet: false
//   - Future days are included but marked as future: true
//   - goalMet = steps >= stepGoal
//   - Changing step goal does NOT retroactively change previous days' goalMet
// ---------------------------------------------------------------------------

// We'll test a buildGetStepCalendar query function
// It won't exist yet — tests first, implementation after.

function makeDeps(overrides = {}) {
  return {
    deps: {
      Steps: {
        async findByUserIdAndDateRange(userId, startDate, endDate) {
          if (overrides.stepRecords) {
            return overrides.stepRecords.filter((r) => {
              const d = r.date.toISOString().slice(0, 10);
              return d >= startDate && d <= endDate;
            });
          }
          return [];
        },
      },
      User: {
        async findById(userId) {
          return {
            id: userId,
            stepGoal: overrides.userStepGoal ?? 5000,
          };
        },
      },
      now: overrides.now || (() => new Date("2026-03-15T12:00:00Z")),
    },
  };
}

function makeStepRecord(date, steps, stepGoal) {
  return {
    id: `step-${date}`,
    userId: "user-1",
    date: new Date(`${date}T00:00:00Z`),
    steps,
    stepGoal,
  };
}

// ===========================================================================
// Basic — returns all days of the month
// ===========================================================================

test("Calendar returns all days of March 2026", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps();
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  assert.equal(result.days.length, 31); // March has 31 days
  assert.equal(result.days[0].date, "2026-03-01");
  assert.equal(result.days[30].date, "2026-03-31");
});

test("Calendar returns all days of February 2026 (non-leap year)", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps();
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-02", "America/New_York");

  assert.equal(result.days.length, 28);
  assert.equal(result.days[0].date, "2026-02-01");
  assert.equal(result.days[27].date, "2026-02-28");
});

test("Calendar returns all days of April 2026 (30-day month)", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps();
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-04", "America/New_York");

  assert.equal(result.days.length, 30);
});

// ===========================================================================
// Step data for days with records
// ===========================================================================

test("Days with step records show correct steps and stepGoal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    stepRecords: [
      makeStepRecord("2026-03-01", 8000, 5000),
      makeStepRecord("2026-03-02", 3000, 5000),
      makeStepRecord("2026-03-10", 12000, 7000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  assert.equal(mar1.steps, 8000);
  assert.equal(mar1.stepGoal, 5000);

  const mar2 = result.days.find((d) => d.date === "2026-03-02");
  assert.equal(mar2.steps, 3000);
  assert.equal(mar2.stepGoal, 5000);

  const mar10 = result.days.find((d) => d.date === "2026-03-10");
  assert.equal(mar10.steps, 12000);
  assert.equal(mar10.stepGoal, 7000);
});

// ===========================================================================
// Goal met / not met
// ===========================================================================

test("goalMet is true when steps >= stepGoal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    stepRecords: [
      makeStepRecord("2026-03-05", 6000, 5000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const day = result.days.find((d) => d.date === "2026-03-05");
  assert.equal(day.goalMet, true);
});

test("goalMet is true when steps exactly equal stepGoal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    stepRecords: [
      makeStepRecord("2026-03-05", 5000, 5000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const day = result.days.find((d) => d.date === "2026-03-05");
  assert.equal(day.goalMet, true);
});

test("goalMet is false when steps < stepGoal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    stepRecords: [
      makeStepRecord("2026-03-05", 3000, 5000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const day = result.days.find((d) => d.date === "2026-03-05");
  assert.equal(day.goalMet, false);
});

// ===========================================================================
// Days with no data — show 0 steps, red (goalMet: false)
// ===========================================================================

test("Days with no step record show steps: 0 and goalMet: false", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({ stepRecords: [] });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  assert.equal(mar1.steps, 0);
  assert.equal(mar1.goalMet, false);
});

test("Days with no data use the user's current stepGoal for display", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({ stepRecords: [], userStepGoal: 8000 });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  assert.equal(mar1.stepGoal, 8000);
});

// ===========================================================================
// Historical step goal — not retroactively changed
// ===========================================================================

test("Days use their locked stepGoal, not the user's current goal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  // User's current goal is 10000, but day was recorded with goal 5000
  const ctx = makeDeps({
    userStepGoal: 10000,
    stepRecords: [
      makeStepRecord("2026-03-01", 7000, 5000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  // Should use the locked goal (5000), not the current goal (10000)
  assert.equal(mar1.stepGoal, 5000);
  assert.equal(mar1.goalMet, true); // 7000 >= 5000
});

test("Goal change mid-month does not affect earlier days", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  // User changed goal from 5000 to 10000 on March 10
  const ctx = makeDeps({
    userStepGoal: 10000,
    stepRecords: [
      makeStepRecord("2026-03-05", 7000, 5000),   // before change
      makeStepRecord("2026-03-15", 7000, 10000),  // after change
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar5 = result.days.find((d) => d.date === "2026-03-05");
  assert.equal(mar5.goalMet, true);  // 7000 >= 5000

  const mar15 = result.days.find((d) => d.date === "2026-03-15");
  assert.equal(mar15.goalMet, false); // 7000 < 10000
});

// ===========================================================================
// Future days — marked as future
// ===========================================================================

test("Future days are marked as future: true", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  // "now" is March 15, so March 16-31 are future
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar15 = result.days.find((d) => d.date === "2026-03-15");
  assert.equal(mar15.future, false);

  const mar16 = result.days.find((d) => d.date === "2026-03-16");
  assert.equal(mar16.future, true);

  const mar31 = result.days.find((d) => d.date === "2026-03-31");
  assert.equal(mar31.future, true);
});

test("Past days are not marked as future", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  assert.equal(mar1.future, false);

  const mar14 = result.days.find((d) => d.date === "2026-03-14");
  assert.equal(mar14.future, false);
});

test("Viewing a past month has no future days", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-02", "America/New_York");

  const futureDays = result.days.filter((d) => d.future);
  assert.equal(futureDays.length, 0);
});

test("Viewing a future month has all days marked as future", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-04", "America/New_York");

  const futureDays = result.days.filter((d) => d.future);
  assert.equal(futureDays.length, 30); // all of April
});

// ===========================================================================
// Today handling
// ===========================================================================

test("Today is not marked as future", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const today = result.days.find((d) => d.date === "2026-03-15");
  assert.equal(today.future, false);
  assert.equal(today.isToday, true);
});

test("Only one day is marked as isToday", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const todayDays = result.days.filter((d) => d.isToday);
  assert.equal(todayDays.length, 1);
  assert.equal(todayDays[0].date, "2026-03-15");
});

test("Viewing a different month has no isToday", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    now: () => new Date("2026-03-15T12:00:00Z"),
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-02", "America/New_York");

  const todayDays = result.days.filter((d) => d.isToday);
  assert.equal(todayDays.length, 0);
});

// ===========================================================================
// Navigating to previous/future months
// ===========================================================================

test("Can retrieve calendar for a past month", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    stepRecords: [
      makeStepRecord("2026-01-15", 9000, 5000),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-01", "America/New_York");

  assert.equal(result.days.length, 31); // January
  const jan15 = result.days.find((d) => d.date === "2026-01-15");
  assert.equal(jan15.steps, 9000);
  assert.equal(jan15.goalMet, true);
});

// ===========================================================================
// Edge: stepGoal is null on record (use user's current goal as fallback)
// ===========================================================================

test("If a step record has null stepGoal, falls back to user's current goal", async () => {
  const { buildGetStepCalendar } = require("../../src/queries/getStepCalendar");
  const ctx = makeDeps({
    userStepGoal: 6000,
    stepRecords: [
      makeStepRecord("2026-03-01", 7000, null),
    ],
  });
  const getCalendar = buildGetStepCalendar(ctx.deps);

  const result = await getCalendar("user-1", "2026-03", "America/New_York");

  const mar1 = result.days.find((d) => d.date === "2026-03-01");
  assert.equal(mar1.stepGoal, 6000);
  assert.equal(mar1.goalMet, true); // 7000 >= 6000
});
