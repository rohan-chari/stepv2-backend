const assert = require("node:assert/strict");
const test = require("node:test");

const {
  upsertDailyStep,
} = require("../../src/modules/steps/services/stepInputIntake");

test("daily classification and persistence use one database round trip", async () => {
  const calls = [];
  const record = {
    id: "step-1",
    userId: "user-1",
    steps: 123,
    stepGoal: null,
    date: new Date("2026-09-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    existed: true,
    storageChanged: true,
  };
  const tx = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [record];
    },
  };

  const result = await upsertDailyStep(tx, {
    userId: "user-1",
    date: "2026-09-01",
    steps: 123,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO steps/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id,date\) DO UPDATE/);
  assert.deepEqual(result, {
    record: {
      id: record.id,
      userId: record.userId,
      steps: record.steps,
      stepGoal: record.stepGoal,
      date: record.date,
      createdAt: record.createdAt,
    },
    existed: true,
    storageChanged: true,
  });
});
