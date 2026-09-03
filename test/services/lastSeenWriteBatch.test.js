const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BATCH_SIZE,
  UPDATE_SQL,
  RELEASE_SQL,
  createLastSeenWriteBatch,
} = require("../../src/modules/users/services/lastSeenWriteBatch");

test("simultaneous last-seen writes use one set-based update", async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, payload) {
      calls.push({ sql, payload: JSON.parse(payload) });
      return [];
    },
  };
  const batch = createLastSeenWriteBatch({
    redisCache: { async evalLua() { return { ok: false, result: null }; } },
    drainDelayMs: 0,
  });
  const seenAt = new Date("2026-09-01T12:00:00.000Z");

  await Promise.all(Array.from({ length: 100 }, (_, index) => batch.write({
    prisma,
    id: `user-${index}`,
    fields: {
      lastSeenAt: seenAt,
      ...(index % 2 === 0 ? { lastAppVersion: "2.0.0" } : {}),
    },
  })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, UPDATE_SQL);
  assert.equal(calls[0].payload.length, 100);
  assert.deepEqual(calls[0].payload[0], {
    requestIndex: 0,
    id: "user-0",
    lastSeenAt: seenAt.toISOString(),
    lastAppVersion: "2.0.0",
  });
  assert.deepEqual(calls[0].payload[1], {
    requestIndex: 1,
    id: "user-1",
    lastSeenAt: seenAt.toISOString(),
    lastAppVersion: null,
  });
  assert.match(UPDATE_SQL, /COALESCE\(input\."lastAppVersion", existing\.last_app_version\)/);
  assert.match(UPDATE_SQL, /IS DISTINCT FROM/);
  assert.match(UPDATE_SQL, /FILTER \(WHERE "lastAppVersion" IS NOT NULL\)/);
});

test("a later headerless request cannot discard an earlier app version", async () => {
  let sql;
  const prisma = { async $queryRawUnsafe(query) { sql = query; } };
  const batch = createLastSeenWriteBatch({
    redisCache: { async evalLua() { return { ok: false, result: null }; } },
    drainDelayMs: 20,
  });
  await Promise.all([
    batch.write({ prisma, id: "user-1", fields: {
      lastSeenAt: new Date("2026-09-02T12:00:00Z"), lastAppVersion: "2.3.11",
    } }),
    batch.write({ prisma, id: "user-1", fields: {
      lastSeenAt: new Date("2026-09-02T12:00:01Z"),
    } }),
  ]);
  assert.match(sql, /array_agg\("lastAppVersion"/);
  assert.match(sql, /FILTER \(WHERE "lastAppVersion" IS NOT NULL\)/);
});

test("Redis admission suppresses duplicate daily/version writes across workers", async () => {
  let claims = 0; let writes = 0;
  const redisCache = { async evalLua() {
    claims += 1;
    return { ok: true, result: claims === 1 ? "OK" : null };
  } };
  const prisma = { async $queryRawUnsafe() { writes += 1; } };
  const left = createLastSeenWriteBatch({ redisCache, drainDelayMs: 0 });
  const right = createLastSeenWriteBatch({ redisCache, drainDelayMs: 0 });
  const fields = { lastSeenAt: new Date("2026-09-02T12:00:00Z"), lastAppVersion: "2.3.11" };
  await Promise.all([
    left.write({ prisma, id: "user-1", fields }),
    right.write({ prisma, id: "user-1", fields }),
  ]);
  assert.equal(claims, 2);
  assert.equal(writes, 1);
});

test("a worker that loses Redis admission reports that it did not persist", async () => {
  const batch = createLastSeenWriteBatch({
    redisCache: { async evalLua() { return { ok: true, result: null }; } },
    drainDelayMs: 0,
  });
  const persisted = await batch.write({
    prisma: { async $queryRawUnsafe() { assert.fail("loser must not write"); } },
    id: "user-1",
    fields: { lastSeenAt: new Date("2026-09-02T12:00:00Z") },
  });
  assert.equal(persisted, false);
});

test("database failure releases only the matching Redis claim token", async () => {
  const calls = [];
  const redisCache = { async evalLua(sql, keys, args) {
    calls.push({ sql, keys, args });
    return { ok: true, result: sql === RELEASE_SQL ? 1 : "OK" };
  } };
  const batch = createLastSeenWriteBatch({ redisCache, drainDelayMs: 0 });
  await assert.rejects(batch.write({
    prisma: { async $queryRawUnsafe() { throw new Error("db down"); } },
    id: "user-1",
    fields: { lastSeenAt: new Date("2026-09-02T12:00:00Z") },
  }), /db down/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].sql, RELEASE_SQL);
  assert.equal(calls[1].keys[0], calls[0].keys[0]);
  assert.equal(calls[1].args[0], calls[0].args[0]);
});

test("last-seen writes remain bounded and reject together on database failure", async () => {
  let calls = 0;
  const error = new Error("database unavailable");
  const prisma = { async $queryRawUnsafe() { calls += 1; throw error; } };
  const batch = createLastSeenWriteBatch({
    redisCache: { async evalLua() { return { ok: false, result: null }; } },
    drainDelayMs: 0,
  });

  const outcomes = await Promise.allSettled(Array.from(
    { length: BATCH_SIZE + 1 },
    (_, index) => batch.write({
      prisma,
      id: `user-${index}`,
      fields: { lastSeenAt: new Date(0) },
    }),
  ));

  assert.equal(calls, 1);
  assert.equal(outcomes.every((outcome) => outcome.status === "rejected"), true);
  assert.equal(outcomes.every((outcome) => outcome.reason === error), true);
});

test("last-seen coalescing includes arrivals from later event-loop turns", async () => {
  const calls = [];
  const batch = createLastSeenWriteBatch({
    redisCache: { async evalLua() { return { ok: false, result: null }; } },
    drainDelayMs: 40,
  });
  const prisma = { async $queryRawUnsafe(sql, payload) {
    calls.push(JSON.parse(payload));
  } };
  const first = batch.write({ prisma, id: "user-1", fields: { lastSeenAt: new Date(0) } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = batch.write({ prisma, id: "user-2", fields: { lastSeenAt: new Date(0) } });
  await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
});
