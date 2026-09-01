const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createLastStepSyncWriteBatch,
} = require("../../src/modules/steps/services/lastStepSyncWriteBatch");

describe("last-step-sync write batch", () => {
  it("coalesces concurrent stamps into one set-based database update", async () => {
    const calls = [];
    const prisma = {
      $executeRawUnsafe: async (...args) => {
        calls.push(args);
        return 2;
      },
    };
    const batch = createLastStepSyncWriteBatch();
    const earlier = new Date("2026-09-01T12:00:00.000Z");
    const later = new Date("2026-09-01T12:00:01.000Z");

    await Promise.all([
      batch.stamp({ prisma, userId: "user-a", at: earlier }),
      batch.stamp({ prisma, userId: "user-a", at: later }),
      batch.stamp({ prisma, userId: "user-b", at: earlier }),
    ]);

    assert.equal(calls.length, 1);
    const payload = JSON.parse(calls[0][1]);
    assert.deepEqual(payload, [
      { userId: "user-a", at: later.toISOString() },
      { userId: "user-b", at: earlier.toISOString() },
    ]);
  });

  it("rejects every waiter when the shared update fails", async () => {
    const expected = new Error("database unavailable");
    const prisma = { $executeRawUnsafe: async () => { throw expected; } };
    const batch = createLastStepSyncWriteBatch();
    const settled = await Promise.allSettled([
      batch.stamp({ prisma, userId: "user-a", at: new Date() }),
      batch.stamp({ prisma, userId: "user-b", at: new Date() }),
    ]);
    assert.deepEqual(settled.map((entry) => entry.status), ["rejected", "rejected"]);
    assert.equal(settled[0].reason, expected);
    assert.equal(settled[1].reason, expected);
  });
});
