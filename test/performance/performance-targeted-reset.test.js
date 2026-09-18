const assert = require("node:assert/strict");
const test = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { discoverResetPlan, targetedReset } = require("../../performance/lib/reset");

function assertDisposableTestDatabase() {
  const parsed = new URL(process.env.DATABASE_URL);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/(^|[_-])test$/.test(name) || !["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("performance reset integration requires a disposable local *_test database");
  }
}

test("audited targeted reset restores the same fixture across two levels", async (context) => {
  assertDisposableTestDatabase();
  await cleanDatabase();
  context.after(async () => { await cleanDatabase(); });
  const { user } = await createTestUser();
  const fixture = { runId: `perf-reset-${Date.now()}`, ids: {
    users: [user.id], races: [], raceParticipants: [],
  }, userBaselineLastSeenAt: "2026-09-01T00:00:00.000Z" };
  const selectors = [{ table: "user_activity_days", column: "user_id", scope: "user" }];
  const plan = await discoverResetPlan(prisma, selectors);
  assert.deepEqual(plan.tables.map((row) => row.table), ["user_activity_days"]);

  for (let level = 1; level <= 2; level += 1) {
    const start = new Date(`2026-09-0${level}T10:00:00.000Z`);
    await prisma.step.create({ data: { userId: user.id, date: start, steps: level * 100 } });
    await prisma.stepSample.create({ data: { userId: user.id, periodStart: start,
      periodEnd: new Date(start.getTime() + 60_000), steps: level * 100 } });
    await prisma.userActivityDay.create({ data: { userId: user.id, activityDate: start,
      firstSeenAt: start, lastSeenAt: start, appVersion: "2.3.11", metadataOccurredAt: start } });
    await prisma.user.update({ where: { id: user.id }, data: { lastStepSyncAt: start } });

    const reset = await targetedReset({ prisma, fixture, plan,
      verifyMarker: async () => ({ disposable: true, database: "integration_test" }) });
    assert.equal(reset.proof.remainingRunOwnedRows, 0);
    assert.equal(await prisma.step.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.stepSample.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userActivityDay.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).lastStepSyncAt, null);
  }
});
