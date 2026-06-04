// READ-ONLY: who holds prod's advisory locks (the migrate lock is objid 72707369)
const fs = require("fs");
const { Client } = require("pg");
const url = fs
  .readFileSync(__dirname + "/../.env", "utf8")
  .match(/^PROD_DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^"|"$/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const { rows } = await c.query(`
    SELECT l.pid, l.granted, l.objid,
           a.state, a.application_name,
           date_trunc('second', now() - a.state_change) AS idle_for,
           left(coalesce(a.query, '(none)'), 70) AS last_query
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory'
     ORDER BY l.granted DESC`);
  if (!rows.length) {
    console.log("No advisory locks held right now — the hung migrate released its attempt on timeout.");
  } else {
    rows.forEach((r) =>
      console.log(
        `pid=${r.pid} granted=${r.granted} objid=${r.objid} state=${r.state} app=${r.application_name} idle_for=${r.idle_for} q="${r.last_query}"`
      )
    );
  }
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
