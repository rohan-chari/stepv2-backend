const assert = require("node:assert/strict");
const test = require("node:test");
const { buildHistoricalRaceReconciliationIntentModel } = require("../../src/modules/races/models/historicalRaceReconciliationIntent");

test("admission deduplicates race/user work and uses one merge statement", async () => {
  const queries = [];
  const model = buildHistoricalRaceReconciliationIntentModel({});
  const tx = { $queryRawUnsafe: async (...args) => { queries.push(args); return [{ created: 1, coalesced: 1 }]; } };
  const result = await model.admitMany({ rows: [{ raceId: "r1", userId: "u1" }, { raceId: "r1", userId: "u1" }, { raceId: "r1", userId: "u2" }], changedStart: new Date(), changedEnd: new Date(Date.now() + 60000), sourceGeneration: 103 }, tx);
  assert.deepEqual(result, { created: 1, coalesced: 1 });
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /ON CONFLICT \(race_id,user_id\) DO UPDATE/);
});

test("claim query is capped and uses SKIP LOCKED", async () => {
  const prisma = { $transaction: async (fn) => fn({ $queryRawUnsafe: async (...args) => { assert.match(args[0], /FOR UPDATE SKIP LOCKED/); assert.equal(args[2], 100); return []; } }) };
  const model = buildHistoricalRaceReconciliationIntentModel(prisma);
  await model.claimBatch({ limit: 1000 });
});
