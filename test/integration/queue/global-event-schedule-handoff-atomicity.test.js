const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const {
  STREAMS,
  streamName,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  scheduleKey,
  publishDueBoundaries,
} = require("../../../src/modules/steps/services/globalEventRedisSchedule");
const {
  startTestRedis,
} = require("../redisTestServer");

let ownedRedis = null;
let redisUrl;
let inspector;
let originalRedisUrl;
let originalQueueRedisUrl;
let originalPrefix;
let testPrefix;

async function deletePrefix(prefix) {
  if (!inspector || !prefix) return;
  let cursor = "0";
  do {
    const [next, keys] = await inspector.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      100,
    );
    cursor = next;
    if (keys.length) await inspector.del(...keys);
  } while (cursor !== "0");
}

describe("global event Redis schedule handoff atomicity", () => {
  before(async (t) => {
    originalRedisUrl = process.env.REDIS_URL;
    originalQueueRedisUrl = process.env.QUEUE_REDIS_URL;
    originalPrefix = process.env.CACHE_ENV_PREFIX;

    const configured =
      String(process.env.QUEUE_REDIS_URL || "").trim() ||
      String(process.env.REDIS_URL || "").trim();

    if (configured) {
      redisUrl = configured;
    } else {
      ownedRedis = await startTestRedis();
      if (!ownedRedis) {
        t.skip("real Redis/Valkey is unavailable");
        return;
      }
      redisUrl = ownedRedis.url;
    }

    inspector = new IORedis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await inspector.connect();
  });

  beforeEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    testPrefix = `${originalPrefix || "integration:"}global-event-handoff:${crypto.randomUUID()}:`;
    process.env.REDIS_URL = redisUrl;
    process.env.QUEUE_REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
    await deletePrefix(testPrefix);
  });

  afterEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    await deletePrefix(testPrefix);
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalQueueRedisUrl === undefined) delete process.env.QUEUE_REDIS_URL;
    else process.env.QUEUE_REDIS_URL = originalQueueRedisUrl;
    if (originalPrefix === undefined) delete process.env.CACHE_ENV_PREFIX;
    else process.env.CACHE_ENV_PREFIX = originalPrefix;
  });

  after(async () => {
    await closeQueueRedis();
    if (inspector) await inspector.quit().catch(() => inspector.disconnect());
    if (ownedRedis) await ownedRedis.close();
  });

  it("keeps a due boundary scheduled when Redis cannot XADD it to the boundary stream", async () => {
    const dueAt = new Date("2098-08-26T10:00:00.000Z");
    const entitlementId = crypto.randomUUID();
    const member = `START:${entitlementId}:0`;

    await inspector.zadd(scheduleKey(), dueAt.getTime(), member);

    // Force XADD to fail with WRONGTYPE. This reproduces the dangerous handoff
    // window: if the scheduler removes the sorted-set member before the stream
    // append succeeds, the boundary disappears from both Redis structures.
    await inspector.set(
      streamName(STREAMS.GLOBAL_EVENT_BOUNDARY),
      "not-a-stream",
    );

    await assert.rejects(
      () => publishDueBoundaries({ now: dueAt, limit: 100 }),
      /WRONGTYPE/,
    );

    assert.deepEqual(
      await inspector.zrange(scheduleKey(), 0, -1),
      [member],
      "a failed stream append must leave the due boundary scheduled for retry",
    );
  });
});
