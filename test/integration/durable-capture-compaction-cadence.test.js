const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { Client } = require("pg");
const { before, beforeEach, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { buildGlobalEventSummaryV2Tick, scheduleGlobalEventSummaryTick } = require("../../src/modules/steps/jobs/globalEventSummary");

let server;
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);
async function upload(account, steps) {
  const day = new Date().toISOString().slice(0, 10);
  const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
    token: account.token, headers: { "Idempotency-Key": randomUUID(), "X-Timezone": "UTC" },
    body: { date: day, steps, samples: [{ periodStart: `${day}T00:01:00.000Z`,
      periodEnd: `${day}T00:02:00.000Z`, steps }] },
  });
  assert.equal(response.status, 202);
}
async function ageHeads(userId) {
  await prisma.$executeRawUnsafe(`UPDATE durable_capture_fact_heads
    SET updated_at=clock_timestamp()-interval '11 minutes', next_compaction_at=clock_timestamp()-interval '1 second'
    WHERE user_id=$1`, userId);
}
async function journalCount(userId) {
  return (await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM durable_capture_fact_journal WHERE user_id=$1", userId))[0].n;
}
const wake = () => buildGlobalEventSummaryV2Tick({ prisma })({ recovery: false });

it("ordinary summary wakes and new worker instances do not rerun compaction before it is due", async () => {
  const account = await createTestUser();
  await upload(account, 50);
  await ageHeads(account.user.id);
  assert.ok(await journalCount(account.user.id));
  await wake();
  assert.equal(await journalCount(account.user.id), 0);
  await upload(account, 60);
  await ageHeads(account.user.id);
  const pending = await journalCount(account.user.id);
  assert.ok(pending > 0);
  // Each wake builds a new runner: the due gate must survive process-local state loss.
  for (let i = 0; i < 4; i++) await wake();
  assert.equal(await journalCount(account.user.id), pending,
    "capture wakes must not repeat fact compaction during the persisted cooldown");
  await prisma.$executeRawUnsafe("UPDATE durable_capture_compaction_schedule SET next_due_at=clock_timestamp()-interval '1 second'");
  await wake();
  assert.equal(await journalCount(account.user.id), 0, "due maintenance still collects unpinned history");
});

it("a full maintenance batch keeps its 128-row bound and schedules a prompt continuation", async () => {
  const account = await createTestUser();
  for (let i = 1; i <= 70; i++) await upload(account, i);
  await ageHeads(account.user.id);
  const before = await journalCount(account.user.id);
  assert.ok(before > 128);
  await wake();
  assert.equal(before - await journalCount(account.user.id), 128);
  const [schedule] = await prisma.$queryRawUnsafe(`SELECT
    extract(epoch from next_due_at-last_completed_at)::float8 AS delay_seconds
    FROM durable_capture_compaction_schedule`);
  assert.equal(schedule.delay_seconds, 1);
  const [head] = await prisma.$queryRawUnsafe(`SELECT
    head.next_compaction_at <= schedule.next_due_at + interval '100 milliseconds' AS promptly_due
    FROM durable_capture_fact_heads head CROSS JOIN durable_capture_compaction_schedule schedule
    WHERE head.user_id=$1`, account.user.id);
  assert.equal(head.promptly_due, true, "the per-head cursor must not postpone a full batch for another minute");
  // Let both durable deadlines elapse without another upload or fixture repair.
  await delay(1100);
  await wake();
  assert.equal(await journalCount(account.user.id), 0);
});

it("a rolled-back compaction preserves both its history and its due deadline", async () => {
  const account = await createTestUser();
  await upload(account, 50);
  await ageHeads(account.user.id);
  const pending = await journalCount(account.user.id);
  await assert.rejects(prisma.$transaction(async tx => {
    const [result] = await tx.$queryRawUnsafe("SELECT * FROM durable_capture_compact_if_due(128)");
    assert.equal(result.ran, true);
    assert.equal(result.journal_deleted, pending);
    throw new Error("simulated worker rollback");
  }), /simulated worker rollback/);
  assert.equal(await journalCount(account.user.id), pending);
  await wake();
  assert.equal(await journalCount(account.user.id), 0);
});

it("a concurrent maintenance owner does not make ordinary summary wakes wait on its lock", async () => {
  const account = await createTestUser();
  await upload(account, 50);
  await ageHeads(account.user.id);
  // Install the singleton before contending, as the first normal wake does.
  await prisma.$executeRawUnsafe("INSERT INTO durable_capture_compaction_schedule(singleton) VALUES (true)");
  const owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT * FROM durable_capture_compaction_schedule FOR UPDATE");
    await prisma.$transaction(async contender => {
      await contender.$executeRawUnsafe("SET LOCAL statement_timeout='500ms'");
      const [result] = await contender.$queryRawUnsafe("SELECT * FROM durable_capture_compact_if_due(128)");
      assert.equal(result.ran, false);
      assert.equal(result.journal_deleted, 0);
    });
  } finally {
    await owner.query("ROLLBACK");
    await owner.end();
  }
  assert.ok(await journalCount(account.user.id));
  await wake();
  assert.equal(await journalCount(account.user.id), 0);
});

it("the real summary wake coordinator continues compaction without another user upload", async () => {
  const account = await createTestUser();
  for (let i = 1; i <= 70; i++) await upload(account, i);
  await ageHeads(account.user.id);
  const timers = [];
  const errors = [];
  const scheduler = scheduleGlobalEventSummaryTick({
    prisma,
    subscribeWake: async () => () => {},
    setDueTimer(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearDueTimer(timer) { timer.cancelled = true; },
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
    logger: { log() {}, error(...args) { errors.push(args); } },
  });
  try {
    let due;
    for (let i = 0; i < 100; i++) {
      due = timers.find(timer => !timer.cancelled && timer.ms > 0 && timer.ms <= 1100);
      if (due) break;
      await delay(10);
    }
    assert.deepEqual(errors, []);
    assert.ok(due, "the persisted maintenance deadline must arm the production wake coordinator");
    assert.ok(await journalCount(account.user.id));
    await delay(1100);
    await due.fn();
    for (let i = 0; i < 100 && await journalCount(account.user.id); i++) await delay(10);
    assert.equal(await journalCount(account.user.id), 0);
    assert.deepEqual(errors, []);
  } finally { await scheduler.stop(); }
});
