const assert = require("node:assert/strict");
const test = require("node:test");

const { buildComputeRankedWeeks } = require("../../src/jobs/computeRankedWeeks");

const SILENT = { log() {}, error() {} };

// Tuesday 2026-06-09 15:00 UTC — current week is Mon 06-08 .. Mon 06-15.
const TUESDAY = new Date("2026-06-09T15:00:00Z");

function makeCtx({ now = TUESDAY, currentWeek = null, unsettled = [] } = {}) {
  const created = [];
  const enrolled = [];
  const recomputed = [];
  const settledIds = [];
  let week = currentWeek;

  const job = buildComputeRankedWeeks({
    RankedWeek: {
      async getCurrent() {
        return week;
      },
      async getLatestIndex() {
        return 4;
      },
      async create(data) {
        week = { id: "week-new", ...data };
        created.push(week);
        return week;
      },
      async findUnsettled() {
        return unsettled;
      },
    },
    enrollWeek: async (args) => {
      enrolled.push(args);
      return { cohorts: 2, members: 41 };
    },
    recomputeWeekStandings: async ({ week: w }) => {
      recomputed.push(w.id);
      return { members: 41, placed: 0 };
    },
    settleRankedWeek: async ({ weekId }) => {
      settledIds.push(weekId);
      return { settledIndex: 4 };
    },
    settleGraceHours: 18,
    now: () => now,
    logger: SILENT,
  });

  return { job, created, enrolled, recomputed, settledIds };
}

test("opens the current week on first run, anchored to Monday, and enrolls from last week", async () => {
  const ctx = makeCtx();
  const result = await ctx.job();

  assert.equal(ctx.created.length, 1);
  const week = ctx.created[0];
  assert.equal(week.index, 5);
  assert.equal(week.startsOn.toISOString(), "2026-06-08T00:00:00.000Z"); // Monday
  assert.equal(week.endsOn.toISOString(), "2026-06-15T00:00:00.000Z");

  // Enrollment sources activity + step-matching from the prior 7 days.
  assert.equal(ctx.enrolled.length, 1);
  const { previousWindow } = ctx.enrolled[0];
  assert.equal(previousWindow.startsOn.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(previousWindow.endsOn.toISOString(), "2026-06-08T00:00:00.000Z");

  assert.equal(result.weekIndex, 5);
  assert.deepEqual(ctx.recomputed, ["week-new"]);
});

test("reuses the existing current week without re-enrolling", async () => {
  const ctx = makeCtx({
    currentWeek: {
      id: "week-5",
      index: 5,
      startsOn: new Date("2026-06-08T00:00:00Z"),
      endsOn: new Date("2026-06-15T00:00:00Z"),
    },
  });
  await ctx.job();
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.enrolled.length, 0);
  assert.deepEqual(ctx.recomputed, ["week-5"]);
});

test("during the grace window, refreshes the prior week but does NOT open the next one", async () => {
  // Monday 02:00 UTC — last week ended 2h ago, inside the 18h grace. The next
  // week must wait until that week settles so enrollment reads the new tiers.
  const monday = new Date("2026-06-15T02:00:00Z");
  const lastWeek = {
    id: "week-5",
    index: 5,
    startsOn: new Date("2026-06-08T00:00:00Z"),
    endsOn: new Date("2026-06-15T00:00:00Z"),
  };
  const ctx = makeCtx({ now: monday, unsettled: [lastWeek] });
  await ctx.job();

  assert.equal(ctx.settledIds.length, 0);
  // The next week is held back: nothing created or enrolled during grace.
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.enrolled.length, 0);
  // Only the grace-window week is refreshed.
  assert.deepEqual(ctx.recomputed, ["week-5"]);
});

test("settles the prior week, then opens the next one in the same tick", async () => {
  // Monday 19:00 UTC — 19h past the boundary, grace is 18h.
  const monday = new Date("2026-06-15T19:00:00Z");
  const lastWeek = {
    id: "week-5",
    index: 5,
    startsOn: new Date("2026-06-08T00:00:00Z"),
    endsOn: new Date("2026-06-15T00:00:00Z"),
  };
  const ctx = makeCtx({ now: monday, unsettled: [lastWeek] });
  await ctx.job();

  // Settlement applies the new tiers...
  assert.deepEqual(ctx.settledIds, ["week-5"]);
  // ...and only then is the next week opened + enrolled (same tick, no gap).
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].index, 5);
  assert.equal(ctx.enrolled.length, 1);
  assert.deepEqual(ctx.recomputed, ["week-new"]);
});

test("monday boundary: a run exactly at Monday midnight opens the new week", async () => {
  const mondayMidnight = new Date("2026-06-15T00:00:00Z");
  const ctx = makeCtx({ now: mondayMidnight });
  await ctx.job();
  assert.equal(ctx.created[0].startsOn.toISOString(), "2026-06-15T00:00:00.000Z");
});
