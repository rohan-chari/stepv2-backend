const assert = require("node:assert/strict");
const { before, beforeEach, after, it } = require("node:test");
const { Client } = require("pg");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(decodeURIComponent(target.pathname), /_test$/);
assert.equal(process.env.NODE_ENV, "test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.DOTENV_CONFIG_QUIET = "true";
const { prisma } = require("../../src/db");
// Automatic admission has no HTTP endpoint: exercise its real model and DB
// transactions. Manual operator assertions also execute the public CLI.
const { DomainEventReceiptRecovery: model } = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery");
const db = new Client({ connectionString: target.toString() });
const cutoff = new Date("2026-02-01T00:00:00Z");
const now = new Date("2026-09-11T00:00:00Z");
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let observed = [];
prisma.$on("query", (query) => observed.push(query));

before(async () => { await db.connect(); await db.query("SET timezone TO 'UTC'"); });
beforeEach(async () => {
  await db.query("DELETE FROM domain_event_audiences; DELETE FROM domain_event_notification_projections; DELETE FROM domain_event_outbox; DELETE FROM domain_event_receipts; DELETE FROM domain_event_receipt_recovery; DELETE FROM domain_event_receipt_discovery");
  observed = [];
});
after(async () => { await db.end(); await prisma.$disconnect(); });

async function source(count = 1, { start = 1, final = false } = {}) {
  await db.query(`INSERT INTO domain_event_outbox
    (id,event_key,event_type,schema_version,aggregate_type,aggregate_id,occurred_at,available_at,payload,created_at)
    SELECT ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
      'discovery:'||i,'DISCOVERY_TEST_V1',1,'TEST','test',timestamp '2026-01-01',timestamp '2026-01-01','{}',
      timestamp '2026-01-01' + i * interval '1 millisecond'
    FROM generate_series($1::int,$2::int) i`, [start, start + count - 1]);
  if (final) await db.query(`UPDATE domain_event_receipts SET receipt_state='FINAL',envelope_digest=repeat('a',64),finalized_at=now()`);
  // Historical fixtures predate compatibility enqueue. Remove only their
  // synthetic jobs to recreate that pre-migration state.
  await db.query("DELETE FROM domain_event_receipt_recovery WHERE event_key LIKE 'discovery:%'");
}

async function active(count, status = "QUEUED", offset = 0) {
  await db.query(`INSERT INTO domain_event_receipt_recovery
    (domain_event_id,event_key,reason,status,available_at,lease_until,lease_token)
    SELECT gen_random_uuid(),'active:'||($2::int+i),'COMPAT_PROVISIONAL',$3::text,
      timestamp '2099-01-01',CASE WHEN $3::text='PROCESSING' THEN timestamp '2099-01-01' END,
      CASE WHEN $3::text='PROCESSING' THEN 'live-lease' END
    FROM generate_series(1,$1::int) i`, [count, offset, status]);
}

async function checkpoints() {
  return (await db.query("SELECT * FROM domain_event_receipt_discovery ORDER BY id")).rows;
}

async function cli(args = []) {
  const { stdout } = await promisify(execFile)(process.execPath, [
    path.resolve(__dirname, "../../scripts/discover-domain-event-receipt-recovery.js"),
    `--cutoff=${cutoff.toISOString()}`, ...args,
  ], {
    env: { ...process.env, DATABASE_URL: target.toString(), NODE_ENV: "test", REDIS_URL: "", DOTENV_CONFIG_QUIET: "true" },
    timeout: 15000,
  });
  return JSON.parse(stdout);
}

it("paces absent/incomplete automatic discovery without writing, then stops permanently at exhaustion", async () => {
  assert.equal((await model.automaticDiscoveryDueAt({ now })).getTime(), now.getTime() + 1000);
  assert.deepEqual(await checkpoints(), []);
  await source(3, { final: true });
  const first = await model.discoverAutomaticPage({ limit: 2 });
  assert.equal(first.scanned, 2);
  assert.equal(first.discovered, 0);
  assert.equal(first.deferred, false);
  assert.equal(first.exhausted, false);
  assert.equal((await model.automaticDiscoveryDueAt({ now })).getTime(), now.getTime() + 1000);
  const second = await model.discoverAutomaticPage({ limit: 2 });
  assert.equal(second.scanned, 1);
  assert.equal(second.exhausted, true);
  assert.equal(second.cutoff.getTime(), first.cutoff.getTime());
  const saved = await checkpoints();
  assert.equal(await model.automaticDiscoveryDueAt({ now }), null);
  observed = [];
  assert.equal((await model.discoverAutomaticPage()).scanned, 0);
  assert.ok(!observed.some((q) => q.query.includes("WITH source_page")));
  assert.deepEqual(await checkpoints(), saved);
});

for (const completed of [false, true]) {
  it(`revisits the gap after an old ${completed ? "completed" : "incomplete"} manual cutoff without adopting its cursor`, async () => {
    await source(2);
    await db.query("DELETE FROM domain_event_receipts WHERE domain_event_id=$1", [id(2)]);
    await db.query(`INSERT INTO domain_event_receipt_discovery
      (id,cutoff,cursor_created_at,cursor_id,completed_at) VALUES
      ('historical-v1',timestamp '2025-12-01',timestamp '2025-11-01',$1,$2)`,
    [id(99), completed ? cutoff : null]);
    const manual = (await checkpoints())[0];
    const before = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const page = await model.discoverAutomaticPage();
    const after = (await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
    assert.equal(page.discovered, 2);
    assert.ok(page.cutoff >= before && page.cutoff <= after);
    assert.deepEqual((await checkpoints()).find((s) => s.id === "historical-v1"), manual);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM domain_event_receipt_recovery")).rows[0].count, 2);
  });
}

it("counts future retries and unexpired processing leases together; every apply defers without cursor movement then resumes", async () => {
  await source(2);
  await active(250, "RETRY");
  await active(250, "PROCESSING", 250);
  assert.equal(await model.automaticDiscoveryDueAt({ now }), null);
  const automatic = await model.discoverAutomaticPage();
  assert.equal(automatic.deferred, true);
  assert.equal(automatic.exhausted, false);
  assert.equal(automatic.nextCursor, null);
  const state = (await checkpoints()).find((s) => s.id === "automatic-v1");
  const cursor = { createdAt: new Date("2025-01-01"), id: id(1) };
  const manual = await model.discoverPage({ cutoff, cursor });
  assert.equal(manual.deferred, true);
  assert.deepEqual(manual.nextCursor, cursor);
  assert.equal(manual.scanned, 0);
  const historical = await model.discoverNextPage({ cutoff });
  assert.equal(historical.deferred, true);
  assert.equal(historical.nextCursor, null);
  assert.deepEqual((await checkpoints()).find((s) => s.id === "automatic-v1"), state);
  await db.query("DELETE FROM domain_event_receipt_recovery WHERE event_key LIKE 'active:%'");
  assert.equal((await model.automaticDiscoveryDueAt({ now })).getTime(), now.getTime() + 1000);
  assert.equal((await model.discoverAutomaticPage()).discovered, 2);
});

it("serializes concurrent explicit-manual and cron admission at the same threshold", async () => {
  await source(200);
  await active(499);
  const results = await Promise.all([
    model.discoverPage({ cutoff, cursor: { createdAt: new Date("2026-01-01T00:00:00.100Z"), id: id(100) }, limit: 100 }),
    model.discoverAutomaticPage({ limit: 100 }),
  ]);
  assert.deepEqual(results.map((r) => r.deferred).sort(), [false, true]);
  assert.equal(results.reduce((sum, r) => sum + r.scanned, 0), 100);
  assert.equal((await db.query("SELECT count(*)::int AS count FROM domain_event_receipt_recovery")).rows[0].count, 599);
  const automatic = (await checkpoints())[0];
  assert.equal(Number(automatic.scanned), results[1].deferred ? 0 : 100);
});

it("manual checkpoint pages deduplicate existing jobs and never advance automatic progress", async () => {
  await source(2);
  await model.enqueue({ domainEventId: id(1), eventKey: "discovery:1", reason: "COMPAT_PROVISIONAL" });
  await db.query("UPDATE domain_event_receipt_recovery SET status='FAILED_TERMINAL',last_error_code='EVIDENCE'");
  const page = await model.discoverNextPage({ cutoff, limit: 1 });
  assert.equal(page.deferred, false);
  assert.equal(page.scanned, 1);
  const auto = (await checkpoints()).find((s) => s.id === "automatic-v1");
  assert.equal(auto.cursor_id, null);
  assert.equal(auto.completed_at, null);
  const next = await model.discoverNextPage({ cutoff: new Date("2027-01-01"), limit: 2 });
  assert.equal(next.cutoff.getTime(), cutoff.getTime());
  assert.equal(next.scanned, 1);
  assert.equal(next.exhausted, true);
  const job = (await db.query("SELECT * FROM domain_event_receipt_recovery WHERE event_key='discovery:1'")).rows[0];
  assert.equal(job.status, "FAILED_TERMINAL");
  assert.equal(job.last_error_code, "EVIDENCE");
  assert.deepEqual((await checkpoints()).find((s) => s.id === "automatic-v1"), auto);
});

it("rejects initialization before compatibility enqueue is enabled for every apply entry point", async () => {
  await db.query("ALTER TABLE domain_event_outbox DISABLE TRIGGER domain_event_receipt_recovery_compat_trigger");
  try {
    for (const work of [() => model.discoverAutomaticPage(), () => model.discoverPage({ cutoff }), () => model.discoverNextPage({ cutoff })]) {
      await assert.rejects(work, /compatibility|migration/i);
      assert.deepEqual(await checkpoints(), []);
    }
  } finally {
    await db.query("ALTER TABLE domain_event_outbox ENABLE TRIGGER domain_event_receipt_recovery_compat_trigger");
  }
});

it("deferred trigger covers a pre-cutoff timestamp committing after discovery already exhausted", async () => {
  await source(1, { final: true });
  await db.query("BEGIN");
  try {
    await db.query(`INSERT INTO domain_event_outbox
      (id,event_key,event_type,schema_version,aggregate_type,aggregate_id,occurred_at,available_at,payload,created_at)
      VALUES ($1,'late:commit','LATE_TEST',1,'TEST','late',timestamp '2025-01-01',timestamp '2025-01-01','{}',timestamp '2025-01-01')`, [id(99)]);
    const page = await model.discoverAutomaticPage();
    assert.equal(page.scanned, 1);
    assert.equal(page.exhausted, true);
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 0);
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  const job = await prisma.domainEventReceiptRecovery.findUnique({ where: { eventKey: "late:commit" } });
  assert.equal(job.reason, "COMPAT_PROVISIONAL");
  assert.equal(job.status, "QUEUED");
  assert.equal(await model.automaticDiscoveryDueAt({ now }), null);
});

it("rolls back candidate insertion and checkpoint creation when cursor persistence fails", async () => {
  await source(2);
  await db.query(`CREATE FUNCTION test_reject_discovery_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'forced cursor rollback'; END $$;
    CREATE TRIGGER test_reject_discovery_cursor BEFORE UPDATE ON domain_event_receipt_discovery
    FOR EACH ROW EXECUTE FUNCTION test_reject_discovery_cursor()`);
  try {
    for (const work of [() => model.discoverAutomaticPage(), () => model.discoverNextPage({ cutoff })]) {
      await assert.rejects(work, /forced cursor rollback/);
      assert.deepEqual(await checkpoints(), []);
      assert.equal(await prisma.domainEventReceiptRecovery.count(), 0);
    }
  } finally {
    await db.query("DROP TRIGGER test_reject_discovery_cursor ON domain_event_receipt_discovery; DROP FUNCTION test_reject_discovery_cursor()");
  }
  assert.equal((await model.discoverAutomaticPage()).discovered, 2);
});

it("all apply entry points honor the same 250ms admission lock timeout without changing progress", async () => {
  await active(500);
  await model.discoverAutomaticPage();
  const saved = await checkpoints();
  await db.query("BEGIN");
  await db.query("SELECT * FROM domain_event_receipt_discovery WHERE id='automatic-v1' FOR UPDATE");
  try {
    for (const work of [() => model.discoverAutomaticPage(), () => model.discoverPage({ cutoff }), () => model.discoverNextPage({ cutoff })]) {
      const started = Date.now();
      await assert.rejects(work, /lock timeout/);
      assert.ok(Date.now() - started < 2000);
    }
  } finally { await db.query("ROLLBACK"); }
  assert.deepEqual(await checkpoints(), saved);
});

it("CLI preview preserves old arguments, performs no writes, and apply reports shared backpressure", async () => {
  await source(3);
  await active(500, "RETRY");
  const args = ["--limit=1", "--after-created-at=2026-01-01T00:00:00.001Z", `--after-id=${id(1)}`];
  const preview = await cli(args);
  assert.equal(preview.readOnly, true);
  assert.equal(preview.scanned, 1);
  assert.equal(preview.rows[0].domainEventId, id(2));
  assert.equal(preview.deferred, false);
  assert.deepEqual(await checkpoints(), []);
  assert.equal(await prisma.domainEventReceiptRecovery.count(), 500);
  const applied = await cli([...args, "--apply"]);
  assert.equal(applied.readOnly, false);
  assert.equal(applied.deferred, true);
  assert.equal(applied.nextCursor.id, id(1));
  assert.equal(applied.scanned, 0);
});

it("actual query plans use separately limited active indexes and receipt point lookups after source LIMIT", async () => {
  await active(10000, "RETRY");
  await active(10000, "PROCESSING", 10000);
  await source(3000, { final: true });
  await db.query("ANALYZE domain_event_receipt_recovery; ANALYZE domain_event_outbox; ANALYZE domain_event_receipts");
  observed = [];
  assert.equal(await model.automaticDiscoveryDueAt({ now }), null);
  await model.discoverAutomaticPage();
  const admissionQueries = observed.filter((q) => q.query.includes("domain_event_receipt_recovery") && q.query.includes("LIMIT 500"));
  assert.equal(admissionQueries.length, 2, "due check and locked admission each use one bounded snapshot");
  for (const query of admissionQueries) {
    const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.query}`, JSON.parse(query.params))).rows[0]["QUERY PLAN"][0].Plan;
    const nodes = flatten(plan);
    for (const suffix of ["due", "lease"]) {
      const limit = nodes.find((node) => node["Node Type"] === "Limit" &&
        node.Plans?.[0]?.["Index Name"] === `domain_event_receipt_recovery_${suffix}_idx`);
      assert.ok(limit, JSON.stringify(plan));
      assert.ok(limit["Actual Rows"] <= 500);
      assert.ok(limit.Plans[0]["Actual Rows"] <= 500);
    }
  }
  await db.query("DELETE FROM domain_event_receipt_recovery");
  observed = [];
  assert.equal((await model.discoverAutomaticPage({ limit: 10 })).scanned, 10);
  const query = observed.find((q) => q.query.includes("WITH source_page"));
  assert.ok(query);
  const plan = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query.query}`, JSON.parse(query.params))).rows[0]["QUERY PLAN"][0].Plan;
  const nodes = flatten(plan);
  const sourcePage = nodes.find((n) => n["Subplan Name"] === "CTE source_page");
  assert.equal(sourcePage["Node Type"], "Limit");
  assert.equal(sourcePage["Actual Rows"], 10);
  assert.ok(flatten(sourcePage).some((n) => n["Index Name"] === "domain_event_outbox_created_at_id_receipt_recovery_idx"));
  const receiptLookup = nodes.find((n) => n["Index Name"] === "domain_event_receipts_domain_event_id_key");
  assert.ok(receiptLookup, JSON.stringify(plan));
  assert.equal(receiptLookup["Actual Loops"], 10);
  assert.ok(!nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "domain_event_receipts"));
});

function flatten(plan) { return [plan, ...(plan.Plans || []).flatMap(flatten)]; }
