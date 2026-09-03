const assert = require("node:assert/strict");
const { test } = require("node:test");

const { startTestRedis } = require("./redisTestServer");
const cache = require("../../src/shared/cache/redisCache");

function nextMessage(messages) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("wake message timed out")), 2_000);
    messages.push((message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

test("durable queue wake classifications survive Redis while unknown values stay legacy-safe", async (t) => {
  const live = await startTestRedis();
  if (!live) return t.skip("no local Redis available");
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = "wake-classification-test:";
  await cache.close();

  const waiters = [];
  const unsubscribe = await cache.subscribeDurableQueueWakeup((message) => {
    waiters.shift()?.(message);
  });
  try {
    let received = nextMessage(waiters);
    assert.equal(await cache.publishDurableQueueWakeup(
      "resolution", { workKind: "ordinary" },
    ), true);
    assert.deepEqual(await received, { queue: "resolution", workKind: "ordinary" });

    received = nextMessage(waiters);
    assert.equal(await cache.publishDurableQueueWakeup(
      "resolution", { workKind: "full-trigger" },
    ), true);
    assert.deepEqual(await received, { queue: "resolution", workKind: "full-trigger" });

    received = nextMessage(waiters);
    assert.equal(await cache.publishDurableQueueWakeup(
      "resolution", { workKind: "future-version-value" },
    ), true);
    assert.deepEqual(
      await received,
      { queue: "resolution" },
      "unknown classifications must reach workers as conservative legacy wakes",
    );
  } finally {
    await unsubscribe();
    await cache.close();
    delete process.env.REDIS_URL;
    await live.close();
  }
});
