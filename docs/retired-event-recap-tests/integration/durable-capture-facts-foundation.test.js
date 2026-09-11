const assert = require("node:assert/strict");
const { before, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const { createTestUser, getSharedServer, prisma, request } = require("./setup");

// These storage invariants have no client-facing pin/materialization endpoint.
// Source production writes use real HTTP; SQL calls exercise the DB-maintained
// history primitive without importing internal JavaScript business helpers.
let server;
const day = new Date().toISOString().slice(0, 10);
async function sync(account, steps) {
  const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
    token: account.token,
    headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
    body: { date: day, steps, samples: [{
      periodStart: `${day}T00:01:00.000Z`,
      periodEnd: `${day}T00:02:00.000Z`, steps,
    }] },
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
}
async function heads(userId) {
  return prisma.$queryRawUnsafe("SELECT day::text, revision::text FROM durable_capture_fact_heads WHERE user_id=$1 ORDER BY day", userId);
}
async function pin(userId, date = day) {
  return prisma.$queryRawUnsafe("SELECT * FROM durable_capture_pin_roots($1::uuid, $2::jsonb)", randomUUID(), JSON.stringify([{ userId, day: date }]));
}
async function prepare(root) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const [status] = await prisma.$queryRawUnsafe("SELECT prepared_at FROM durable_capture_fact_roots WHERE id=$1::uuid", root.root_id);
    if (status.prepared_at) {
      const pages = await prisma.$queryRawUnsafe("SELECT rows FROM durable_capture_fact_pages WHERE root_id=$1::uuid ORDER BY page_number", root.root_id);
      const rows = pages.flatMap((page) => page.rows);
      return {
        samples: rows.filter((row) => row.kind === "sample").map((row) => row.fact).sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.rowId.localeCompare(b.rowId)),
        dailySteps: rows.filter((row) => row.kind === "daily").map((row) => row.fact).sort((a, b) => a.date.localeCompare(b.date) || a.rowId.localeCompare(b.rowId)),
      };
    }
    const [result] = await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid) AS work", root.root_id);
    assert.ok(result.work.sourceSampleRows + result.work.sourceDailyRows + result.work.journalRows <= 256,
      "each page must bound both current source rows and inverse journal lookups");
  }
  assert.fail("bounded foundation preparation did not finish");
}

