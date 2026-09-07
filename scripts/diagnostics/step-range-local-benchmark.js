// Isolated synthetic SQL experiment. Never connects to production.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const source = fs.readFileSync(
  path.join(__dirname, "../../src/modules/steps/models/stepSample.js"),
  "utf8",
);
const sql = source.match(/`(WITH requested AS MATERIALIZED[\s\S]*?)`,/)[1];
const db = new Client({ connectionString: target.toString() });
(async () => {
  await db.connect();
  // A connection-local temporary table shadows the real table. No application
  // fixtures are modified. It and its indexes disappear when the connection ends.
  await db.query(`CREATE TEMP TABLE step_samples AS
    SELECT md5(u::text || ':' || n::text) AS id, 'user-' || u AS user_id,
      timestamp '2026-08-11' + n * interval '50 minutes' AS period_start,
      timestamp '2026-08-11' + (n+1) * interval '50 minutes' AS period_end,
      (n % 100)::integer AS steps, repeat('x',100) AS payload
    FROM generate_series(1,1000) u CROSS JOIN generate_series(0,799) n`);
  await db.query(`CREATE UNIQUE INDEX ON step_samples(id)`);
  await db.query(`CREATE UNIQUE INDEX ON step_samples(user_id,period_start)`);
  await db.query(
    `CREATE INDEX ON step_samples(user_id,period_start,period_end)`,
  );
  await db.query(`CREATE INDEX ON step_samples(user_id,period_end)`);
  await db.query(`ANALYZE step_samples`);
  for (const users of [1, 5, 25]) {
    for (const days of [0, 1, 7, 28]) {
      const end = new Date("2026-09-08T00:00:00Z");
      const bounds = Array.from({ length: users }, (_, ordinal) => ({
        user_id: `user-${ordinal + 1}`,
        ordinal,
        range_start: new Date(+end - days * 86400000).toISOString(),
        range_end: end.toISOString(),
      }));
      const runs = [];
      for (let i = 0; i < 4; i++) {
        const result = await db.query(
          "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) " + sql,
          [JSON.stringify(bounds), null, null, null, 50000],
        );
        const plan = result.rows[0]["QUERY PLAN"][0];
        if (i)
          runs.push({
            ms: plan["Execution Time"],
            rows: plan.Plan["Actual Rows"],
            hits: plan.Plan["Local Hit Blocks"],
            reads: plan.Plan["Local Read Blocks"],
            tempWritten: plan.Plan["Temp Written Blocks"],
          });
      }
      console.log(JSON.stringify({ users, days, runs }));
    }
  }
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
