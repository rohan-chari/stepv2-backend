const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceListCache,
  buildRaceListInvalidator,
  canonicalRaceListVariant,
  classifyRaceListFields,
  createRaceListReadRecorder,
  TTL_SECONDS,
} = require("../../src/modules/races/services/raceListCache");

test("bounded read telemetry uses the same identifier-free cache event schema", () => {
  const events = [];
  const recordRead = createRaceListReadRecorder({
    logger: { log: (event) => events.push(event) },
    env: { CAPACITY_MODE: "true" },
  });
  recordRead({ fragment: "all", source: "postgres", outcome: "bounded",
    variant: "compact", raceCount: 3, runId: "run-1", attemptId: "narrowing-2",
    phase: "measurement" });
  assert.deepEqual(events, [{ event: "race_list_cache_v1", surface: "races",
    fragment: "all", source: "postgres", outcome: "bounded",
    variant: "compact", raceCount: 3, runId: "run-1", attemptId: "narrowing-2",
    phase: "measurement" }]);
  assert.equal(JSON.stringify(events).includes("userId"), false);
});

test("bounded read telemetry is sampled in production and complete in capacity mode", () => {
  const productionEvents = [];
  const productionRecord = createRaceListReadRecorder({
    logger: { log: (event) => productionEvents.push(event) },
    env: {},
    successEvery: 3,
  });
  for (let index = 0; index < 7; index += 1) {
    productionRecord({ source: index % 2 ? "redis" : "postgres",
      outcome: index % 2 ? "hit" : "bounded", raceCount: index });
  }
  assert.deepEqual(productionEvents.map((event) => event.raceCount), [0, 3, 6]);
  assert.deepEqual(productionEvents.map((event) => event.source),
    ["postgres", "redis", "postgres"]);

  const capacityEvents = [];
  const capacityRecord = createRaceListReadRecorder({
    logger: { log: (event) => capacityEvents.push(event) },
    env: { CAPACITY_MODE: "true" },
    successEvery: 100,
  });
  for (let index = 0; index < 4; index += 1) {
    capacityRecord({ source: "postgres", outcome: "bounded", raceCount: index });
  }
  assert.deepEqual(capacityEvents.map((event) => event.raceCount), [0, 1, 2, 3]);
});

function fakeRedis({ enabled = true, values = null, responses = null, throwOnRead = false } = {}) {
  const writes = [];
  let responseIndex = 0;
  return {
    writes,
    isEnabled: () => enabled,
    getManyJSON: async (keys) => {
      if (throwOnRead) throw new Error("redis unavailable");
      const responseValues = responses ? responses[Math.min(responseIndex++, responses.length - 1)] : values;
      return {
      ok: enabled,
      disabled: !enabled,
      values: responseValues || keys.map(() => null),
      };
    },
    setManyJSON: async (entries) => {
      writes.push(...entries);
      return { ok: enabled, disabled: !enabled, count: entries.length };
    },
    evalLua: async () => ({ ok: enabled, disabled: !enabled, result: 1 }),
  };
}

function fakeDerivedCache() {
  return {
    isBypassed: () => false,
    ensureSubscribed() {},
    invalidate: async ({ run }) => (run ? Boolean((await run()).ok) : true),
  };
}

test("legacy cache hits and misses use the same logical read recorder", async () => {
  const stable = (id, status) => ({ id, status, name: id });
  const hitEvents = [];
  const hitCache = buildRaceListCache({
    redisCache: fakeRedis({ responses: [
      [7],
      [
        { version: 1, races: [stable("active", "ACTIVE")] },
        { version: 1, races: [stable("done", "COMPLETED")] },
        { version: 1, races: [stable("waiting", "PENDING")] },
      ],
      [7],
    ] }),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
    readRecorder: (event) => hitEvents.push(event),
  });
  await hitCache.getStableMembership({ userId: "u1", variant: "legacy",
    evidenceDimensions: { runId: "run-1", attemptId: "discovery-1", phase: "measurement" },
    load: async () => { throw new Error("postgres should not run on a hit"); } });
  hitCache.recordRead({ fragment: "all", source: "postgres", outcome: "bounded",
    variant: "compact", raceCount: 2 });
  assert.deepEqual(hitEvents, [
    { fragment: "membership", source: "redis", outcome: "hit",
      variant: "legacy", raceCount: 3, runId: "run-1", attemptId: "discovery-1",
      phase: "measurement" },
    { fragment: "all", source: "postgres", outcome: "bounded",
      variant: "compact", raceCount: 2 },
  ]);

  const missEvents = [];
  const missCache = buildRaceListCache({
    redisCache: fakeRedis(),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
    readRecorder: (event) => missEvents.push(event),
  });
  await missCache.getStableMembership({ userId: "u1", variant: "legacy",
    evidenceDimensions: { runId: "run-1", attemptId: "discovery-2", phase: "measurement" },
    load: async () => [stable("fresh", "ACTIVE")] });
  assert.deepEqual(missEvents, [{ fragment: "all", source: "postgres",
    outcome: "miss", variant: "legacy", raceCount: 1,
    runId: "run-1", attemptId: "discovery-2", phase: "measurement" }]);

  const bypassEvents = [];
  const bypassCache = buildRaceListCache({
    redisCache: fakeRedis({ enabled: false }),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
    readRecorder: (event) => bypassEvents.push(event),
  });
  await bypassCache.getStableMembership({ userId: "u1", variant: "legacy",
    evidenceDimensions: { runId: "run-1", attemptId: "discovery-3", phase: "measurement" },
    load: async () => [stable("direct", "ACTIVE")] });
  assert.deepEqual(bypassEvents, [{ fragment: "all", source: "postgres",
    outcome: "bypass", variant: "legacy", raceCount: 1,
    runId: "run-1", attemptId: "discovery-3", phase: "measurement" }]);
});

