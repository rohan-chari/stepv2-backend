const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCompletedRaceSummaryCache,
  CACHE_VERSION,
  TTL_SECONDS,
  MAX_PAYLOAD_BYTES,
} = require("../../src/modules/races/services/completedRaceSummaryCache");

function summary(raceId, overrides = {}) {
  return {
    version: CACHE_VERSION,
    raceId,
    acceptedCount: 2,
    teamACount: 0,
    teamBCount: 0,
    teamAPayoutRecipientCount: 0,
    teamBPayoutRecipientCount: 0,
    completedPayouts: [],
    teamASteps: "0",
    teamBSteps: "0",
    totalsAsOf: null,
    leaderParticipantId: "p1",
    leaderUserId: "u1",
    leaderTotalSteps: 100,
    leaderPlacement: 1,
    leaderFinishedAt: null,
    leaderJoinedAt: null,
    ambiguousFinisherOrder: false,
    ...overrides,
  };
}

function fakeRedis({ values = new Map(), enabled = true, readError = false,
  writeError = false } = {}) {
  const writes = [];
  return {
    writes,
    values,
    isEnabled: () => enabled,
    async getManyJSON(keys) {
      if (readError) throw new Error("read failed");
      return { ok: true, disabled: false,
        values: keys.map((key) => values.has(key) ? values.get(key) : null) };
    },
    async setManyJSON(entries) {
      if (writeError) throw new Error("write failed");
      writes.push(...entries);
      for (const entry of entries) values.set(entry.key, entry.value);
      return { ok: true, disabled: false, count: entries.length };
    },
  };
}

function race(id, updatedAt = "2026-09-01T12:00:00.000Z") {
  return { id, status: "COMPLETED", updatedAt };
}

test("cold multi-race miss writes bounded versioned summaries and the next read hits", async () => {
  const redis = fakeRedis();
  const events = [];
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log: (event) => events.push(event) },
  });
  let loads = 0;
  const load = async (ids) => {
    loads += 1;
    return new Map(ids.map((id) => [id, summary(id)]));
  };

  const cold = await cache.getMany({ races: [race("r1"), race("r2")], load });
  const hit = await cache.getMany({ races: [race("r1"), race("r2")], load });

  assert.equal(loads, 1);
  assert.deepEqual([...cold.keys()], ["r1", "r2"]);
  assert.deepEqual(hit.get("r1"), cold.get("r1"));
  assert.equal(redis.writes.length, 2);
  assert.ok(redis.writes.every((entry) => entry.ttlSeconds === TTL_SECONDS));
  assert.ok(redis.writes.every((entry) =>
    entry.key.startsWith("v1:race:completed-summary:")));
  assert.ok(events.some((event) => event.outcome === "miss"));
  assert.ok(events.some((event) => event.outcome === "hit"));
  assert.equal(JSON.stringify(events).includes("r1"), false);
});

test("a partial hit loads only misses in one batch", async () => {
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log() {} },
  });
  await cache.getMany({ races: [race("r1")],
    load: async () => new Map([["r1", summary("r1")]]) });
  let loadedIds = null;
  const result = await cache.getMany({ races: [race("r1"), race("r2")],
    load: async (ids) => {
      loadedIds = ids;
      return new Map([["r2", summary("r2")]]);
    } });
  assert.deepEqual(loadedIds, ["r2"]);
  assert.deepEqual([...result.keys()], ["r1", "r2"]);
});

test("a changed authoritative updatedAt cannot reuse an older result", async () => {
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log() {} },
  });
  let loads = 0;
  const load = async () => {
    loads += 1;
    return new Map([["r1", summary("r1", { acceptedCount: loads })]]);
  };
  const first = await cache.getMany({ races: [race("r1")], load });
  const repaired = await cache.getMany({
    races: [race("r1", "2026-09-01T12:00:01.000Z")], load,
  });
  assert.equal(first.get("r1").acceptedCount, 1);
  assert.equal(repaired.get("r1").acceptedCount, 2);
  assert.equal(redis.writes.length, 2);
  assert.notEqual(redis.writes[0].key, redis.writes[1].key);
});

test("malformed, wrong-version, and oversized hits fall through", async () => {
  const cases = [
    { version: CACHE_VERSION, raceId: "wrong" },
    summary("r1", { version: CACHE_VERSION + 1 }),
    summary("r1", { leaderUserId: "x".repeat(MAX_PAYLOAD_BYTES) }),
  ];
  for (const invalid of cases) {
    const values = new Map([
      ["v1:race:completed-summary:r1:2026-09-01T12%3A00%3A00.000Z", invalid],
    ]);
    const redis = fakeRedis({ values });
    const cache = buildCompletedRaceSummaryCache({
      redisCache: redis,
      derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
      logger: { log() {} },
    });
    let loads = 0;
    const result = await cache.getMany({ races: [race("r1")], load: async () => {
      loads += 1;
      return new Map([["r1", summary("r1")]]);
    } });
    assert.equal(loads, 1);
    assert.equal(result.get("r1").raceId, "r1");
  }
});

