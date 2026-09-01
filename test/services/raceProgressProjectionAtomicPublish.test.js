const assert = require("node:assert/strict");
const test = require("node:test");

const redisCache = require("../../src/shared/cache/redisCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const {
  buildRaceProgressPageProjection,
  publishRaceProgressPageProjection,
} = require("../../src/modules/races/services/raceProgressPageProjection");

test("a refresh fills the inactive bounded bank, flips the index, then deletes the old bank", async () => {
  const originals = {
    isEnabled: redisCache.isEnabled,
    getJSON: redisCache.getJSON,
    setManyJSON: redisCache.setManyJSON,
    evalLua: redisCache.evalLua,
    del: redisCache.del,
    withLock: redisCache.withLock,
  };
  const calls = [];
  try {
    redisCache.isEnabled = () => true;
    redisCache.getJSON = async () => ({
      v: 2, generation: 1, raceId: "race-1", chunkCount: 1,
      requesterBucketCount: 256, slotBank: 1,
    });
    redisCache.del = async (keys) => {
      calls.push({ op: "delete", keys });
      return true;
    };
    redisCache.setManyJSON = async (entries) => {
      calls.push({ op: "write", entries });
      return { ok: true, disabled: false, count: entries.length };
    };
    redisCache.evalLua = async (_script, keys) => {
      calls.push({ op: "flip", keys });
      return { ok: true, disabled: false, result: 1 };
    };
    redisCache.withLock = async (_key, _ttlMs, work) => work();

    const snapshot = buildRaceProgressPageProjection({
      raceId: "race-1",
      generation: 2,
      scoringTimeZone: "America/New_York",
      asOf: new Date("2026-08-31T16:00:00.000Z"),
      participants: Array.from({ length: 1000 }, (_, index) => ({
        participantId: `p${index}`,
        userId: `u${index}`,
        totalSteps: 1000 - index,
      })),
    });
    assert.equal(await publishRaceProgressPageProjection({
      raceId: "race-1", generation: 2, snapshot,
    }), true);
    const flipAt = calls.findIndex(({ op }) => op === "flip");
    assert.ok(flipAt > 1, "large projections must use bounded write batches");
    assert.ok(calls.slice(0, flipAt).every(({ op }) => op === "write"));
    assert.equal(calls.at(-1).op, "delete");
    const keys = calls.slice(0, flipAt).flatMap(({ entries }) =>
      entries.map(({ key }) => key));
    assert.ok(keys.includes(cacheKeys.raceProgressPageBankSlot("race-1", 0, 0)));
    assert.ok(keys.some((key) => key.includes("participant:race-1:bank:0:bucket:")));
    assert.deepEqual(calls[flipAt].keys, [cacheKeys.raceProgressIndex("race-1")]);
    assert.equal(calls.at(-1).keys.includes(
      cacheKeys.raceProgressPageBankSlot("race-1", 1, 0)), true);
  } finally {
    Object.assign(redisCache, originals);
  }
});

test("a skipped generation never deletes the newly published bank when bank parity repeats", async () => {
  const originals = {
    isEnabled: redisCache.isEnabled,
    getJSON: redisCache.getJSON,
    setManyJSON: redisCache.setManyJSON,
    evalLua: redisCache.evalLua,
    del: redisCache.del,
    withLock: redisCache.withLock,
  };
  const deleted = [];
  const written = [];
  try {
    redisCache.isEnabled = () => true;
    redisCache.getJSON = async () => ({
      v: 2, generation: 1, raceId: "race-1", chunkCount: 1,
      requesterBucketCount: 256, slotBank: 1,
    });
    redisCache.setManyJSON = async (entries) => {
      written.push(...entries.map(({ key }) => key));
      return { ok: true, disabled: false, count: entries.length };
    };
    redisCache.evalLua = async () => ({ ok: true, disabled: false, result: 1 });
    redisCache.del = async (keys) => {
      deleted.push(...keys);
      return true;
    };
    redisCache.withLock = async (_key, _ttlMs, work) => work();

    const snapshot = buildRaceProgressPageProjection({
      raceId: "race-1",
      generation: 3,
      scoringTimeZone: "America/New_York",
      asOf: new Date("2026-08-31T16:00:00.000Z"),
      participants: [{ participantId: "p1", userId: "u1", totalSteps: 100 }],
    });
    assert.equal(await publishRaceProgressPageProjection({
      raceId: "race-1", generation: 3, snapshot,
    }), true);
    assert.equal(written.includes(
      cacheKeys.raceProgressPageBankSlot("race-1", 1, 0)), false,
    "the active bank must remain untouched until the index flips");
    assert.equal(written.includes(
      cacheKeys.raceProgressPageBankSlot("race-1", 0, 0)), true);
    assert.equal(deleted.includes(
      cacheKeys.raceProgressPageBankSlot("race-1", 1, 0)), true);
  } finally {
    Object.assign(redisCache, originals);
  }
});
