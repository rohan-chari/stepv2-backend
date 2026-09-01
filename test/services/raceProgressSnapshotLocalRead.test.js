const assert = require("node:assert/strict");
const test = require("node:test");

const redisCache = require("../../src/shared/cache/redisCache");
const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");

test("a surge cannot physically evict the stale-while-refresh baseline within five minutes", () => {
  assert.ok(snapshotStore.PHYSICAL_TTL_SECONDS >= 300);
  assert.ok(snapshotStore.SOFT_TTL_MS < snapshotStore.PHYSICAL_TTL_SECONDS * 1000);
});

test("concurrent shared-snapshot reads collapse to one Redis GET and reuse the parsed object briefly", async () => {
  const original = redisCache.getJSON;
  let reads = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  try {
    snapshotStore.__resetLocalReadCache();
    redisCache.getJSON = async () => {
      reads += 1;
      await blocked;
      return {
        v: snapshotStore.LEAN_SCHEMA_VERSION,
        asOf: new Date().toISOString(),
        scoringTimeZone: "America/New_York",
        participants: [],
      };
    };
    const first = snapshotStore.readSnapshot(
      "race-1", snapshotStore.LEAN_SCHEMA_VERSION);
    const second = snapshotStore.readSnapshot(
      "race-1", snapshotStore.LEAN_SCHEMA_VERSION);
    release();
    assert.equal(await first, await second);
    assert.equal((await snapshotStore.readSnapshot(
      "race-1", snapshotStore.LEAN_SCHEMA_VERSION)).v,
      snapshotStore.LEAN_SCHEMA_VERSION);
    assert.equal(reads, 1);
  } finally {
    redisCache.getJSON = original;
    snapshotStore.__resetLocalReadCache();
  }
});
