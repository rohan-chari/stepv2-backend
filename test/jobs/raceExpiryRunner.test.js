const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRaceExpiryRunner } = require("../../src/modules/races/jobs/raceExpiry");

test("race expiry runner skips overlapping settlement passes", async () => {
  let release;
  let calls = 0;
  const logs = [];
  const resolve = async () => {
    calls += 1;
    if (calls > 1) return;
    await new Promise((resolvePromise) => { release = resolvePromise; });
  };
  const run = buildRaceExpiryRunner({ resolve, logger: { log: (message) => logs.push(message) } });

  const first = run();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = await run();

  assert.deepEqual(second, { skipped: true });
  assert.equal(calls, 1);
  assert.match(logs[0], /previous settlement pass still running/);

  release();
  assert.deepEqual(await first, { skipped: false });
  assert.deepEqual(await run(), { skipped: false });
  assert.equal(calls, 2);
});
