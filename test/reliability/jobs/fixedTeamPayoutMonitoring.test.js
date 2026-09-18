const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildFixedTeamPayoutMonitor,
  evaluateFixedTeamPayoutAlert,
  loadFixedTeamPayoutMonitoringSnapshot,
} = require("../../src/modules/races/jobs/fixedTeamPayoutMonitoring");

test("daily issuance windows are explicit UTC boundaries independent of the database session", async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      return [];
    },
  };
  const now = new Date("2026-08-27T00:30:00.000Z");

  await loadFixedTeamPayoutMonitoringSnapshot({ prisma, now });

  assert.match(calls[0].sql, /AT TIME ZONE 'UTC'/);
  assert.match(
    calls[0].sql,
    /date_trunc\('day', ct\.created_at AT TIME ZONE 'UTC'\)/,
  );
  assert.deepEqual(calls[0].values, [now.toISOString()]);
});

test("pages immediately above 4,000 fixed-team coins in the current UTC day", async () => {
  const snapshot = {
    fixedTeamCoinsByDay: [
      { day: "2026-08-26", fixedTeamCoins: 4100 },
      { day: "2026-08-25", fixedTeamCoins: 100 },
    ],
    identitiesOver1000Coins7d: 2,
  };
  assert.equal(evaluateFixedTeamPayoutAlert(snapshot).severity, "page");
  const errors = [];
  const run = buildFixedTeamPayoutMonitor({
    loadSnapshot: async () => snapshot,
    logger: { error: (event) => errors.push(event), warn() {}, log() {} },
  });
  assert.equal(await run(), snapshot);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, "fixed_team_payout_economy_monitor_v1");
  assert.equal(errors[0].severity, "page");
  assert.equal(errors[0].identitiesOver1000Coins7d, 2);
});

test("warns only after two consecutive UTC days above 2,000", () => {
  assert.equal(evaluateFixedTeamPayoutAlert({
    fixedTeamCoinsByDay: [
      { day: "2026-08-26", fixedTeamCoins: 2200 },
      { day: "2026-08-25", fixedTeamCoins: 2100 },
    ],
  }).severity, "warn");
  assert.equal(evaluateFixedTeamPayoutAlert({
    fixedTeamCoinsByDay: [
      { day: "2026-08-26", fixedTeamCoins: 2200 },
      { day: "2026-08-25", fixedTeamCoins: 1900 },
    ],
  }).severity, "info");
});
