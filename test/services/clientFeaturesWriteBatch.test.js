const test = require("node:test");
const assert = require("node:assert/strict");

const {
  UPDATE_SQL,
  createClientFeaturesWriteBatch,
} = require("../../src/modules/users/services/clientFeaturesWriteBatch");

test("simultaneous client-capability stamps use one set-based update", async () => {
  const calls = [];
  const prisma = { async $queryRawUnsafe(sql, payload) {
    calls.push({ sql, payload: JSON.parse(payload) });
    return [];
  } };
  const batch = createClientFeaturesWriteBatch({ drainDelayMs: 0 });

  await Promise.all(Array.from({ length: 100 }, (_, index) => batch.write({
    prisma,
    id: `user-${index}`,
    features: ["races_v2", "team_races"],
  })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, UPDATE_SQL);
  assert.equal(calls[0].payload.length, 100);
  assert.deepEqual(calls[0].payload[0], {
    requestIndex: 0,
    id: "user-0",
    features: ["races_v2", "team_races"],
  });
  assert.match(UPDATE_SQL, /client_features_at = clock_timestamp\(\)/);
  assert.match(UPDATE_SQL, /unnest\(existing\.client_features \|\| input\.features\)/);
  assert.match(UPDATE_SQL, /NOT existing\.client_features @> input\.features/);
  assert.match(UPDATE_SQL, /array_agg\(DISTINCT feature ORDER BY feature\)/);
});

test("divergent requests in one worker are unioned before the update", async () => {
  let sql;
  const prisma = { async $queryRawUnsafe(query) { sql = query; } };
  const batch = createClientFeaturesWriteBatch({ drainDelayMs: 20 });
  await Promise.all([
    batch.write({ prisma, id: "user-1", features: ["a"] }),
    batch.write({ prisma, id: "user-1", features: ["b"] }),
  ]);
  assert.match(sql, /array_agg\(DISTINCT feature ORDER BY feature\)/);
  assert.match(sql, /GROUP BY input_rows\.id/);
});

test("divergent workers use an atomic sticky union instead of replacement", async () => {
  const payloads = [];
  const prisma = { async $queryRawUnsafe(sql, payload) {
    payloads.push(JSON.parse(payload));
    assert.match(sql, /unnest\(existing\.client_features \|\| input\.features\)/);
  } };
  await Promise.all([
    createClientFeaturesWriteBatch({ drainDelayMs: 0 })
      .write({ prisma, id: "user-1", features: ["a"] }),
    createClientFeaturesWriteBatch({ drainDelayMs: 0 })
      .write({ prisma, id: "user-1", features: ["b"] }),
  ]);
  assert.deepEqual(payloads.map((rows) => rows[0].features).sort(), [["a"], ["b"]]);
});
