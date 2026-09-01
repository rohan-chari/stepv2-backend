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
  const batch = createClientFeaturesWriteBatch();

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
});
