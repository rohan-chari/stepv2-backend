// Fault injection below is deliberately a unit test: selecting only the first
// two Redis legacy-generation EVAL failures is not expressible by HTTP inputs.
// Separate integration tests cover the real public mutation/commit chain.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const redis = require("../../src/shared/cache/redisCache");
const derived = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const { invalidateUsers } = require("../../src/modules/races/services/raceListCache");

test("a later legacy batch cannot discard the earlier failed batch retry", async (t) => {
  t.mock.method(redis, "isEnabled", () => true);
  t.mock.method(redis, "subscribe", async () => async () => {});
  t.mock.method(redis, "publishInvalidate", async () => true);
  let failed = 0;
  const repaired = new Set();
  t.mock.method(redis, "evalLua", async (_script, keys) => {
    if (keys[0]?.startsWith(cacheKeys.PREFIX.RACE_LIST)) {
      if (failed++ < 2) return { ok: false, disabled: false };
      for (let index = 0; index < keys.length; index += 2) repaired.add(keys[index]);
    }
    return { ok: true, disabled: false, result: keys.length };
  });
  t.after(() => derived.reset());
  const first = Array.from({ length: 300 }, (_, index) => `failed-viewer-${index}`);
  assert.equal(await invalidateUsers(first, { advanceEfficiency: false }), false);
  assert.equal(derived.isBypassed(cacheKeys.PREFIX.RACE_LIST), true);
  assert.equal(await invalidateUsers(["later-viewer"], { advanceEfficiency: false }), true);
  for (const user of [...first, "later-viewer"]) assert.equal(repaired.has(cacheKeys.raceListGeneration(user)), true);
  assert.equal(derived.isBypassed(cacheKeys.PREFIX.RACE_LIST), false);
});
