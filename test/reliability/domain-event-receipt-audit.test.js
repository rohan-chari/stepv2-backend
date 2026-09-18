const assert = require("node:assert/strict");
const { before, beforeEach, after, it } = require("node:test");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

// Exercise the operator's actual CLI against isolated tables from the real
// migrations. Never load app setup, .env, or regenerate the shared Prisma client.
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(decodeURIComponent(target.pathname), /_test$/);
assert.equal(process.env.NODE_ENV, "test");
const schema = `receipt_audit_${process.pid}`;
const db = new Client({ connectionString: target.toString() });
const childUrl = new URL(target);
childUrl.searchParams.set("options", `-c search_path=${schema} -c timezone=UTC`);
const root = path.resolve(__dirname, "../..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-audit-cli-"));
const cutoff = "2026-09-01T00:00:00.000Z";
const id = (number) => `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;

function audit(args = [], { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(root, "scripts/audit-domain-event-receipts.js"), ...args], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: childUrl.toString(),
        REDIS_URL: "", REFERRAL_IP_HMAC_ACTIVE_VERSION: "1",
        REFERRAL_IP_HMAC_SECRET_V1: "integration-test-only-referral-hmac-secret-material",
      },
      timeout: 15000,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      let report = null;
      try { if (!raw && stdout.trim()) report = JSON.parse(stdout); }
      catch { return reject(new Error(`Audit did not emit JSON: ${stdout}\n${stderr}`)); }
      resolve({ code: error?.code || 0, report, stderr, stdout });
    });
  });
}

before(async () => {
  await db.connect();
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path TO ${schema}`);
  await db.query("SET timezone TO 'UTC'");
  for (const [migration, table] of [
    ["20260825200000_add_domain_event_outbox", "domain_event_outbox"],
    ["20260902120000_durable_queue_receipts_and_readiness", "domain_event_receipts"],
    ["20260911130000_domain_event_receipt_recovery", "domain_event_receipt_recovery"],
  ]) {
    const sql = fs.readFileSync(path.join(root, "prisma/migrations", migration, "migration.sql"), "utf8");
    const statement = sql.match(new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`));
    assert.ok(statement, `real migration defines ${table}`);
    await db.query(statement[0]);
  }
  await db.query(fs.readFileSync(path.join(root,
    "prisma/migrations/20260911131000_receipt_discovery_index/migration.sql"), "utf8"));

  // Real PG functions enforce read-only transactions and can delay one lookup.
  // Delaying an unvisited receipt also detects joins over the whole population.
  await db.query(`
    CREATE TABLE audit_delays (kind text PRIMARY KEY, id uuid);
    CREATE FUNCTION audit_state(kind text, row_id uuid, state text) RETURNS text
    LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF current_setting('transaction_read_only') <> 'on' THEN
        RAISE EXCEPTION 'audit query must be read only';
      END IF;
      IF EXISTS (SELECT 1 FROM audit_delays d WHERE d.kind=$1 AND d.id=$2) THEN
        PERFORM pg_sleep(0.3);
      END IF;
      RETURN state;
    END;
    $$;
    ALTER TABLE domain_event_receipts RENAME TO audit_receipts_data;
    CREATE VIEW domain_event_receipts AS
      SELECT domain_event_id,event_key,
        audit_state('receipt',domain_event_id,receipt_state) AS receipt_state
      FROM audit_receipts_data;
    ALTER TABLE domain_event_receipt_recovery RENAME TO audit_recovery_data;
    CREATE VIEW domain_event_receipt_recovery AS
      SELECT id,created_at,available_at,audit_state('queue',id,status) AS status
      FROM audit_recovery_data;
  `);
});

beforeEach(async () => {
  await db.query("TRUNCATE domain_event_outbox,audit_receipts_data,audit_recovery_data,audit_delays");
});

after(async () => {
  await db.query(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
  fs.rmdirSync(scratch);
});

async function event(number, state, createdAt = cutoff) {
  await db.query(`INSERT INTO domain_event_outbox
    (id,event_key,event_type,aggregate_type,aggregate_id,payload,occurred_at,available_at,created_at)
    VALUES ($1,$2,'AUDIT_TEST','TEST','test','{}',$3,$3,$3)`, [id(number), `audit:${number}`, createdAt]);
  if (!state) return;
  await db.query(`INSERT INTO audit_receipts_data
    (event_key,domain_event_id,event_type,schema_version,aggregate_type,aggregate_id,
     occurred_at,available_at,receipt_state,digest_version,replay_source_type,replay_source_id,
     envelope_digest,finalized_at)
    VALUES ($1,$2,'AUDIT_TEST',1,'TEST','test',$3,$3,$4::text,1,'TEST','test',
      CASE WHEN $4::text='FINAL' THEN repeat('a',64) END,CASE WHEN $4::text='FINAL' THEN $3::timestamp END)`,
  [`audit:${number}`, id(number), createdAt, state]);
}

async function queue(number, status, createdAt = cutoff, availableAt = cutoff) {
  await db.query(`INSERT INTO audit_recovery_data
    (id,domain_event_id,event_key,reason,status,created_at,available_at)
    VALUES ($1,$1,$2,'AUDIT_TEST',$3,$4,$5)`,
  [id(number), `queue:${number}`, status, createdAt, availableAt]);
}

it("counts cutoff-bounded source states and queue statuses through a read-only CLI", async () => {
  await event(1, "FINAL");
  await event(2, "PROVISIONAL");
  await event(3, null);
  await event(4, "FINAL", "2026-09-02T00:00:00Z");
  await queue(1, "QUEUED", cutoff, "2026-08-30T00:00:00Z");
  await queue(2, "QUEUED", cutoff, "2026-08-29T00:00:00Z");
  await queue(3, "RETRY");
  await queue(4, "PROCESSING");
  await queue(5, "SUCCEEDED");
  await queue(6, "FAILED_TERMINAL");
  await queue(7, "QUEUED", "2026-09-02T00:00:00Z");
  const { code, report, stderr } = await audit([`--cutoff=${cutoff}`]);
  assert.equal(code, 0, stderr);
  assert.equal(report.complete, true);
  assert.equal(report.status, "complete");
  assert.equal(report.readOnly, true);
  assert.equal(report.cutoff, cutoff);
  assert.deepEqual(report.totals, { outboxCount: 3, finalCount: 1, provisionalCount: 1, missingCount: 1 });
  assert.deepEqual(report.eligibleAtCutoff, { count: 2, provisionalCount: 1, missingCount: 1 });
  assert.deepEqual(report.queue.map((row) => [row.status, row.count]), [
    ["FAILED_TERMINAL", 1], ["PROCESSING", 1], ["QUEUED", 2], ["RETRY", 1], ["SUCCEEDED", 1],
  ]);
  assert.equal(report.queue.find((row) => row.status === "QUEUED").oldestAvailableAt, "2026-08-29T00:00:00.000Z");
  assert.equal(report.resume, null);
  assert.equal(report.countsArePartial, false);
  assert.equal(report.pointInTimeSnapshot, false);
  assert.match(report.caveat, /concurrent.*behind.*cursor/i);
  assert.match(report.caveat, /repeat.*census/i);
});

it("resumes tied timestamp source pages and queue pages with cumulative totals and one global page budget", async () => {
  for (let n = 1; n <= 5; n++) await event(n, n === 4 ? "PROVISIONAL" : n === 5 ? null : "FINAL");
  for (let n = 1; n <= 5; n++) await queue(n, "QUEUED", cutoff, `2026-08-${30 - n}T00:00:00Z`);
  let result = await audit([`--cutoff=${cutoff}`, "--limit=2", "--max-pages=1"]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.report.complete, false);
  assert.equal(result.report.countsArePartial, true);
  assert.equal(result.report.reason, "page_limit");
  assert.equal(result.report.totals.outboxCount, 2);
  assert.deepEqual(result.report.source.cursor, { createdAt: cutoff, id: id(2) });
  assert.equal(result.report.queue, null, "unvisited queue is unknown, not an empty census");
  let calls = 1;
  while (!result.report.complete && calls < 10) {
    result = await audit([`--resume=${result.report.resume}`, "--limit=2", "--max-pages=1"]);
    assert.equal(result.report.pagesRead, 1);
    assert.equal(result.report.cutoff, cutoff);
    assert.ok(result.report.source.scanned + result.report.recovery.scanned <= ++calls * 2);
  }
  assert.equal(calls, 6);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.complete, true);
  assert.deepEqual(result.report.totals, { outboxCount: 5, finalCount: 3, provisionalCount: 1, missingCount: 1 });
  assert.deepEqual(result.report.queue, [{ status: "QUEUED", count: 5, oldestAvailableAt: "2026-08-25T00:00:00.000Z" }]);
});

it("bounds queue source rows even when a full page is newer than the cutoff", async () => {
  for (let n = 1; n <= 4; n++) await queue(n, "QUEUED", "2026-09-02T00:00:00Z");
  await queue(5, "RETRY");
  let result = await audit([`--cutoff=${cutoff}`, "--limit=2", "--max-pages=2"]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.report.recovery.scanned, 2);
  assert.equal(result.report.recovery.cursor, id(2));
  assert.equal(result.report.recovery.complete, false);
  assert.deepEqual(result.report.queue, []);
  result = await audit([`--resume=${result.report.resume}`, "--limit=2", "--max-pages=1"]);
  assert.equal(result.code, 2, result.stderr);
  assert.equal(result.report.recovery.scanned, 4);
  assert.deepEqual(result.report.queue, []);
  result = await audit([`--resume=${result.report.resume}`, "--limit=2", "--max-pages=1"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.report.queue, [{ status: "RETRY", count: 1, oldestAvailableAt: cutoff }]);
});

it("keeps a completed source page on statement timeout and retries the uncounted page exactly once", async () => {
  for (let n = 1; n <= 4; n++) await event(n, n < 3 ? "FINAL" : "PROVISIONAL");
  await db.query("INSERT INTO audit_delays VALUES ('receipt',$1)", [id(3)]);
  const result = await audit([`--cutoff=${cutoff}`, "--limit=2", "--statement-timeout-ms=50"]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.report?.complete, false);
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.reason, "query_error");
  assert.equal(result.report.error.code, "57014");
  assert.equal(result.report.pagesRead, 1, "source must be limited before looking up receipts");
  assert.equal(result.report.source.cursor.id, id(2));
  assert.equal(result.report.totals.outboxCount, 2);
  assert.equal(result.report.queue, null);
  await db.query("DELETE FROM audit_delays");
  const resumed = await audit([`--resume=${result.report.resume}`, "--limit=2"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(resumed.report.totals, { outboxCount: 4, finalCount: 2, provisionalCount: 2, missingCount: 0 });
});

it("preserves queue totals and cursor when its next page times out", async () => {
  for (let n = 1; n <= 4; n++) await queue(n, "QUEUED");
  await db.query("INSERT INTO audit_delays VALUES ('queue',$1)", [id(3)]);
  const result = await audit([`--cutoff=${cutoff}`, "--limit=2", "--statement-timeout-ms=50"]);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.report?.error.code, "57014");
  assert.equal(result.report.pagesRead, 2);
  assert.equal(result.report.recovery.cursor, id(2));
  assert.equal(result.report.queue[0].count, 2);
  await db.query("DELETE FROM audit_delays");
  const resumed = await audit([`--resume=${result.report.resume}`, "--limit=2"]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.report.queue[0].count, 4);
});

it("reports unknown evidence on first-page lock timeout and resumes after the lock clears", async () => {
  const locker = new Client({ connectionString: childUrl.toString() });
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query("LOCK TABLE domain_event_outbox IN ACCESS EXCLUSIVE MODE");
  let result;
  try { result = await audit([`--cutoff=${cutoff}`]); }
  finally { await locker.query("ROLLBACK"); await locker.end(); }
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.report?.complete, false);
  assert.equal(result.report.error.code, "55P03");
  assert.equal(result.report.pagesRead, 0);
  assert.equal(result.report.totals, null);
  assert.equal(result.report.eligibleAtCutoff, null);
  assert.equal(result.report.queue, null);
  assert.equal(result.report.source.cursor, null);
  const resumed = await audit([`--resume=${result.report.resume}`]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.report.complete, true);
});

it("freezes the default cutoff across resumes and excludes later inserts", async () => {
  await event(1, "FINAL");
  await event(2, "FINAL");
  const first = await audit(["--limit=1", "--max-pages=1"]);
  assert.equal(first.code, 2, first.stderr);
  assert.ok(Number.isFinite(Date.parse(first.report.cutoff)));
  const newer = new Date(Date.parse(first.report.cutoff) + 1000).toISOString();
  await event(3, "PROVISIONAL", newer);
  await queue(1, "QUEUED", newer);
  const result = await audit([`--resume=${first.report.resume}`]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.report.cutoff, first.report.cutoff);
  assert.equal(result.report.totals.outboxCount, 2);
  assert.deepEqual(result.report.queue, []);
});

it("rejects invalid bounds and changed resume scope instead of silently restarting a census", async () => {
  for (const option of ["--limit=0", "--limit=501", "--limit=1.5", "--max-pages=0", "--max-pages=11",
    "--statement-timeout-ms=0", "--statement-timeout-ms=5001", "--cutoff=garbage", "--resume=garbage", "--db=unknown"]) {
    const result = await audit([option]);
    assert.equal(result.code, 1, option);
    assert.match(result.stderr, /limit|max-pages|statement-timeout|cutoff|resume|target/i, option);
  }
  await event(1, "FINAL");
  const first = await audit([`--cutoff=${cutoff}`, "--limit=1", "--max-pages=1"]);
  assert.equal(first.code, 2, first.stderr);
  for (const scope of ["--cutoff=2026-09-02T00:00:00Z", "--db=prod"]) {
    const result = await audit([`--resume=${first.report.resume}`, scope]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /resume.*(cutoff|target)|(cutoff|target).*resume/i);
  }
});

it("makes concurrent inserts behind both cursors visible on a fresh census", async () => {
  await event(2, "FINAL");
  await queue(2, "SUCCEEDED");
  const first = await audit([`--cutoff=${cutoff}`, "--limit=1", "--max-pages=3"]);
  assert.equal(first.code, 2, first.stderr);
  assert.equal(first.report.source.complete, true);
  assert.equal(first.report.recovery.cursor, id(2));
  await event(1, null);
  await queue(1, "QUEUED");
  const resumed = await audit([`--resume=${first.report.resume}`]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.report.pointInTimeSnapshot, false);
  assert.equal(resumed.report.totals.missingCount, 0);
  assert.equal(resumed.report.queue.length, 1);
  const fresh = await audit([`--cutoff=${cutoff}`]);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.report.totals.missingCount, 1);
  assert.equal(fresh.report.queue.find((row) => row.status === "QUEUED").count, 1);
});

it("distinguishes fresh observation evidence from unverified resumed totals, even on completion", async () => {
  await event(1, "FINAL");
  const first = await audit([`--cutoff=${cutoff}`, "--limit=1", "--max-pages=1"]);
  assert.equal(first.code, 2, first.stderr);
  assert.equal(first.report.totalsProvenance, "observed_in_this_invocation");
  assert.equal(first.report.releaseEvidenceEligible, false);
  const resumed = await audit([`--resume=${first.report.resume}`]);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.report.complete, true);
  assert.equal(resumed.report.totalsProvenance, "imported_unverified");
  assert.equal(resumed.report.releaseEvidenceEligible, false);
  const fresh = await audit([`--cutoff=${cutoff}`]);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.report.totalsProvenance, "observed_in_this_invocation");
  assert.equal(fresh.report.releaseEvidenceEligible, true);
  assert.equal(fresh.report.pointInTimeSnapshot, false);
});

it("never promotes internally consistent forged counts or completion claims to release evidence", async () => {
  await event(1, "PROVISIONAL");
  await event(2, "FINAL");
  const first = await audit([`--cutoff=${cutoff}`, "--limit=2", "--max-pages=1"]);
  assert.equal(first.code, 2, first.stderr);
  for (const forgeCompletion of [false, true]) {
    const state = JSON.parse(Buffer.from(first.report.resume, "base64url").toString("utf8"));
    state.totals = { outboxCount: 2, finalCount: 2, provisionalCount: 0, missingCount: 0 };
    // Neither count consistency nor a caller-supplied provenance claim proves
    // these imported numbers were ever observed by the audit.
    state.totalsProvenance = "observed_in_this_invocation";
    state.releaseEvidenceEligible = true;
    if (forgeCompletion) {
      state.source.complete = true;
      state.recovery.complete = true;
      state.queue = [];
    }
    const token = Buffer.from(JSON.stringify(state)).toString("base64url");
    const result = await audit([`--resume=${token}`]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.complete, true);
    assert.equal(result.report.eligibleAtCutoff.count, 0);
    assert.equal(result.report.pagesRead, forgeCompletion ? 0 : 2);
    assert.equal(result.report.totalsProvenance, "imported_unverified");
    assert.equal(result.report.releaseEvidenceEligible, false);
    assert.match(result.report.caveat, /resumed.*unverified.*ineligible.*release evidence/i);
  }
  const fresh = await audit([`--cutoff=${cutoff}`]);
  assert.equal(fresh.report.eligibleAtCutoff.count, 1);
});

it("explains imported provenance and scan-only completion in actual CLI help", async () => {
  const result = await audit(["--help"], { raw: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /resumed.*unverified.*ineligible.*release evidence/i);
  assert.match(result.stdout, /complete means only that both scans exhausted/i);
  assert.match(result.stdout, /fresh.*complete.*eligible.*observation/i);
});

it("preserves remote TLS configuration after pg parses sslmode URLs and keeps local search_path", () => {
  // A remote TLS handshake is intentionally unreachable in this local-only
  // suite. Inspect the real driver's parsed client config without connecting.
  const { databaseClientConfig } = require("../../scripts/audit-domain-event-receipts.js");
  const remote = databaseClientConfig("postgresql://audit@example.invalid/audit_test?sslmode=require&application_name=audit");
  const remoteClient = new Client(remote);
  assert.equal(new URL(remote.connectionString).searchParams.has("sslmode"), false);
  assert.equal(remoteClient.connectionParameters.application_name, "audit");
  assert.deepEqual(remoteClient.connectionParameters.ssl, { rejectUnauthorized: false });
  const localUrl = new URL(target);
  localUrl.searchParams.set("sslmode", "require");
  localUrl.searchParams.set("options", `-c search_path=${schema} -c timezone=UTC`);
  const local = databaseClientConfig(localUrl.toString());
  const localClient = new Client(local);
  assert.equal(new URL(local.connectionString).searchParams.has("sslmode"), false);
  assert.equal(localClient.connectionParameters.ssl, false);
  assert.equal(localClient.connectionParameters.options, localUrl.searchParams.get("options"));
});
