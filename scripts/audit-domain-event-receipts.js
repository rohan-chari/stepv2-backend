#!/usr/bin/env node
// Read-only, bounded observation; independent pages are NOT a snapshot.
// Start: npm run domain-events:receipts:audit -- --db=local --cutoff=2026-09-01T00:00:00Z
// Resume: npm run domain-events:receipts:audit -- --resume=<report.resume>
// A fresh repeat census must start WITHOUT --resume. No DB checkpoint is written.

const { createHash } = require("node:crypto");
const { Client } = require("pg");
const DB_ALIASES = { local: "DATABASE_URL", staging: "STAGING_DATABASE_URL", prod: "PROD_DATABASE_URL" };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CAVEAT = "Independent read-only pages are not a transactional point-in-time census. " +
  "Concurrent inserts behind a cursor (including late commits) can be missed; deletes and receipt/queue " +
  "state changes between pages can change the observed totals. The cutoff stays frozen on resume. " +
  "Partial zero counts are never full clean evidence. Even complete means only that both scans exhausted; " +
  "run a fresh repeat census without --resume before treating zero counts as clean evidence. " +
  "Resumed/imported totals are unverified and ineligible for release evidence even when scans complete. " +
  "Only fresh non-resumed complete runs are eligible observations, subject to these snapshot caveats; " +
  "eligibility is not release approval.";

function databaseClientConfig(url) {
  const parsed = new URL(url);
  // Match src/db: prevent pg's sslmode parser from overriding remote TLS.
  // URLSearchParams preserves other options, including local test search_path.
  parsed.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  return { connectionString: parsed.toString(), connectionTimeoutMillis: 5000,
    ...(local ? {} : { ssl: { rejectUnauthorized: false } }) };
}

function isoDate(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid cutoff/cursor date");
  return new Date(value).toISOString();
}

function parseArgs(argv) {
  const result = { db: null, cutoff: null, limit: 500, maxPages: 10, statementTimeoutMs: 5000, resume: null };
  for (const arg of argv) {
    if (arg.startsWith("--db=")) result.db = arg.slice(5);
    else if (arg.startsWith("--cutoff=")) result.cutoff = isoDate(arg.slice(9));
    else if (arg.startsWith("--limit=")) result.limit = Number(arg.slice(8));
    else if (arg.startsWith("--max-pages=")) result.maxPages = Number(arg.slice(12));
    else if (arg.startsWith("--statement-timeout-ms=")) result.statementTimeoutMs = Number(arg.slice(23));
    else if (arg.startsWith("--resume=")) result.resume = arg.slice(9);
    else if (arg === "--help") result.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  for (const [name, value, maximum] of [
    ["limit", result.limit, 500], ["max-pages", result.maxPages, 10],
    ["statement-timeout-ms", result.statementTimeoutMs, 5000],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`--${name} must be an integer from 1 through ${maximum}`);
    }
  }
  if (result.db !== null && !Object.hasOwn(DB_ALIASES, result.db)) throw new Error("Unknown --db target");
  if (result.resume === "") throw new Error("--resume must contain the previous report's token");
  return result;
}

