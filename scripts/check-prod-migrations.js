// READ-ONLY: confirm prod has every migration applied (and none failed/rolled back)
// so we can safely skip the advisory-lock-hung `migrate deploy`.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
const url = env
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, ""); // strip sslmode so pg honors our ssl override below

// count migration dirs in the repo
const migDir = path.join(__dirname, "..", "prisma", "migrations");
const repoMigs = fs
  .readdirSync(migDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

(async () => {
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const { rows } = await client.query(
    `SELECT migration_name, finished_at, rolled_back_at
       FROM "_prisma_migrations" ORDER BY started_at`
  );
  const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at);
  const unfinished = rows.filter((r) => !r.finished_at || r.rolled_back_at);
  const appliedNames = new Set(applied.map((r) => r.migration_name));
  const missing = repoMigs.filter((m) => !appliedNames.has(m));

  console.log(`repo migrations:        ${repoMigs.length}`);
  console.log(`prod rows:              ${rows.length}`);
  console.log(`cleanly applied:        ${applied.length}`);
  console.log(`unfinished/rolledback:  ${unfinished.length}`);
  if (unfinished.length) console.log("  ->", unfinished.map((r) => r.migration_name));
  console.log(`in repo but NOT applied to prod: ${missing.length}`);
  if (missing.length) console.log("  ->", missing);
  console.log("last 6 applied on prod:");
  applied.slice(-6).forEach((r) => console.log(`  ${r.migration_name}  @ ${r.finished_at.toISOString()}`));
  console.log(
    missing.length === 0 && unfinished.length === 0
      ? "\nVERDICT: prod is fully migrated -> `migrate deploy` is a no-op, safe to skip."
      : "\nVERDICT: prod is MISSING migrations -> do NOT skip migrate; must resolve first."
  );
  await client.end();
})().catch((e) => {
  console.error("CHECK FAILED:", e.message);
  process.exit(1);
});
