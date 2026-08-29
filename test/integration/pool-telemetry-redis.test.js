const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

process.env.CACHE_ENV_PREFIX = "t:";
delete process.env.REDIS_URL;

const { startTestRedis } = require("./redisTestServer");
const cache = require("../../src/shared/cache/redisCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");

let live;
let probe;
let skipReason;

before(async () => {
  live = await startTestRedis();
  if (!live) skipReason = "no local Redis available";
});

beforeEach(async () => {
  if (!live) return;
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = "t:";
  await cache.close();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
});

after(async () => {
  await cache.close();
  await probe?.quit().catch(() => {});
  await live?.close();
  delete process.env.REDIS_URL;
});

function snapshot(bootStartedAtMs, capturedAtMs, bootId) {
  return {
    schema: "database-pool-telemetry-snapshot-v1",
    role: "http",
    instance: "0",
    bootId,
    bootStartedAtMs,
    capturedAtMs,
  };
}

function emission(bootId) {
  const zero = { requests: 0, successes: 0, validation4xx: 0, auth4xx: 0, poolCheckoutTimeouts: 0, transactionErrors: 0, server5xx: 0 };
  return {
    minuteStartedAtMs: Date.parse("2026-08-29T19:29:00Z"),
    role: "http",
    instance: "0",
    bootId,
    endpoints: { steps: zero, samples: zero, "sync-v2": zero },
  };
}

describe("pool telemetry Redis transport", () => {
  it("atomically keeps the later boot even when a draining old boot captures later", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const key = cacheKeys.databasePoolTelemetry("http", "0");
    await probe.set(`t:${key}`, "{malformed");
    assert.equal((await cache.writeDatabasePoolTelemetrySnapshot(key, snapshot(100, 200, "old"), 150)).status, "accepted");
    assert.equal((await cache.writeDatabasePoolTelemetrySnapshot(key, snapshot(300, 310, "new"), 150)).status, "accepted");
    assert.equal((await cache.writeDatabasePoolTelemetrySnapshot(key, snapshot(100, 999, "old-late"), 150)).status, "older");
    assert.equal((await cache.getJSON(key)).bootId, "new");
    assert.ok(await probe.ttl(`t:${key}`) > 0);
  });

  it("deduplicates ambiguous retries and marks the exact third PM2 overlap emission overflow", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const minute = Date.parse("2026-08-29T19:29:00Z");
    const input = (bootId) => ({
      hourKey: cacheKeys.stepIngestionHour(minute),
      startKey: cacheKeys.stepIngestionHistoryStart(),
      emission: emission(bootId),
      collectionStartedMinuteMs: minute,
    });
    assert.equal((await cache.writeStepIngestionMinute(input("boot-a"))).status, "accepted");
    assert.equal((await cache.writeStepIngestionMinute(input("boot-a"))).status, "duplicate");
    assert.equal((await cache.writeStepIngestionMinute(input("boot-b"))).status, "accepted");
    const telemetryWarnings = [];
    const originalConsoleError = console.error;
    console.error = (...args) => telemetryWarnings.push(args.join(" "));
    try {
      assert.equal((await cache.writeStepIngestionMinute(input("boot-c"))).status, "overflow");
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(telemetryWarnings.length, 1);
    assert.match(telemetryWarnings[0], /step-telemetry-history-overflow/);
    const hourKey = cacheKeys.stepIngestionHour(minute);
    const fields = await probe.hgetall(`t:${hourKey}`);
    assert.equal(fields[`c:${minute}:http:0`], "2");
    assert.equal(fields[`o:${minute}:http:0`], "1");
    assert.equal(Object.keys(fields).filter((field) => field.startsWith("m:")).length, 2);

    const read = await cache.readStepIngestionHistory({
      startKey: cacheKeys.stepIngestionHistoryStart(),
      hourKeys: [hourKey],
    });
    assert.equal(read.ok, true);
    assert.equal(read.start.schema, "step-ingestion-history-start-v1");
    assert.equal(read.hours.length, 1);
  });

  it("one malformed snapshot stays isolated to its MGET slot", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const keys = [
      cacheKeys.databasePoolTelemetry("http", "0"),
      cacheKeys.databasePoolTelemetry("http", "1"),
      cacheKeys.databasePoolTelemetry("resolution", "0"),
      cacheKeys.databasePoolTelemetry("cron", "0"),
    ];
    await probe.set(`t:${keys[0]}`, JSON.stringify(snapshot(100, 200, "valid")));
    await probe.set(`t:${keys[1]}`, "{bad json");
    const result = await cache.readDatabasePoolTelemetrySnapshots(keys);
    assert.equal(result.ok, true);
    assert.equal(result.values[0].bootId, "valid");
    assert.equal(result.values[1], undefined);
    assert.equal(result.values[2], null);
    assert.equal(result.values[3], null);
  });

  it("accepts snapshots above the retired 64 KiB bound and rejects/isolates values above 512 KiB", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const keys = [
      cacheKeys.databasePoolTelemetry("http", "0"),
      cacheKeys.databasePoolTelemetry("http", "1"),
      cacheKeys.databasePoolTelemetry("resolution", "0"),
      cacheKeys.databasePoolTelemetry("cron", "0"),
    ];
    const withinCap = { ...snapshot(100, 200, "within-cap"), padding: "x".repeat(70 * 1024) };
    assert.equal((await cache.writeDatabasePoolTelemetrySnapshot(keys[0], withinCap, 150)).status, "accepted");

    const aboveCap = { ...snapshot(100, 200, "above-cap"), padding: "x".repeat(513 * 1024) };
    assert.equal((await cache.writeDatabasePoolTelemetrySnapshot(keys[0], aboveCap, 150)).status, "oversize");
    await probe.set(`t:${keys[1]}`, JSON.stringify(aboveCap));
    const read = await cache.readDatabasePoolTelemetrySnapshots(keys);
    assert.equal(read.ok, true);
    assert.equal(read.values[0].bootId, "within-cap");
    assert.equal(read.values[1], undefined);
    assert.equal(read.values[2], null);
    assert.equal(read.values[3], null);
  });
});
