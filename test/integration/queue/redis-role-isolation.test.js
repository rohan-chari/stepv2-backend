const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const redisCache = require("../../../src/shared/cache/redisCache");
const {
  STREAMS,
  streamName,
  publish,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  startTestRedis,
  closedPort,
} = require("../redisTestServer");

let ownedRedis = null;
let cacheUrl;
let queueUrl;
let cacheInspector;
let queueInspector;
let originalRedisUrl;
let originalQueueRedisUrl;
let originalPrefix;
let testPrefix;

function withDb(url, db) {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
}

async function flush(redis) {
  if (redis) await redis.flushdb();
}

describe("cache and durable queue Redis isolation", () => {
  before(async (t) => {
    originalRedisUrl = process.env.REDIS_URL;
    originalQueueRedisUrl = process.env.QUEUE_REDIS_URL;
    originalPrefix = process.env.CACHE_ENV_PREFIX;

    ownedRedis = await startTestRedis();
    if (!ownedRedis) {
      t.skip("real Redis/Valkey is unavailable");
      return;
    }

    // Separate logical databases are enough for this integration contract:
    // they let us prove cache and durable queue clients honor different URLs.
    cacheUrl = withDb(ownedRedis.url, 14);
    queueUrl = withDb(ownedRedis.url, 15);

    cacheInspector = new IORedis(cacheUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    queueInspector = new IORedis(queueUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await cacheInspector.connect();
    await queueInspector.connect();
  });

  beforeEach(async () => {
    if (!cacheUrl) return;
    await redisCache.close();
    await closeQueueRedis();
    await flush(cacheInspector);
    await flush(queueInspector);

    testPrefix = `integration:redis-role-isolation:${crypto.randomUUID()}:`;
    process.env.REDIS_URL = cacheUrl;
    process.env.QUEUE_REDIS_URL = queueUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
  });

  afterEach(async () => {
    if (!cacheUrl) return;
    await redisCache.close();
    await closeQueueRedis();
    await flush(cacheInspector);
    await flush(queueInspector);
  });

  after(async () => {
    await redisCache.close();
    await closeQueueRedis();
    if (cacheInspector) {
      await cacheInspector.quit().catch(() => cacheInspector.disconnect());
    }
    if (queueInspector) {
      await queueInspector.quit().catch(() => queueInspector.disconnect());
    }
    if (ownedRedis) await ownedRedis.close();

    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;

    if (originalQueueRedisUrl === undefined) delete process.env.QUEUE_REDIS_URL;
    else process.env.QUEUE_REDIS_URL = originalQueueRedisUrl;

    if (originalPrefix === undefined) delete process.env.CACHE_ENV_PREFIX;
    else process.env.CACHE_ENV_PREFIX = originalPrefix;
  });

  it("keeps cache keys on REDIS_URL and durable streams on QUEUE_REDIS_URL", async () => {
    assert.equal(
      await redisCache.setJSON("role-check", { source: "cache" }, 60),
      true,
    );
    await publish(STREAMS.STEP_SYNC, {
      schemaVersion: 1,
      syncId: "queue-role-check",
    });

    assert.notEqual(
      await cacheInspector.get(`${testPrefix}role-check`),
      null,
      "cache write should exist on cache Redis",
    );
    assert.equal(
      await queueInspector.get(`${testPrefix}role-check`),
      null,
      "cache write must not leak into queue Redis",
    );

    assert.equal(
      await cacheInspector.exists(streamName(STREAMS.STEP_SYNC)),
      0,
      "durable stream must not be created on cache Redis",
    );
    assert.equal(
      await queueInspector.xlen(streamName(STREAMS.STEP_SYNC)),
      1,
      "durable stream should be created on queue Redis",
    );
  });

  it("does not fall back to cache Redis when QUEUE_REDIS_URL is unavailable", async () => {
    const port = await closedPort();
    await closeQueueRedis();
    process.env.QUEUE_REDIS_URL = `redis://127.0.0.1:${port}/15`;

    await assert.rejects(
      publish(STREAMS.STEP_SYNC, {
        schemaVersion: 1,
        syncId: "queue-must-fail",
      }),
    );

    assert.equal(
      await cacheInspector.exists(streamName(STREAMS.STEP_SYNC)),
      0,
      "queue failure must not silently publish to cache Redis",
    );
  });

  it("keeps durable queue publishing available when cache Redis is unavailable", async () => {
    const port = await closedPort();
    await redisCache.close();
    await closeQueueRedis();
    process.env.REDIS_URL = `redis://127.0.0.1:${port}/14`;
    process.env.QUEUE_REDIS_URL = queueUrl;

    assert.equal(
      await redisCache.setJSON("cache-down", { value: true }, 60),
      false,
      "cache failure should degrade instead of throwing",
    );

    const id = await publish(STREAMS.STEP_SYNC, {
      schemaVersion: 1,
      syncId: "queue-still-works",
    });

    assert.match(id, /^\d+-\d+$/);
    assert.equal(
      await queueInspector.xlen(streamName(STREAMS.STEP_SYNC)),
      1,
      "queue Redis should continue accepting durable work",
    );
  });
});
