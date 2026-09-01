const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BATCH_SIZE,
  UPDATE_SQL,
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
  const batch = createLastSeenWriteBatch();
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
});

test("last-seen writes remain bounded and reject together on database failure", async () => {
  let calls = 0;
  const error = new Error("database unavailable");
  const prisma = { async $queryRawUnsafe() { calls += 1; throw error; } };
  const batch = createLastSeenWriteBatch();

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