test("telemetry distinguishes malformed payloads from bounded-size violations", async () => {
  const cases = [
    {
      invalid: summary("r1", { acceptedCount: "two" }),
      expectedOutcome: "malformed",
    },
    {
      invalid: summary("r1", { leaderUserId: "x".repeat(MAX_PAYLOAD_BYTES) }),
      expectedOutcome: "oversized",
    },
  ];

  for (const { invalid, expectedOutcome } of cases) {
    const key = "v1:race:completed-summary:r1:2026-09-01T12%3A00%3A00.000Z";
    const events = [];
    const cache = buildCompletedRaceSummaryCache({
      redisCache: fakeRedis({ values: new Map([[key, invalid]]) }),
      derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
      logger: { log: (event) => events.push(event) },
      successEvery: 1,
    });
    await cache.getMany({
      races: [race("r1")],
      load: async () => new Map([["r1", summary("r1")]]),
    });
    assert.equal(
      events.some((event) => event.outcome === expectedOutcome),
      true,
      expectedOutcome,
    );
    assert.equal(
      events.some((event) =>
        event.outcome === (expectedOutcome === "malformed" ? "oversized" : "malformed")),
      false,
    );
  }
});

test("an authoritative oversized result is returned but never cached", async () => {
  const oversized = summary("r1", {
    leaderUserId: "x".repeat(MAX_PAYLOAD_BYTES),
  });
  const events = [];
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log: (event) => events.push(event) },
    successEvery: 1,
  });

  const result = await cache.getMany({
    races: [race("r1")],
    load: async () => new Map([["r1", oversized]]),
  });

  assert.equal(result.get("r1").leaderUserId.length, MAX_PAYLOAD_BYTES,
    "Redis bounds must not truncate or omit the authoritative HTTP result");
  assert.equal(redis.writes.length, 0, "oversized result is not written to Redis");
  assert.equal(events.some((event) => event.outcome === "oversized"), true);
  assert.equal(events.some((event) => event.outcome === "malformed"), false);
});

test("completed summaries never retain a full rank roster", async () => {
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log() {} },
  });
  const result = await cache.getMany({
    races: [race("r1")],
    load: async () => new Map([["r1", summary("r1", {
      rankRoster: [
        { id: "p1", userId: "u1", finishedAt: null, placement: 1 },
        { id: "p2", userId: "u2", finishedAt: null, placement: 2 },
      ],
    })]]),
  });
  assert.equal(Object.hasOwn(result.get("r1"), "rankRoster"), false);
  assert.equal(Object.hasOwn(redis.writes[0].value, "rankRoster"), false);
});

test("an authoritative malformed result is returned but never cached", async () => {
  const events = [];
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log: (event) => events.push(event) },
    successEvery: 1,
  });
  const result = await cache.getMany({
    races: [race("r1")],
    load: async () => new Map([["r1", summary("r1", { teamASteps: -1 })]]),
  });
  assert.equal(result.get("r1").teamASteps, -1,
    "cache schema validation must not suppress an authoritative result");
  assert.equal(redis.writes.length, 0);
  assert.equal(events.some((event) => event.outcome === "malformed"), true);
  assert.equal(events.some((event) => event.outcome === "oversized"), false);
});

test("Redis disabled and read/write failures fail open", async () => {
  for (const redis of [
    fakeRedis({ enabled: false }),
    fakeRedis({ readError: true }),
    fakeRedis({ writeError: true }),
  ]) {
    const cache = buildCompletedRaceSummaryCache({
      redisCache: redis,
      derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
      logger: { log() {} },
    });
    const result = await cache.getMany({ races: [race("r1")],
      load: async () => new Map([["r1", summary("r1")]]) });
    assert.equal(result.get("r1").acceptedCount, 2);
  }
});

test("concurrent fills for the same versions share one loader", async () => {
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log() {} },
  });
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const load = async (ids) => {
    loads += 1;
    await gate;
    return new Map(ids.map((id) => [id, summary(id)]));
  };
  const first = cache.getMany({ races: [race("r1"), race("r2")], load });
  const second = cache.getMany({ races: [race("r1"), race("r2")], load });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(loads, 1);
  assert.deepEqual(a, b);
});

test("viewer-specific fields are rejected from shared payloads", async () => {
  const redis = fakeRedis();
  const cache = buildCompletedRaceSummaryCache({
    redisCache: redis,
    derivedCache: { isBypassed: () => false, ensureSubscribed() {} },
    logger: { log() {} },
  });
  const result = await cache.getMany({ races: [race("r1")], load: async () =>
    new Map([["r1", summary("r1", { viewerUserId: "secret" })]]) });
  assert.equal(result.has("r1"), true);
  assert.equal(Object.hasOwn(result.get("r1"), "viewerUserId"), false);
  assert.equal(Object.hasOwn(redis.writes[0].value, "viewerUserId"), false);
});
