const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
let baseUrl, observed = null;
const date = "2026-09-09";
async function sync(account, body = { date, steps: 123, samples: [] }, key = randomUUID()) {
  const res = await request(baseUrl, "POST", "/steps/sync-v2", { token: account.token,
    headers: { "Idempotency-Key": key }, body });
  return { status: res.status, body: await res.json() };
}
async function tuple(userId) {
  const [row] = await prisma.$queryRawUnsafe(`SELECT ctid::text,updated_at,generation,
    source_queue_semantics_generation FROM user_scoring_input_versions WHERE user_id=$1`, userId);
  return row;
}
describe("event action unchanged intake efficiency", () => {
  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
    prisma.$on("query", ({ query }) => { if (observed) observed.push(query); });
  });
  beforeEach(cleanDatabase);
  it("leaves the scoring tuple untouched and returns unchanged daily data without a second read", async () => {
    const account = await createTestUser();
    assert.equal((await sync(account)).status, 202);
    const before = await tuple(account.user.id);
    const dailyBefore = await prisma.step.findFirstOrThrow({ where: { userId: account.user.id } });
    observed = [];
    const response = await sync(account);
    const queries = observed;
    observed = null;
    assert.equal(response.status, 202);
    assert.deepEqual(await tuple(account.user.id), before, "no new MVCC scoring tuple or updated_at heartbeat");
    assert.ok(!queries.some(q => /^UPDATE user_scoring_input_versions/.test(q)));
    assert.ok(!queries.some(q => /^SELECT id,user_id AS "userId",steps,step_goal/.test(q)));
    assert.deepEqual(await prisma.step.findFirstOrThrow({ where: { userId: account.user.id } }), dailyBefore);
    assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: account.user.id } })).lastStepSyncAt);
  });
  it("pins database trigger audit: source version has no user trigger requiring upload heartbeats", async () => {
    const triggers = await prisma.$queryRawUnsafe(`SELECT tgname,pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid='user_scoring_input_versions'::regclass AND NOT tgisinternal`);
    assert.deepEqual(triggers, []);
  });
  it("keeps new daily rows, date rollover, replay, conflicting keys and concurrent writers coherent", async () => {
    const account = await createTestUser();
    const key = randomUUID();
    const first = await sync(account, undefined, key);
    assert.equal(first.status, 202);
    assert.deepEqual(await sync(account, undefined, key), first);
    assert.equal((await sync(account, { date, steps: 124, samples: [] }, key)).status, 409);
    const nextDate = "2026-09-10";
    const writes = await Promise.all([123, 124, 125].map(steps => request(baseUrl, "POST", "/steps", {
      token: account.token, body: { date: nextDate, steps },
    })));
    assert.deepEqual(writes.map(r => r.status), [200, 200, 200]);
    const bodies = await Promise.all(writes.map(r => r.json()));
    assert.deepEqual(bodies.map(b => b.record.steps), [123, 124, 125]);
    assert.equal(new Set(bodies.map(b => b.record.id)).size, 1);
    assert.ok(bodies.every(b => b.record.stepGoal === 5000));
    assert.equal(await prisma.step.count({ where: { userId: account.user.id } }), 2);
  });
  for (const existing of [false, true]) it(`returns the committed daily row after a legacy ${existing ? "update" : "insert"} invisible to the UPSERT snapshot`, async () => {
    const { Client } = require("pg");
    const account = await createTestUser();
    if (existing) await prisma.step.create({ data: { userId: account.user.id, date: new Date(date), steps: 122 } });
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    const lock = 909103;
    await blocker.query("SELECT pg_advisory_lock($1)", [lock]);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION test_daily_visibility_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('application_name') LIKE 'steps-%' THEN
          PERFORM pg_advisory_xact_lock(${lock});
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_daily_visibility_barrier BEFORE INSERT ON steps
        FOR EACH ROW EXECUTE FUNCTION test_daily_visibility_barrier()`);
    let response;
    try {
      response = request(baseUrl, "POST", "/steps", { token: account.token, body: { date, steps: 123 } });
      const until = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < until) {
        const result = await blocker.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [lock]);
        if (result.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "HTTP UPSERT must have taken its snapshot before the legacy writer commits");
      const legacyId = randomUUID();
      let expectedId = legacyId;
      if (existing) {
        const updated = await blocker.query(`UPDATE steps SET steps=123 WHERE user_id=$1 AND date=$2 RETURNING id`, [account.user.id, date]);
        expectedId = updated.rows[0].id;
      } else await blocker.query(`INSERT INTO steps (id,user_id,date,steps) VALUES ($1,$2,$3,123)`, [legacyId, account.user.id, date]);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lock]);
      const result = await response;
      assert.equal(result.status, 200);
      const body = await result.json();
      assert.equal(body.record.id, expectedId);
      assert.equal(body.record.steps, 123);
      assert.equal(body.record.stepGoal, 5000);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      if (response) await response;
      await prisma.$executeRawUnsafe("DROP TRIGGER test_daily_visibility_barrier ON steps; DROP FUNCTION test_daily_visibility_barrier()");
      await blocker.end();
    }
  });

});
