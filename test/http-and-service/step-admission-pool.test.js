const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const { getDbPoolPressure } = require("../../src/db");
const {
  cleanDatabase, createTestUser, getSharedServer, prisma, request, startServer,
} = require("./setup");

let server;

async function waitForSleepingStepTransactions(expectedPerWorker) {
  const deadline = Date.now() + 3_000;
  let lastObserved = {};
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT application_name AS worker,count(*)::int AS count
         FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event='PgSleep'
          AND application_name LIKE 'step-admission-worker-%'
        GROUP BY application_name ORDER BY application_name`,
    );
    const observed = Object.fromEntries(rows.map((row) => [row.worker, Number(row.count)]));
    lastObserved = observed;
    if (Object.entries(expectedPerWorker).every(([worker, count]) => observed[worker] === count)) {
      return observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`step admission test did not observe the expected database work: ${JSON.stringify(lastObserved)}`);
}

describe("real step admission and database-pool reserve", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("caps both HTTP-worker equivalents at six, rejects before checkout, and preserves four connections for auth/Home", async () => {
    const accounts = await Promise.all(Array.from({ length: 14 }, () => createTestUser()));
    const secondWorker = await startServer();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_step_admission_delay() RETURNS trigger AS $$
      BEGIN
        PERFORM set_config(
          'application_name',
          CASE WHEN NEW.date < DATE '2026-08-15'
            THEN 'step-admission-worker-0'
            ELSE 'step-admission-worker-1'
          END,
          true
        );
        PERFORM pg_sleep(3);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_step_admission_delay_trigger
      BEFORE INSERT ON steps FOR EACH ROW EXECUTE FUNCTION test_step_admission_delay()
    `);
    let active = [];
    try {
      active = accounts.map((account, index) => request(
        index < 7 ? server.baseUrl : secondWorker.baseUrl,
        "POST", "/steps", {
          token: account.token,
          body: {
            steps: 100 + index,
            date: `2026-08-${String((index < 7 ? 8 : 20) + (index % 7)).padStart(2, "0")}`,
          },
        }
      ));
      assert.deepEqual(await waitForSleepingStepTransactions({
        "step-admission-worker-0": 6,
        "step-admission-worker-1": 6,
      }), {
        "step-admission-worker-0": 6,
        "step-admission-worker-1": 6,
      });

      const interactiveStartedAt = Date.now();
      const [auth, home] = await Promise.all([
        request(server.baseUrl, "GET", "/auth/me", { token: accounts[0].token }),
        request(secondWorker.baseUrl, "GET", "/home/race-card", { token: accounts[3].token }),
      ]);
      assert.equal(auth.status, 200);
      assert.equal(home.status, 200);
      assert.ok(Date.now() - interactiveStartedAt < 500, "auth and Home keep pool reserve while both workers are saturated");

      const queued = Array.from({ length: 128 }, () => request(server.baseUrl, "POST", "/steps", {
        body: { steps: 1, date: "2026-08-30" },
      }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      const beforeRejected = getDbPoolPressure();
      const rejected = await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 1, date: "2026-08-30" },
      });
      const afterRejected = getDbPoolPressure();
      assert.equal(rejected.status, 500, "pre-auth overflow preserves the frozen generic 500 contract");
      assert.deepEqual(await rejected.json(), { error: "Internal server error" });
      assert.equal(afterRejected.waitCount, beforeRejected.waitCount, "rejected request performs zero pool checkouts");
      assert.equal(afterRejected.connectionFailures, beforeRejected.connectionFailures);
      assert.ok(afterRejected.total <= afterRejected.max);
      assert.ok((await Promise.all(queued)).every((response) => response.status === 500));
      assert.deepEqual((await Promise.all(active)).map((response) => response.status),
        [200, 200, 200, 200, 200, 200, 500, 200, 200, 200, 200, 200, 200, 500],
        "each worker offers seven requests, executes six transactions, and times out one before checkout");
    } finally {
      await Promise.allSettled(active);
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS test_step_admission_delay_trigger ON steps");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_step_admission_delay()");
      await secondWorker.close();
    }
  });
});
