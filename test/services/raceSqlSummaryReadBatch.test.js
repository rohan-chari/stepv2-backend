const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaceSqlSummaryReadBatch,
  raceSqlSummaryBatchKey,
} = require("../../src/modules/races/services/raceSqlSummaryReadBatch");

test("simultaneous viewers rank an identical race set once", async () => {
  const calls = [];
  const prisma = {};
  const batch = createRaceSqlSummaryReadBatch();
  const execute = async (userIds) => {
    calls.push(userIds);
    return userIds.flatMap((viewerUserId) => [
      { viewerUserId, raceId: "race-a" },
      { viewerUserId, raceId: "race-b" },
    ]);
  };
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) =>
    batch.load({
      prisma,
      raceSetKey: "race-a\u0000race-b",
      userId: `user-${index}`,
      execute,
    })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 50);
  assert.ok(results.every((rows, index) =>
    rows.length === 2 && rows.every((row) => row.viewerUserId === `user-${index}`)));
});

test("completed result versions cannot share a viewer batch", async () => {
  const calls = [];
  const prisma = {};
  const batch = createRaceSqlSummaryReadBatch();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const v1 = [{
    id: "race-a",
    status: "COMPLETED",
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  }];
  const v2 = [{
    id: "race-a",
    status: "COMPLETED",
    updatedAt: new Date("2026-09-01T12:00:01.000Z"),
  }];
  const execute = (version) => async (userIds) => {
    calls.push({ version, userIds });
    await gate;
    return userIds.map((viewerUserId) => ({
      viewerUserId,
      raceId: "race-a",
      acceptedCount: version,
    }));
  };

  const first = batch.load({
    prisma,
    raceSetKey: raceSqlSummaryBatchKey(v1),
    userId: "user-1",
    execute: execute(1),
  });
  const second = batch.load({
    prisma,
    raceSetKey: raceSqlSummaryBatchKey(v2),
    userId: "user-2",
    execute: execute(2),
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();

  const [firstRows, secondRows] = await Promise.all([first, second]);
  assert.equal(calls.length, 2);
  assert.equal(firstRows[0].acceptedCount, 1);
  assert.equal(secondRows[0].acceptedCount, 2);
  assert.notEqual(raceSqlSummaryBatchKey(v1), raceSqlSummaryBatchKey(v2));
});

test("status changes alter the SQL summary batch identity", () => {
  const updatedAt = new Date("2026-09-01T12:00:00.000Z");
  assert.notEqual(
    raceSqlSummaryBatchKey([{ id: "race-a", status: "ACTIVE", updatedAt }]),
    raceSqlSummaryBatchKey([{ id: "race-a", status: "COMPLETED", updatedAt }]),
  );
});
