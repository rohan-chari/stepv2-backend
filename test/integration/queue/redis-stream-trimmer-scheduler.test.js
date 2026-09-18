const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, afterEach, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const {
  STREAMS,
  GROUPS,
  streamName,
  publish,
  ensureGroup,
  readGroup,
  ack,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  buildRedisStreamTrimmer,
} = require("../../../src/shared/queues/redisStreamTrimmer");
const {
  startTestRedis,
} = require("../redisTestServer");

let ownedRedis = null;
let redisUrl;
let inspector;
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

async function streamIds() {
  const rows = await inspector.xrange(streamName(STREAMS.STEP_SYNC), "-", "+");
  return rows.map(([id]) => id);
}

describe("scheduled Redis Stream trimming", () => {
  before(async (t) => {
    originalQueueRedisUrl = process.env.QUEUE_REDIS_URL;
    originalPrefix = process.env.CACHE_ENV_PREFIX;

    if (String(process.env.QUEUE_REDIS_URL || "").trim()) {
      redisUrl = process.env.QUEUE_REDIS_URL;
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
    testPrefix = `${originalPrefix || "integration:"}stream-trimmer:${crypto.randomUUID()}:`;
    process.env.QUEUE_REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
    await deletePrefix(testPrefix);
  });

  afterEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    await deletePrefix(testPrefix);
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

  it("trims ACKed history but never removes pending or unread queue work", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);

    const ids = [];
    for (let index = 1; index <= 5; index += 1) {
      ids.push(await publish(STREAMS.STEP_SYNC, {
        schemaVersion: 1,
        syncId: `scheduled-trim-${index}`,
      }));
    }

    // Deliver only the first three. The first two become safe ACKed history,
    // the third remains pending, and entries four/five remain completely unread.
    const delivered = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "scheduled-trim-consumer",
      count: 3,
      blockMs: 5,
    });
    assert.deepEqual(delivered.map((entry) => entry.id), ids.slice(0, 3));
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, ids[0]), true);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, ids[1]), true);

    const trimmer = buildRedisStreamTrimmer({
      queues: [[STREAMS.STEP_SYNC, GROUPS.STEP_SYNC]],
      keepRecent: 1,
      logger: { log() {}, warn() {}, error() {} },
    });

    const first = await trimmer.tick();
    assert.equal(first.length, 1);
    assert.deepEqual(
      await streamIds(),
      ids.slice(2),
      "only ACKed history older than the oldest pending message may be removed",
    );

    // Once the pending entry is ACKed, unread entries still form a hard trim
    // boundary. A maintenance tick must never delete work the group has not
    // delivered yet.
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, ids[2]), true);
    await trimmer.tick();

    assert.deepEqual(
      await streamIds(),
      ids.slice(3),
      "unread stream entries must survive scheduled trimming",
    );

    const unread = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "scheduled-trim-consumer",
      count: 10,
      blockMs: 5,
    });
    assert.deepEqual(
      unread.map((entry) => entry.id),
      ids.slice(3),
      "all unread work must still be consumable after trimming",
    );
  });
});