function resumeState(token) {
  try {
    if (token.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const state = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    if (state.version !== 1 || !Object.hasOwn(DB_ALIASES, state.target) ||
        !/^[a-f0-9]{64}$/.test(state.database) || isoDate(state.cutoff) !== state.cutoff) throw new Error();
    for (const scan of [state.source, state.recovery]) {
      if (!scan || typeof scan.complete !== "boolean" || !count(scan.scanned) ||
          (scan.scanned === 0) !== (scan.cursor === null)) throw new Error();
    }
    if (state.source.cursor && (!UUID.test(state.source.cursor.id) ||
        isoDate(state.source.cursor.createdAt) !== state.source.cursor.createdAt ||
        state.source.cursor.createdAt > state.cutoff)) throw new Error();
    if (state.recovery.cursor !== null && !UUID.test(state.recovery.cursor)) throw new Error();
    if (state.totals === null) {
      if (state.source.scanned !== 0 || state.source.complete) throw new Error();
    } else {
      const { outboxCount, finalCount, provisionalCount, missingCount } = state.totals;
      if (![outboxCount, finalCount, provisionalCount, missingCount].every(count) ||
          outboxCount !== state.source.scanned || outboxCount !== finalCount + provisionalCount + missingCount) throw new Error();
    }
    if (state.queue === null) {
      if (state.recovery.scanned !== 0 || state.recovery.complete) throw new Error();
    } else if (!Array.isArray(state.queue) || !state.source.complete || state.queue.length > 32 ||
        new Set(state.queue.map((row) => row.status)).size !== state.queue.length ||
        state.queue.some((row) => !/^[A-Z_]{1,32}$/.test(row.status) || !count(row.count) || row.count === 0 ||
          isoDate(row.oldestAvailableAt) !== row.oldestAvailableAt) ||
        state.queue.reduce((sum, row) => sum + row.count, 0) > state.recovery.scanned) throw new Error();
    return state;
  } catch {
    throw new Error("Invalid --resume token; use the previous report's complete token");
  }
}

async function readPage(client, state, options, source) {
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`SET LOCAL statement_timeout='${options.statementTimeoutMs}ms'`);
    await client.query("SET LOCAL lock_timeout='250ms'");
    // LIMIT precedes receipt lookups. LATERAL LIMIT prevents a population-wide
    // receipt hash join; the existing unique domain_event_id index bounds probes.
    const cursor = state.source.cursor;
    const result = source ? await client.query(`
      WITH source_page AS MATERIALIZED (
        SELECT id,created_at FROM domain_event_outbox
         WHERE created_at <= $1::timestamp
           ${cursor ? "AND (created_at,id) > ($3::timestamp,$4::uuid)" : ""}
         ORDER BY created_at,id LIMIT $2
      )
      SELECT event.id,to_char(event.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
             receipt.receipt_state AS "receiptState"
        FROM source_page event
        LEFT JOIN LATERAL (
          SELECT receipt_state FROM domain_event_receipts WHERE domain_event_id=event.id LIMIT 1
        ) receipt ON true
       ORDER BY event.created_at,event.id`,
    [state.cutoff, options.limit, ...(cursor ? [cursor.createdAt, cursor.id] : [])]) : await client.query(`
      WITH source_page AS MATERIALIZED (
        SELECT id,created_at,status,available_at FROM domain_event_receipt_recovery
         ${state.recovery.cursor ? "WHERE id > $3::uuid" : ""}
         ORDER BY id LIMIT $2
      )
      SELECT id,status,created_at <= $1::timestamp AS eligible,
             to_char(available_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "availableAt"
        FROM source_page ORDER BY id`,
    [state.cutoff, options.limit, ...(state.recovery.cursor ? [state.recovery.cursor] : [])]);
    // Recovery has no (created_at,id) index. Limit its PK source page BEFORE
    // applying cutoff, and advance over ineligible rows too, including full pages.
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("Receipt audit: --db=local|staging|prod --cutoff=<ISO date> (default: now, frozen)\n" +
      "--limit=1..500 (500) --max-pages=1..10 (10, shared across source and queue)\n" +
      "--statement-timeout-ms=1..5000 (5000) --resume=<previous report.resume>\n" +
      "Totals include only created_at <= cutoff. Unknown evidence is null.\n" +
      "Exit codes: 0 complete observation, 2 incomplete/page budget, 1 error (progress retained).\n" + CAVEAT);
    return;
  }
  const state = options.resume ? resumeState(options.resume) : {
    version: 1, target: options.db || "local", cutoff: options.cutoff || new Date().toISOString(),
    source: { cursor: null, scanned: 0, complete: false },
    recovery: { cursor: null, scanned: 0, complete: false }, totals: null, queue: null,
  };
  if ((options.db && options.db !== state.target) || (options.cutoff && options.cutoff !== state.cutoff)) {
    throw new Error("--resume target/cutoff cannot be changed; start a fresh census instead");
  }
  if (process.env.NODE_ENV !== "test") require("dotenv").config({ quiet: true });
  const url = process.env[DB_ALIASES[state.target]];
  if (!url) throw new Error(`${DB_ALIASES[state.target]} is required`);
  const parsed = new URL(url);
  // Bind progress to a DB identity without including credentials in evidence.
  const database = createHash("sha256").update(JSON.stringify([
    parsed.hostname, parsed.port || "5432", parsed.pathname, parsed.searchParams.get("options"),
  ])).digest("hex");
  if (state.database && state.database !== database) throw new Error("--resume database target has changed");
  state.database = database;
  const client = new Client(databaseClientConfig(url));
  let pagesRead = 0;
  let error = null;
  try {
    await client.connect();
    for (let page = 0; page < options.maxPages && !(state.source.complete && state.recovery.complete); page++) {
      const source = !state.source.complete;
      const rows = await readPage(client, state, options, source);
      // Publish progress only after the entire read-only page committed. A
      // failed query leaves the previous cursor and cumulative totals intact.
      if (source) {
        state.totals ||= { outboxCount: 0, finalCount: 0, provisionalCount: 0, missingCount: 0 };
        for (const row of rows) {
          state.totals.outboxCount++;
          if (row.receiptState === "FINAL") state.totals.finalCount++;
          else if (row.receiptState === "PROVISIONAL") state.totals.provisionalCount++;
          else state.totals.missingCount++;
        }
        if (rows.length) state.source.cursor = { createdAt: rows.at(-1).createdAt, id: rows.at(-1).id };
      } else {
        state.queue ||= [];
        for (const row of rows) {
          if (!row.eligible) continue;
          let entry = state.queue.find((item) => item.status === row.status);
          if (!entry) state.queue.push(entry = { status: row.status, count: 0, oldestAvailableAt: row.availableAt });
          entry.count++;
          if (row.availableAt < entry.oldestAvailableAt) entry.oldestAvailableAt = row.availableAt;
        }
        state.queue.sort((a, b) => a.status.localeCompare(b.status));
        if (rows.length) state.recovery.cursor = rows.at(-1).id;
      }
      const scan = source ? state.source : state.recovery;
      scan.scanned += rows.length;
      scan.complete = rows.length < options.limit;
      pagesRead++;
    }
  } catch (failure) {
    error = { code: failure.code || "AUDIT_QUERY_FAILED", message: failure.message };
  } finally {
    await client.end();
  }
  const complete = !error && state.source.complete && state.recovery.complete;
  const report = {
    readOnly: true, target: state.target, cutoff: state.cutoff,
    scope: "created_at <= cutoff", pointInTimeSnapshot: false, caveat: CAVEAT,
    status: complete ? "complete" : "incomplete", complete, countsArePartial: !complete,
    // Derive provenance from this invocation, never from caller-supplied state.
    totalsProvenance: options.resume ? "imported_unverified" : "observed_in_this_invocation",
    releaseEvidenceEligible: complete && !options.resume,
    reason: error ? "query_error" : complete ? null : "page_limit", error,
    limit: options.limit, maxPages: options.maxPages, pagesRead,
    source: state.source, recovery: state.recovery, totals: state.totals, queue: state.queue,
    eligibleAtCutoff: state.totals ? { count: state.totals.provisionalCount + state.totals.missingCount,
      provisionalCount: state.totals.provisionalCount, missingCount: state.totals.missingCount } : null,
    resume: complete ? null : Buffer.from(JSON.stringify(state)).toString("base64url"),
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  main().then((report) => { process.exitCode = !report || report.complete ? 0 : report.error ? 1 : 2; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main, parseArgs, databaseClientConfig };