test("race list variants canonicalize supported dimensions and ignore unknown tokens", () => {
  assert.equal(
    canonicalRaceListVariant({
      clientFeatures: new Set([
        "team_races", "tournaments", "seeded_race_buckets", "powerups3",
        "powerups4", "powerups5", "race_leave", "characters", "remote_assets",
        "race_payout_double", "review_prompt", "unknown_future_token",
      ]),
      compact: true,
      releaseChannel: "unknown",
    }),
    "tm1:to1:sb1:pu111:lv1:ch1:ra1:pd1:rv1:co1:rcprod",
  );
});

test("stable cache classification excludes viewer and live fields", () => {
  const classification = classifyRaceListFields();
  assert.ok(classification.stable.includes("payoutPreset"));
  assert.ok(classification.perUser.includes("myPlacement"));
  assert.ok(classification.live.includes("participantCount"));
  assert.equal(classification.stable.includes("slotItems"), false);
  assert.equal(classification.stable.includes("teams"), false);
});

test("cache writes bounded membership, completed, and pending fragments with exact TTLs", async () => {
  const redis = fakeRedis();
  const cache = buildRaceListCache({
    redisCache: redis,
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
  });
  const races = [
    { id: "r1", status: "PENDING", name: "pending", creator: null, winner: null },
    { id: "r2", status: "COMPLETED", name: "complete", creator: null, winner: null },
  ];

  const result = await cache.getStableMembership({
    userId: "u1",
    variant: "legacy",
    load: async () => races,
  });

  assert.deepEqual(result.races, races);
  assert.deepEqual(
    redis.writes.map(({ key, ttlSeconds }) => [key.split(":")[3], ttlSeconds]),
    [
      ["membership", TTL_SECONDS.membership],
      ["completed", TTL_SECONDS.completed],
      ["pending", TTL_SECONDS.pending],
    ],
  );
});

test("cache invalidation advances generation and is fail-open when Redis is disabled", async () => {
  const enabled = buildRaceListInvalidator({
    redisCache: fakeRedis(),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
  });
  assert.equal(await enabled.invalidateUser("u1"), true);

  const disabled = buildRaceListInvalidator({
    redisCache: fakeRedis({ enabled: false }),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
  });
  assert.equal(await disabled.invalidateUser("u1"), true);
});

test("a recovered invalidation does not permanently bypass the local cache", async () => {
  let bypassed = false;
  const derived = {
    isBypassed: () => bypassed,
    ensureSubscribed() {},
    invalidate: async () => false,
  };
  const invalidator = buildRaceListInvalidator({
    redisCache: fakeRedis(),
    derivedCache: derived,
    logger: { log() {} },
  });
  assert.equal(await invalidator.invalidateUser("recovered-user"), false);

  const cache = buildRaceListCache({
    redisCache: fakeRedis({ responses: [[0], [null, null, null]] }),
    derivedCache: {
      ...derived,
      isBypassed: () => bypassed,
    },
    logger: { log() {} },
  });
  const result = await cache.getStableMembership({
    userId: "recovered-user",
    variant: "legacy",
    load: async () => [{ id: "fresh", status: "ACTIVE" }],
  });
  assert.equal(result.source, "postgres");
});

test("cache hit assembles the active, completed, and pending fragments", async () => {
  const stable = (id, status) => ({ id, status, name: id });
  const redis = fakeRedis({ responses: [
    [7],
    [
      { version: 1, races: [stable("active", "ACTIVE")] },
      { version: 1, races: [stable("done", "COMPLETED")] },
      { version: 1, races: [stable("waiting", "PENDING")] },
    ],
    [7],
  ] });
  const cache = buildRaceListCache({ redisCache: redis, derivedCache: fakeDerivedCache(), logger: { log() {} } });
  const result = await cache.getStableMembership({
    userId: "u1",
    variant: "legacy",
    load: async () => { throw new Error("postgres should not run on a hit"); },
  });
  assert.deepEqual(result.races.map((race) => race.id), ["active", "done", "waiting"]);
  assert.equal(result.source, "redis");
});

test("malformed cache entries fail open to the authoritative loader", async () => {
  const redis = fakeRedis({ responses: [[0], [{ version: 1, races: [{ id: "bad" }] }, null, null]] });
  const cache = buildRaceListCache({ redisCache: redis, derivedCache: fakeDerivedCache(), logger: { log() {} } });
  const result = await cache.getStableMembership({
    userId: "u1",
    variant: "legacy",
    load: async () => [{ id: "fresh", status: "ACTIVE" }],
  });
  assert.deepEqual(result.races, [{ id: "fresh", status: "ACTIVE", creator: null, winner: null }]);
  assert.equal(result.source, "postgres");
});

test("Redis read failures fall back without changing the loader result", async () => {
  const cache = buildRaceListCache({
    redisCache: fakeRedis({ throwOnRead: true }),
    derivedCache: fakeDerivedCache(),
    logger: { log() {} },
  });
  await assert.doesNotReject(async () => {
    const result = await cache.getStableMembership({
      userId: "u1",
      variant: "legacy",
      load: async () => [{ id: "fresh", status: "PENDING" }],
    });
      assert.deepEqual(result.races, [{ id: "fresh", status: "PENDING", creator: null, winner: null }]);
  });
});
