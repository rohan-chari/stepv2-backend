const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const express = require("express");

const { createStepsRouter } = require("../../src/modules/steps/routes/steps");
const { SeasonScore } = require("../../src/modules/ranked/models/season");
const { getMondayOfWeek } = require("../../src/shared/time/week");

// Mounts the steps router with injected dependencies so GET /steps/stats can be
// exercised without a database: auth is faked, step history is supplied, and the
// ranked lookup is stubbed (the handler already defaults it to null on failure).
async function withStatsServer(stepsHistory, run) {
  const originalGetActiveForUser = SeasonScore.getActiveForUser;
  SeasonScore.getActiveForUser = async () => null;

  const app = express();
  app.use(express.json());
  app.use(
    "/steps",
    createStepsRouter({
      requireAuth: (req, _res, next) => {
        req.user = { id: "user-1", stepGoal: 5000 };
        req.timeZone = "UTC";
        next();
      },
      getStepsHistory: async () => stepsHistory,
    })
  );

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/steps/stats`);
    const body = await res.json();
    await run({ status: res.status, body });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    SeasonScore.getActiveForUser = originalGetActiveForUser;
  }
}

// "now" inside the handler comes from new Date(); it buckets steps with
// lower-bound checks only (date >= this-week's-Monday / month-start / year-start,
// no upper bound — see src/modules/steps/routes/steps.js:134-144). So we anchor fixture dates
// at the LATER of this week's Monday and the first of the current month (itself
// always >= Jan 1). Every fixture day is then guaranteed inside this week, month,
// and year on ANY day of the week — including Mondays, when getMondayOfWeek makes
// the week start *today* and naive today/yesterday/day-before fixtures spill into
// the previous week. (Mirrors the leaderboard week de-flake.)
function recentDates() {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const monday = new Date(`${getMondayOfWeek(now, "UTC")}T00:00:00.000Z`);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  );
  const anchor = monday > monthStart ? monday : monthStart;
  // Day `n` of the current week's safe window (n=0 is the anchor). Distinct,
  // consecutive days that always satisfy all three "this period" lower bounds.
  const dayOfWeek = (n) => {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  };
  return { today: dayOfWeek(0), dayOfWeek };
}

test("GET /steps/stats returns per-day averages = total / days-with-data", async () => {
  const { dayOfWeek } = recentDates();

  // Three days this week with recorded data: 1000 + 2000 + 3000 = 6000 steps.
  // Anchored to the current week's safe window so all three land inside this
  // week/month/year on any day (including Mondays).
  const history = [
    { date: `${dayOfWeek(0)}T12:00:00.000Z`, steps: 3000 },
    { date: `${dayOfWeek(1)}T12:00:00.000Z`, steps: 2000 },
    { date: `${dayOfWeek(2)}T12:00:00.000Z`, steps: 1000 },
  ];

  await withStatsServer(history, ({ status, body }) => {
    assert.equal(status, 200);

    // Existing total fields preserved.
    assert.equal(body.thisWeek, 6000);
    assert.equal(body.thisMonth, 6000);
    assert.equal(body.thisYear, 6000);
    assert.equal(body.allTime, 6000);

    // Averages = total / distinct days with data (3 days here).
    assert.equal(body.avgPerDayWeek, 2000);
    assert.equal(body.avgPerDayMonth, 2000);
    assert.equal(body.avgPerDayYear, 2000);
  });
});

test("GET /steps/stats rounds per-day averages", async () => {
  const { dayOfWeek } = recentDates();

  // 1000 + 1001 = 2001 over 2 days -> 1000.5 -> Math.round -> 1001.
  const history = [
    { date: `${dayOfWeek(0)}T12:00:00.000Z`, steps: 1001 },
    { date: `${dayOfWeek(1)}T12:00:00.000Z`, steps: 1000 },
  ];

  await withStatsServer(history, ({ body }) => {
    assert.equal(body.thisWeek, 2001);
    assert.equal(body.avgPerDayWeek, 1001);
  });
});

test("GET /steps/stats guards divide-by-zero -> 0 when no data", async () => {
  await withStatsServer([], ({ status, body }) => {
    assert.equal(status, 200);

    // Totals are zero...
    assert.equal(body.thisWeek, 0);
    assert.equal(body.thisMonth, 0);
    assert.equal(body.thisYear, 0);
    assert.equal(body.allTime, 0);

    // ...and averages are 0 (never NaN/Infinity).
    assert.equal(body.avgPerDayWeek, 0);
    assert.equal(body.avgPerDayMonth, 0);
    assert.equal(body.avgPerDayYear, 0);
    assert.ok(Number.isFinite(body.avgPerDayWeek));
    assert.ok(Number.isFinite(body.avgPerDayMonth));
    assert.ok(Number.isFinite(body.avgPerDayYear));
  });
});

test("GET /steps/stats preserves all existing total/profile fields", async () => {
  const { today } = recentDates();
  const history = [{ date: `${today}T12:00:00.000Z`, steps: 1234 }];

  await withStatsServer(history, ({ body }) => {
    // Additive change must not drop pre-existing fields older apps depend on.
    for (const field of [
      "thisWeek",
      "thisMonth",
      "thisYear",
      "allTime",
      "streak",
      "rankedTier",
      "rankedDivision",
      "stepGoal",
    ]) {
      assert.ok(field in body, `expected field "${field}" in stats response`);
    }
    assert.equal(body.stepGoal, 5000);
  });
});
