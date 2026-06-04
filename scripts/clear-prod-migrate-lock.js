#!/usr/bin/env node
/**
 * Clear a STALE Prisma migrate advisory lock (objid 72707369) on prod that a
 * pooler-kept idle session is holding, blocking `prisma migrate deploy` (P1002).
 * Guarded: only terminates backends that hold objid 72707369 AND are idle
 * (never an actively-running migration). DRY by default; --apply to terminate.
 */
const fs = require("fs");
const { Client } = require("pg");
const APPLY = process.argv.includes("--apply");
const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log(`Mode: ${APPLY ? "APPLY (will terminate)" : "DRY RUN"}\n`);
  const { rows } = await c.query(`
    SELECT l.pid, a.state, a.application_name,
           date_trunc('second', now()-a.state_change) AS idle_for,
           left(coalesce(a.query,'(none)'),60) AS last_query
      FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid=l.pid
     WHERE l.locktype='advisory' AND l.objid=72707369 AND l.granted=true`);
  if (!rows.length) {
    console.log("No holder of advisory lock 72707369 — already clear.");
    await c.end();
    return;
  }
  const killable = rows.filter((r) => r.state === "idle" || r.state === "idle in transaction");
  rows.forEach((r) =>
    console.log(`  pid=${r.pid} state=${r.state} idle_for=${r.idle_for} q="${r.last_query}" -> ${killable.includes(r) ? "WILL TERMINATE" : "SKIP (not idle)"}`)
  );
  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to terminate the idle holder(s).");
    await c.end();
    return;
  }
  for (const r of killable) {
    const { rows: res } = await c.query(`SELECT pg_terminate_backend($1) AS ok`, [r.pid]);
    console.log(`  terminated pid=${r.pid}: ${res[0].ok}`);
  }
  // confirm released
  const { rows: after } = await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=72707369 AND granted=true`);
  console.log(`\nAdvisory lock 72707369 holders remaining: ${after[0].n}`);
  await c.end();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
