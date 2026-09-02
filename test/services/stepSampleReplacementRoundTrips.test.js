const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findRowsForUserRangesOn,
  replaceSamplesOn,
} = require("../../src/modules/steps/models/stepSample");

test("bounded user-range lookup exposes the real cohort ceiling to PostgreSQL", async () => {
  const calls = [];
  const client = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [];
    },
  };

  await findRowsForUserRangesOn(client, [{
    userId: "user-1",
    rangeStart: "2026-09-01T08:00:00.000Z",
    rangeEnd: "2026-09-01T09:00:00.000Z",
    ordinal: 0,
  }]);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WITH requested AS MATERIALIZED/);
  assert.match(
    calls[0].sql,
    /FROM jsonb_to_recordset\([\s\S]*?\)[\s\S]*?LIMIT 25\s*\)/,
    "the bound must sit inside the requested CTE so the planner estimates at most 25 rows",
  );
});

test("bounded user-range lookup rejects a cohort larger than its SQL planner ceiling", async () => {
  const bound = {
    userId: "user-1",
    rangeStart: "2026-09-01T08:00:00.000Z",
    rangeEnd: "2026-09-01T09:00:00.000Z",
  };
  await assert.rejects(
    findRowsForUserRangesOn(
      { async $queryRawUnsafe() { throw new Error("query must not run"); } },
      Array.from({ length: 26 }, (_, ordinal) => ({ ...bound, ordinal })),
    ),
    /at most 25 bounds/,
  );
});

test("overlap deletion and sample persistence share one database round trip", async () => {
  const calls = [];
  const client = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 1;
    },
  };
  const samples = [{
    periodStart: "2026-09-01T08:00:00.000Z",
    periodEnd: "2026-09-01T09:00:00.000Z",
    steps: 123,
    recordingMethod: "automatic",
  }];

  await replaceSamplesOn(client, "user-1", samples);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM step_samples/);
  assert.match(calls[0].sql, /INSERT INTO step_samples/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id, period_start\) DO UPDATE/);
});
