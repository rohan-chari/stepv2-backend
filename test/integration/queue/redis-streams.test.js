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
  reclaimIdle,
  pendingSummary,
  queueHealth,
  trimSafeHistory,
  close: closeQueueRedis,
} = require("../../../src/shared/queues/redisStreams");
const {
  startTestRedis,
  closedPort,
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
    const [next, keys] = await inspector.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    if (keys.length) await inspector.del(...keys);
  } while (cursor !== "0");
}

describe("queue-first Redis Streams transport", () => {
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
    testPrefix = `${originalPrefix || "integration:"}redis-streams:${crypto.randomUUID()}:`;
    process.env.QUEUE_REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = testPrefix;
  });

  afterEach(async () => {
    if (!redisUrl) return;
    await closeQueueRedis();
    await deletePrefix(testPrefix);
    process.env.QUEUE_REDIS_URL = redisUrl;
    process.env.CACHE_ENV_PREFIX = originalPrefix || "";
  });

  after(async () => {
    await closeQueueRedis();
    if (inspector) await inspector.quit().catch(() => inspector.disconnect());
    if (ownedRedis) await ownedRedis.close();
    if (originalQueueRedisUrl === undefined) delete process.env.QUEUE_REDIS_URL;
    else process.env.QUEUE_REDIS_URL = originalQueueRedisUrl;
    if (originalPrefix === undefined) delete process.env.CACHE_ENV_PREFIX;
    else process.env.CACHE_ENV_PREFIX = originalPrefix;
  });

  it("publishes a durable entry to the real Redis stream", async () => {
    const id = await publish(STREAMS.STEP_SYNC, {
      schemaVersion: 1,
      syncId: "sync-1",
      userId: "user-1",
    });

    assert.match(id, /^\d+-\d+$/);
    const entries = await inspector.xrange(streamName(STREAMS.STEP_SYNC), "-", "+");
    assert.equal(entries.length, 1);
    assert.equal(entries[0][0], id);
    assert.deepEqual(entries[0][1], [
      "schemaVersion", "1",
      "syncId", "sync-1",
      "userId", "user-1",
    ]);
  });

  it("creates consumer groups idempotently and reads through the group", async () => {
    assert.equal(await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC), true);
    assert.equal(await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC), true);

    await publish(STREAMS.STEP_SYNC, {
      schemaVersion: 1,
      syncId: "sync-group",
      userId: "user-group",
    });

    const entries = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-a",
      count: 10,
      blockMs: 5,
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].fields.syncId, "sync-group");
    assert.equal(entries[0].fields.userId, "user-group");
  });

  it("keeps unacked work pending and removes it only after ACK", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "sync-pending" });

    const [entry] = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-a",
      count: 1,
      blockMs: 5,
    });
    assert.ok(entry);

    const before = await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    assert.equal(before.count, 1);
    assert.equal(before.minId, entry.id);
    assert.equal(before.maxId, entry.id);

    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, entry.id), true);
    const afterAck = await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    assert.equal(afterAck.count, 0);
  });

  it("reclaims abandoned pending work after the idle threshold", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "sync-reclaim" });

    const [original] = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-a",
      count: 1,
      blockMs: 5,
    });
    assert.ok(original);

    await new Promise((resolve) => setTimeout(resolve, 15));
    const reclaimed = await reclaimIdle({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-b",
      minIdleMs: 5,
      count: 10,
    });

    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].id, original.id);
    assert.equal(reclaimed[0].fields.syncId, "sync-reclaim");
    assert.equal(
      (await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC)).count,
      1,
    );
  });

  it("does not reclaim a live consumer's message before the idle threshold", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "sync-live" });

    await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-a",
      count: 1,
      blockMs: 5,
    });

    const reclaimed = await reclaimIdle({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "consumer-b",
      minIdleMs: 60_000,
      count: 10,
    });
    assert.deepEqual(reclaimed, []);
    assert.equal(
      (await pendingSummary(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC)).count,
      1,
    );
  });

  it("fails a required publish loudly when Redis is unavailable", async () => {
    const port = await closedPort();
    await closeQueueRedis();
    process.env.QUEUE_REDIS_URL = `redis://127.0.0.1:${port}/15`;

    await assert.rejects(
      publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "must-fail" }),
    );

    await closeQueueRedis();
    process.env.QUEUE_REDIS_URL = redisUrl;
  });

  it("reports pending, waiting, oldest age, and consumer count", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "health-1" });
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "health-2" });

    const [entry] = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "health-consumer",
      count: 1,
      blockMs: 5,
    });
    assert.ok(entry);

    const health = await queueHealth(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, {
      nowMs: Date.now() + 1000,
    });
    assert.equal(health.pendingCount, 1);
    assert.equal(health.waitingCount, 1);
    assert.equal(health.consumerCount, 1);
    assert.ok(health.oldestPendingAgeMs >= 1000);
  });

  it("trims old ACKed entries while keeping recent history", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);

    const first = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "trim-1" });
    const second = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "trim-2" });
    const third = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "trim-3" });

    const entries = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "trim-consumer",
      count: 3,
      blockMs: 5,
    });
    assert.deepEqual(entries.map((entry) => entry.id), [first, second, third]);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, first), true);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, second), true);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, third), true);

    await trimSafeHistory(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, { keepRecent: 1 });

    const remaining = await inspector.xrange(streamName(STREAMS.STEP_SYNC), "-", "+");
    assert.deepEqual(remaining.map(([id]) => id), [third]);
  });

  it("never trims a pending entry", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);

    const first = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "pending-trim-1" });
    const second = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "pending-trim-2" });
    const third = await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, syncId: "pending-trim-3" });

    const entries = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "trim-pending-consumer",
      count: 3,
      blockMs: 5,
    });
    assert.deepEqual(entries.map((entry) => entry.id), [first, second, third]);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, first), true);
    assert.equal(await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, third), true);

    await trimSafeHistory(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, { keepRecent: 0 });

    const remaining = await inspector.xrange(streamName(STREAMS.STEP_SYNC), "-", "+");
    assert.equal(remaining.some(([id]) => id === second), true, "pending entry must survive trimming");
  });

  it("keeps queue types isolated from each other", async () => {
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    await ensureGroup(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC);

    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, kind: "step" });
    await publish(STREAMS.POWERUP_RECALC, { schemaVersion: 1, kind: "powerup" });

    const steps = await readGroup({
      stream: STREAMS.STEP_SYNC,
      group: GROUPS.STEP_SYNC,
      consumer: "step-consumer",
      count: 10,
      blockMs: 5,
    });
    const powerups = await readGroup({
      stream: STREAMS.POWERUP_RECALC,
      group: GROUPS.POWERUP_RECALC,
      consumer: "powerup-consumer",
      count: 10,
      blockMs: 5,
    });

    assert.deepEqual(steps.map((entry) => entry.fields.kind), ["step"]);
    assert.deepEqual(powerups.map((entry) => entry.fields.kind), ["powerup"]);
  });

  it("keeps environment prefixes physically isolated", async () => {
    const prefixA = `${testPrefix}a:`;
    const prefixB = `${testPrefix}b:`;

    process.env.CACHE_ENV_PREFIX = prefixA;
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, marker: "A" });

    process.env.CACHE_ENV_PREFIX = prefixB;
    await publish(STREAMS.STEP_SYNC, { schemaVersion: 1, marker: "B" });

    const entriesA = await inspector.xrange(
      `${prefixA}${STREAMS.STEP_SYNC}`,
      "-",
      "+",
    );
    const entriesB = await inspector.xrange(
      `${prefixB}${STREAMS.STEP_SYNC}`,
      "-",
      "+",
    );

    assert.equal(entriesA.length, 1);
    assert.equal(entriesB.length, 1);
    assert.ok(entriesA[0][1].includes("A"));
    assert.ok(entriesB[0][1].includes("B"));
  });
});
