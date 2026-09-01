const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRacePresentationBulkRead,
} = require("../../src/modules/races/services/racePresentationBulkRead");

test("large concurrent roster reads share one direct database load and do not fill per-user Redis keys", async () => {
  let directLoads = 0;
  let cacheLoads = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const service = buildRacePresentationBulkRead({
    presentationCache: {
      async getMany() { cacheLoads += 1; return new Map(); },
      async loadMany(ids) {
        directLoads += 1;
        await blocked;
        return new Map(ids.map((id) => [id, { id }]));
      },
    },
    bulkThreshold: 3,
    ttlMs: 30_000,
  });
  const ids = ["u1", "u2", "u3"];
  const first = service.getMany("race-1", ids, true);
  const second = service.getMany("race-1", ["u3", "u1", "u2"], true);
  release();
  assert.equal((await first).size, 3);
  assert.equal((await second).size, 3);
  assert.equal(directLoads, 1);
  assert.equal(cacheLoads, 0);
});

test("small reads retain the ordinary guarded presentation cache and roster changes cannot reuse a bulk entry", async () => {
  let directLoads = 0;
  let cacheLoads = 0;
  const service = buildRacePresentationBulkRead({
    presentationCache: {
      async getMany(ids) {
        cacheLoads += 1;
        return new Map(ids.map((id) => [id, { id }]));
      },
      async loadMany(ids) {
        directLoads += 1;
        return new Map(ids.map((id) => [id, { id }]));
      },
    },
    bulkThreshold: 3,
    ttlMs: 30_000,
  });
  await service.getMany("race-1", ["u1"], true);
  await service.getMany("race-1", ["u1", "u2", "u3"], true);
  await service.getMany("race-1", ["u1", "u2", "u4"], true);
  assert.equal(cacheLoads, 1);
  assert.equal(directLoads, 2);
});
