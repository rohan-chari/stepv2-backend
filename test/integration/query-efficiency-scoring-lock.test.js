const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { setTimeout: delay } = require("node:timers/promises");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const {
  prisma,
  cleanDatabase,
  createTestUser,
  getSharedServer,
  request,
} = require("./setup");
let server;
before(async () => {
  server = await getSharedServer();
});
after(async () => {
  if (server) await server.close();
  await prisma.$disconnect();
});
async function sync(account, steps = 100) {
  const idempotencyKey = randomUUID();
  const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
    token: account.token,
    headers: { "Idempotency-Key": idempotencyKey, "X-Timezone": "UTC" },
    body: { date: new Date().toISOString().slice(0, 10), steps, samples: [] },
  });
  assert.equal(response.status, 202);
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const row = await prisma.stepSyncRequest.findUnique({
      where: {
        userId_idempotencyKey: { userId: account.user.id, idempotencyKey },
      },
    });
    if (row?.eventsEmittedAt) return response.json();
    await delay(10);
  }
  assert.fail("after-commit event emission did not finish");
}
test(
  "public intake locks existing scoring state without an extra physical UPDATE",
  { timeout: 30000 },
  async () => {
    await cleanDatabase();
    const account = await createTestUser({ timezone: "UTC" });
    await sync(account);
    const initial = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: account.user.id },
    });
    // Audit actual database row updates, not the SQL spelling. Installed only in
    // the dedicated test database and removed even when the assertion fails.
    await prisma.$executeRawUnsafe(
      "CREATE TABLE scoring_lock_update_audit (user_id text)",
    );
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION audit_scoring_lock_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO scoring_lock_update_audit VALUES (NEW.user_id); RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER audit_scoring_lock_update AFTER UPDATE ON user_scoring_input_versions FOR EACH ROW EXECUTE FUNCTION audit_scoring_lock_update()`,
    );
    try {
      await sync(account);
      const rows = await prisma.$queryRawUnsafe(
        "SELECT count(*)::int AS count FROM scoring_lock_update_audit WHERE user_id=$1",
        account.user.id,
      );
      assert.equal(
        (
          await prisma.userScoringInputVersion.findUniqueOrThrow({
            where: { userId: account.user.id },
          })
        ).generation,
        initial.generation,
      );
      console.log(
        JSON.stringify({
          experiment: "physical scoring updates per unchanged sync",
          updates: rows[0].count,
        }),
      );
      assert.equal(
        rows[0].count,
        1,
        "only final state persistence should update the row",
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER audit_scoring_lock_update ON user_scoring_input_versions",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION audit_scoring_lock_update()",
      );
      await prisma.$executeRawUnsafe("DROP TABLE scoring_lock_update_audit");
    }
  },
);
test(
  "concurrent first intakes and corrections serialize without lost scoring generations",
  { timeout: 30000 },
  async () => {
    await cleanDatabase();
    const account = await createTestUser({ timezone: "UTC" });
    await Promise.all([sync(account), sync(account)]);
    const first = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: account.user.id },
    });
    assert.equal(first.generation, 1n);
    await Promise.all([sync(account, 101), sync(account, 101)]);
    const next = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: account.user.id },
    });
    assert.equal(next.generation, 2n);
    assert.equal(next.sourceQueueSemanticsGeneration, next.generation);
  },
);

for (const existing of [false, true])
  test(
    `HTTP intake sees committed state after waiting on ${existing ? "existing row" : "concurrent creation"}`,
    { timeout: 30000 },
    async () => {
      await cleanDatabase();
      const account = await createTestUser({ timezone: "UTC" });
      if (existing) await sync(account);
      const holder = new Client({ connectionString: target.toString() });
      await holder.connect();
      let pending;
      try {
        await holder.query("BEGIN");
        if (existing)
          await holder.query(
            "UPDATE user_scoring_input_versions SET generation=7 WHERE user_id=$1",
            [account.user.id],
          );
        else
          await holder.query(
            "INSERT INTO user_scoring_input_versions(user_id,generation,updated_at) VALUES($1,7,now())",
            [account.user.id],
          );
        const pid = (await holder.query("SELECT pg_backend_pid() AS pid"))
          .rows[0].pid;
        pending = sync(account);
        pending.catch(() => {});
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [row] = await prisma.$queryRawUnsafe(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
            pid,
          );
          if (row.blocked) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        assert.ok(blocked, "real intake must wait for the held scoring row");
        await holder.query("COMMIT");
        await pending;
        const row = await prisma.userScoringInputVersion.findUniqueOrThrow({
          where: { userId: account.user.id },
        });
        assert.equal(
          row.generation,
          8n,
          "use the newly committed generation, not the statement-start snapshot",
        );
        assert.equal(row.sourceQueueSemanticsGeneration, 8n);
      } finally {
        await holder.query("ROLLBACK");
        if (pending) await pending;
        await holder.end();
      }
    },
  );