describe("durable capture fact storage through real step intake", () => {
  before(async () => { server = await getSharedServer(); });
  it("journals HTTP scoring changes and reconstructs a pinned version after another upload", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    await sync(account, 250);
    const facts = await prepare(root);
    assert.equal(facts.samples[0].steps, 100);
    assert.equal(facts.dailySteps[0].steps, 100);
    assert.ok((await heads(account.user.id)).some((row) => BigInt(row.revision) > BigInt(root.revision)));
  });
  it("does not invalidate historical days or metadata-only sample changes", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const initial = await heads(account.user.id);
    await prisma.stepSample.updateMany({ where: { userId: account.user.id }, data: { metadata: { checked: true } } });
    assert.deepEqual(await heads(account.user.id), initial);
    await prisma.step.create({ data: { userId: account.user.id, date: new Date("2020-01-01"), steps: 90 } });
    assert.deepEqual((await heads(account.user.id)).filter((row) => row.day === day), initial);
  });
  it("represents empty revision zero and preserves it across later insertion", async () => {
    const account = await createTestUser();
    const [root] = await pin(account.user.id);
    assert.equal(String(root.revision), "0");
    await sync(account, 100);
    assert.deepEqual(await prepare(root), { samples: [], dailySteps: [] });
  });
  it("retains deleted and moved preimages and deduplicates crossing-day samples", async () => {
    const account = await createTestUser();
    const other = await createTestUser();
    const sample = await prisma.stepSample.create({ data: { userId: account.user.id,
      periodStart: new Date("2020-01-01T23:00:00Z"), periodEnd: new Date("2020-01-03T01:00:00Z"), steps: 777 } });
    const [root] = await pin(account.user.id, "2020-01-02");
    await prisma.stepSample.update({ where: { id: sample.id }, data: { userId: other.user.id,
      periodStart: new Date("2020-01-10T01:00:00Z"), periodEnd: new Date("2020-01-10T02:00:00Z"), steps: 888 } });
    const facts = await prepare(root);
    assert.equal(facts.samples.length, 1);
    assert.equal(facts.samples[0].steps, 777);
    assert.equal(facts.samples[0].userId, account.user.id);
    const [moved] = await pin(other.user.id, "2020-01-10");
    await prisma.stepSample.delete({ where: { id: sample.id } });
    assert.equal((await prepare(moved)).samples[0].steps, 888);
  });
  it("rolls back source facts, heads, journal, and pins atomically", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const initial = await heads(account.user.id);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.step.updateMany({ where: { userId: account.user.id }, data: { steps: 999 } });
      throw new Error("rollback foundation transaction");
    }), /rollback foundation transaction/);
    assert.deepEqual(await heads(account.user.id), initial);
    const [root] = await pin(account.user.id);
    assert.equal((await prepare(root)).dailySteps[0].steps, 100);
  });
  it("bounds membership fanout for years-long legacy samples", async () => {
    const account = await createTestUser();
    await prisma.stepSample.create({ data: { userId: account.user.id,
      periodStart: new Date("2000-01-01"), periodEnd: new Date("2020-01-01"), steps: 42 } });
    assert.equal((await heads(account.user.id)).length, 1);
    const [root] = await pin(account.user.id, "0001-01-01");
    assert.equal((await prepare(root)).samples[0].steps, 42);
  });
  it("reuses one immutable materialization across different durable owners", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [a] = await pin(account.user.id);
    const [b] = await pin(account.user.id);
    assert.equal(a.root_id, b.root_id);
    assert.deepEqual(await prepare(a), await prepare(b));
    const rows = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM durable_capture_fact_roots WHERE user_id=$1 AND day=$2::date", account.user.id, day);
    assert.equal(rows[0].count, 1);
  });
  it("reconstructs unprepared pre-migration revision-zero rows after correction", async () => {
    const account = await createTestUser();
    // Simulate a row present before the additive trigger migration. This DB is
    // exclusive to this file; triggers are restored before the transaction ends.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE steps DISABLE TRIGGER durable_capture_steps_source");
      await tx.step.create({ data: { userId: account.user.id, date: new Date(day), steps: 45 } });
      await tx.$executeRawUnsafe("ALTER TABLE steps ENABLE TRIGGER durable_capture_steps_source");
    });
    const [root] = await pin(account.user.id);
    assert.equal(String(root.revision), "0");
    await sync(account, 100);
    assert.equal((await prepare(root)).dailySteps[0].steps, 45);
    assert.deepEqual((await prepare(root)).samples, []);
  });
  it("collection preserves inverse history for an unprepared revision-zero pin", async () => {
    const account = await createTestUser();
    const [root] = await pin(account.user.id);
    await sync(account, 100);
    const initial = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_journal WHERE user_id=$1", account.user.id);
    await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(10000)");
    const retained = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_journal WHERE user_id=$1", account.user.id);
    assert.equal(retained[0].n, initial[0].n);
    assert.deepEqual(await prepare(root), { samples: [], dailySteps: [] });
    await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(10000)");
    assert.deepEqual(await prepare(root), { samples: [], dailySteps: [] });
  });
  it("collection bounds deletions and retains latest historical materialization after release", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    const facts = await prepare(root);
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_pins WHERE root_id=$1::uuid", root.root_id);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET last_used_at=now()-interval '1 day' WHERE id=$1::uuid", root.root_id);
    const [collected] = await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(1)");
    assert.ok(collected.journal_deleted <= 1);
    assert.ok(collected.roots_deleted <= 1);
    const [reused] = await pin(account.user.id);
    assert.equal(reused.root_id, root.root_id, "unchanged latest roots survive cache lifetimes and retain shared preparation");
    assert.deepEqual(await prepare(reused), facts);
  });
  it("pins different owners in one SQL statement and shares overlapping roots", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const ownerA = randomUUID(); const ownerB = randomUUID();
    const roots = await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_pin_roots(NULL::uuid,$1::jsonb)", JSON.stringify([
      { ownerId: ownerA, userId: account.user.id, day },
      { ownerId: ownerB, userId: account.user.id, day },
    ]));
    assert.equal(roots.length, 2);
    assert.equal(roots[0].root_id, roots[1].root_id);
    assert.deepEqual(new Set(roots.map((row) => row.owner_id)), new Set([ownerA, ownerB]));
  });
  it("overlapping warm pins do not wait for another intake transaction to commit", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [existing] = await pin(account.user.id);
    const first = new Client({ connectionString: process.env.DATABASE_URL });
    const second = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout='250ms'");
      const payload = JSON.stringify([{ userId: account.user.id, day }]);
      await first.query("SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)", [randomUUID(), payload]);
      const later = await second.query("SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)", [randomUUID(), payload]);
      assert.equal(later.rows[0].root_id, existing.root_id);
      await second.query("COMMIT");
      // first deliberately remains open until the second has committed.
      await first.query("COMMIT");
    } finally {
      await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      await Promise.all([first.end(), second.end()]);
    }
  });
  it("intake can pin immutable identity while a worker holds its preparation lock", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [existing] = await pin(account.user.id);
    const worker = new Client({ connectionString: process.env.DATABASE_URL });
    const intake = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([worker.connect(), intake.connect()]);
    try {
      await worker.query("BEGIN");
      await worker.query("SELECT durable_capture_materialize_root($1::uuid)", [existing.root_id]);
      await intake.query("BEGIN");
      await intake.query("SET LOCAL lock_timeout='250ms'");
      const response = await intake.query("SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)",
        [randomUUID(), JSON.stringify([{ userId: account.user.id, day }])]);
      assert.equal(response.rows[0].root_id, existing.root_id);
      await intake.query("COMMIT");
      await worker.query("COMMIT");
    } finally {
      await Promise.all([worker.query("ROLLBACK"), intake.query("ROLLBACK")]);
      await Promise.all([worker.end(), intake.end()]);
    }
  });
  it("concurrent first creation keeps its saved revision vector after waiting for the winning creator", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const first = new Client({ connectionString: process.env.DATABASE_URL });
    const second = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      await second.query("SET LOCAL statement_timeout='5s'");
      const payload = JSON.stringify([{ userId: account.user.id, day }]);
      const early = await first.query("SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)", [randomUUID(), payload]);
      const waiting = second.query("SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)", [randomUUID(), payload]);
      // Observe the actual unique-conflict lock wait, rather than assume that
      // a scheduler delay means the second snapshot has already been taken.
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = await first.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [second.processID]);
        if (probe.rows[0].blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(blocked, true, "second creator must reach its unique-conflict wait");
      await sync(account, 200);
      await first.query("COMMIT");
      const later = await waiting;
      await second.query("COMMIT");
      assert.equal(later.rows[0].root_id, early.rows[0].root_id);
      assert.equal(later.rows[0].revision, early.rows[0].revision);
      assert.equal((await prepare(later.rows[0])).dailySteps[0].steps, 100);
    } finally {
      await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      await Promise.all([first.end(), second.end()]);
    }
  });
  it("reclaims aged latest facts and idle heads only after their final pin is released", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    const facts = await prepare(root);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 day',last_used_at=now()-interval '100 years' WHERE id=$1::uuid", root.root_id);
    await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(1000)");
    assert.deepEqual(await prepare(root), facts, "expired storage policy must never override an active pin");
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_pins WHERE root_id=$1::uuid", root.root_id);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET last_used_at=now()-interval '100 years' WHERE id=$1::uuid", root.root_id);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_heads SET updated_at=now()-interval '100 years',next_compaction_at=now()-interval '100 years' WHERE user_id=$1", account.user.id);
    await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(1000)");
    const roots = await prisma.$queryRawUnsafe("SELECT id FROM durable_capture_fact_roots WHERE id=$1::uuid", root.root_id);
    assert.equal(roots.length, 0);
    assert.deepEqual(await heads(account.user.id), [], "retired heads cannot accumulate forever");
    const [newBaseline] = await pin(account.user.id);
    assert.equal(String(newBaseline.revision), "0");
    assert.deepEqual(await prepare(newBaseline), facts, "a future capture can reconstruct a retired latest version from unchanged source facts");
  });
  it("a large day is prepared in bounded resumable pages instead of one population-sized JSON", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    await prisma.stepSample.createMany({ data: Array.from({ length: 600 }, (_, index) => ({
      userId: account.user.id, steps: index + 1,
      periodStart: new Date(`${day}T02:00:00Z`).getTime() + index * 1000,
      periodEnd: new Date(`${day}T02:00:00Z`).getTime() + (index + 1) * 1000,
    })).map((row) => ({ ...row, periodStart: new Date(row.periodStart), periodEnd: new Date(row.periodEnd) })) });
    const [root] = await pin(account.user.id);
    const [first] = await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid) AS work", root.root_id);
    assert.ok(first.work.sourceSampleRows + first.work.sourceDailyRows <= 256,
      `one advance read ${first.work.sourceSampleRows + first.work.sourceDailyRows} source facts`);
    const [status] = await prisma.$queryRawUnsafe("SELECT prepared_at FROM durable_capture_fact_roots WHERE id=$1::uuid", root.root_id);
    assert.equal(status.prepared_at, null, "large roots must yield before completing all physical source work");
    const facts = await prepare(root);
    assert.equal(facts.samples.length, 601);
    const pages = await prisma.$queryRawUnsafe("SELECT row_count FROM durable_capture_fact_pages WHERE root_id=$1::uuid", root.root_id);
    assert.ok(pages.length > 1);
    assert.ok(pages.every((page) => page.row_count <= 256));
  });
  it("cursor-crossing moves, deletion, and new rows between pages preserve exactly the originally pinned facts", async () => {
    const account = await createTestUser();
    const other = await createTestUser();
    await sync(account, 100);
    await prisma.stepSample.createMany({ data: Array.from({ length: 400 }, (_, index) => ({
      userId: account.user.id, steps: index + 1,
      periodStart: new Date(new Date(`${day}T02:00:00Z`).getTime() + index * 1000),
      periodEnd: new Date(new Date(`${day}T02:00:00Z`).getTime() + (index + 1) * 1000),
    })) });
    const original = await prisma.stepSample.findMany({ where: { userId: account.user.id }, orderBy: { periodStart: "asc" } });
    const [root] = await pin(account.user.id);
    await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid)", root.root_id); // daily
    await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid)", root.root_id); // first128 samples
    await prisma.stepSample.update({ where: { id: original[250].id }, data: {
      periodStart: new Date(`${day}T00:00:10Z`), periodEnd: new Date(`${day}T00:00:20Z`), steps: 9999,
    } });
    await prisma.stepSample.update({ where: { id: original[20].id }, data: {
      periodStart: new Date(`${day}T14:00:00Z`), periodEnd: new Date(`${day}T14:01:00Z`),
    } });
    await prisma.stepSample.delete({ where: { id: original[300].id } });
    await prisma.stepSample.update({ where: { id: original[350].id }, data: { userId: other.user.id } });
    await prisma.stepSample.create({ data: { userId: account.user.id, steps: 999,
      periodStart: new Date(`${day}T15:00:00Z`), periodEnd: new Date(`${day}T15:01:00Z`) } });
    const facts = await prepare(root);
    assert.deepEqual(facts.samples, original.map((row) => ({ rowId: row.id, userId: row.userId,
      periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(), steps: row.steps })));
  });
  it("an old unprepared root replays a large correction journal in bounded pages", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    await prisma.$executeRawUnsafe(`DO $$ BEGIN FOR iteration IN 1..600 LOOP
      UPDATE steps SET steps=steps+1 WHERE user_id='${account.user.id}';
      END LOOP; END $$`);
    const facts = await prepare(root);
    assert.equal(facts.dailySteps[0].steps, 100);
    const [status] = await prisma.$queryRawUnsafe("SELECT journal_rows FROM durable_capture_fact_roots WHERE id=$1::uuid", root.root_id);
    assert.ok(status.journal_rows >= 600, "all post-pin corrections must be covered by the bounded journal sweep");
  });
  it("eviction deletes bounded child rows and allows a new pin without resurrecting partial old pages", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    const expected = await prepare(root);
    await prisma.$executeRawUnsafe("DELETE FROM durable_capture_fact_pins WHERE root_id=$1::uuid", root.root_id);
    await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 day',last_used_at=now()-interval '1000 years' WHERE id=$1::uuid", root.root_id);
    const [before] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_identities WHERE root_id=$1::uuid", root.root_id);
    assert.equal(before.n, 2);
    await prisma.$queryRawUnsafe("SELECT * FROM durable_capture_compact(1)");
    const [after] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_identities WHERE root_id=$1::uuid", root.root_id);
    assert.equal(after.n, 1, "one collector call may remove only one identity at limit1, not cascade-delete the whole root");
    const [fresh] = await pin(account.user.id);
    assert.notEqual(fresh.root_id, root.root_id);
    assert.deepEqual(await prepare(fresh), expected);
  });
  it("long-span sentinel preparation is bounded and preserves transitions between long and ordinary samples", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    await prisma.stepSample.createMany({ data: Array.from({ length: 300 }, (_, index) => ({
      userId: account.user.id, steps: index + 1,
      periodStart: new Date(Date.UTC(2000, 0, index + 1)), periodEnd: new Date("2040-01-01"),
    })) });
    const [longRoot] = await pin(account.user.id, "0001-01-01");
    const before = await prisma.stepSample.findMany({ where: { userId: account.user.id, periodEnd: new Date("2040-01-01") }, orderBy: { periodStart: "asc" } });
    await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid)", longRoot.root_id);
    await prisma.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid)", longRoot.root_id);
    await prisma.stepSample.update({ where: { id: before[200].id }, data: {
      periodStart: new Date("2000-01-01T01:00:00Z"), periodEnd: new Date("2000-01-01T02:00:00Z"),
    } });
    const facts = await prepare(longRoot);
    assert.deepEqual(facts.samples, before.map((row) => ({ rowId: row.id,userId: row.userId,steps: row.steps,
      periodStart: row.periodStart.toISOString(),periodEnd: row.periodEnd.toISOString() })));
    const [ordinaryRoot] = await pin(account.user.id, day);
    const ordinary = await prisma.stepSample.findFirstOrThrow({ where: { userId: account.user.id, periodStart: new Date(`${day}T00:01:00Z`) } });
    await prisma.stepSample.update({ where: { id: ordinary.id }, data: { periodEnd: new Date("2050-01-01") } });
    const ordinaryFacts = await prepare(ordinaryRoot);
    assert.equal(ordinaryFacts.samples.length, 1);
    assert.equal(ordinaryFacts.samples[0].periodEnd, `${day}T00:02:00.000Z`);
  });
  it("rolling back a page rolls back its cursor, identity ledger, and digest together", async () => {
    const account = await createTestUser();
    await sync(account, 100);
    const [root] = await pin(account.user.id);
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT durable_capture_materialize_root($1::uuid)", root.root_id);
      throw new Error("rollback materialization page");
    }), /rollback materialization page/);
    const [state] = await prisma.$queryRawUnsafe("SELECT page_count,preparation_phase,initial_digest FROM durable_capture_fact_roots WHERE id=$1::uuid", root.root_id);
    assert.deepEqual(state, { page_count: 0, preparation_phase: "DAILY", initial_digest: null });
    const [identities] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_identities WHERE root_id=$1::uuid", root.root_id);
    assert.equal(identities.n, 0);
    const facts = await prepare(root);
    assert.equal(facts.samples[0].steps, 100);
    assert.equal(facts.dailySteps[0].steps, 100);
  });
});
