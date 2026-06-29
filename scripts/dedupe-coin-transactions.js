// Pre-migration cleanup for the CoinTransaction @@unique([userId,reason,refId]).
//
// The unique index cannot be added while duplicate (user_id, reason, ref_id)
// rows exist (the historical index was NON-unique, and awardCoins' findFirst-
// then-create could double-insert under concurrency). This script finds — and,
// with --fix, removes — those duplicates, keeping the EARLIEST row per group
// (lowest created_at, ties broken by id) so the surviving ledger row is the
// original grant. Rows with ref_id IS NULL are ignored: NULLs never collide in
// a Postgres unique index, so they can't block the migration.
//
// Usage:
//   node scripts/dedupe-coin-transactions.js                 # DRY RUN on local
//   node scripts/dedupe-coin-transactions.js --db=staging    # DRY RUN on staging
//   node scripts/dedupe-coin-transactions.js --db=prod       # DRY RUN on prod (read-only)
//   node scripts/dedupe-coin-transactions.js --db=prod --fix # delete dupes on prod
//
// Default is DRY RUN (read-only): it reports how many groups/rows would be
// removed and shows samples. Nothing is deleted unless --fix is passed.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const dbArg = (args.find((a) => a.startsWith("--db=")) || "--db=local").slice(5);

const ENV_KEY = {
  local: "DATABASE_URL",
  staging: "STAGING_DATABASE_URL",
  prod: "PROD_DATABASE_URL",
}[dbArg];

if (!ENV_KEY) {
  console.error(`Unknown --db=${dbArg} (use local | staging | prod)`);
  process.exit(1);
}

function readEnvUrl(key) {
  const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const m = env.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!m) throw new Error(`${key} not found in .env`);
  return m[1].trim().replace(/^"|"$/g, "");
}

(async () => {
  const url = readEnvUrl(ENV_KEY);
  const needsSsl = /ondigitalocean|sslmode=require/.test(url);
  const client = new Client({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, ""),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  console.log(`\n[${dbArg}] ${fix ? "FIX" : "DRY RUN"} — duplicate coin_transactions on (user_id, reason, ref_id)\n`);

  // Groups of non-null (user_id, reason, ref_id) with more than one row.
  const groups = await client.query(`
    SELECT user_id, reason, ref_id, COUNT(*) AS n
    FROM coin_transactions
    WHERE ref_id IS NOT NULL
    GROUP BY user_id, reason, ref_id
    HAVING COUNT(*) > 1
    ORDER BY n DESC
  `);

  if (groups.rows.length === 0) {
    console.log("✔ No duplicates. The @@unique migration will apply cleanly.\n");
    await client.end();
    return;
  }

  const dupeRows = groups.rows.reduce((sum, r) => sum + (Number(r.n) - 1), 0);
  console.log(`Found ${groups.rows.length} duplicated key(s), ${dupeRows} row(s) to remove.`);
  console.log("Samples (up to 10):");
  for (const r of groups.rows.slice(0, 10)) {
    console.log(`  user=${r.user_id} reason=${r.reason} refId=${r.ref_id} count=${r.n}`);
  }

  if (!fix) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --fix to remove ${dupeRows} duplicate row(s).\n`);
    await client.end();
    return;
  }

  // Delete every row in each group except the earliest (created_at, then id).
  // Wrapped in a transaction so it's all-or-nothing.
  await client.query("BEGIN");
  const del = await client.query(`
    DELETE FROM coin_transactions c
    USING (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY user_id, reason, ref_id
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM coin_transactions
      WHERE ref_id IS NOT NULL
    ) ranked
    WHERE c.id = ranked.id AND ranked.rn > 1
  `);
  await client.query("COMMIT");
  console.log(`\n✔ Deleted ${del.rowCount} duplicate row(s). The @@unique migration can now apply.\n`);

  await client.end();
})().catch((err) => {
  console.error("dedupe-coin-transactions failed:", err.message || err);
  process.exit(1);
});
