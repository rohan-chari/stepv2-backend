const assert = require("node:assert/strict");
const test = require("node:test");

const { PowerupUsageState } = require("../../../src/modules/powerups/models/powerupUsageState");

test("rebaseDecoyConsumedMany batches cooldown updates for AoE pops", async () => {
  const calls = [];
  const db = {
    powerupUsageState: {
      async updateMany(args) {
        calls.push({ method: "updateMany", args });
        return { count: 2 };
      },
      async createMany(args) {
        calls.push({ method: "createMany", args });
        return { count: 0 };
      },
    },
  };
  const consumedAt = new Date("2026-09-19T14:00:00.000Z");
  const nextUsableAt = new Date("2026-09-19T15:00:00.000Z");

  await PowerupUsageState.rebaseDecoyConsumedMany({
    db,
    raceId: "race-1",
    consumptions: [
      { userId: "user-2", sourcePowerupId: "decoy-2" },
      { userId: "user-3", sourcePowerupId: "decoy-3" },
    ],
    consumedAt,
    nextUsableAt,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "updateMany");
  assert.deepEqual(calls[0].args.where, {
    raceId: "race-1",
    powerupType: "DECOY",
    userId: { in: ["user-2", "user-3"] },
  });
  assert.deepEqual(calls[0].args.data, { activeUntil: consumedAt, nextUsableAt });

  assert.equal(calls[1].method, "createMany");
  assert.equal(calls[1].args.skipDuplicates, true);
  assert.deepEqual(
    calls[1].args.data.map((row) => ({
      userId: row.userId,
      sourcePowerupId: row.sourcePowerupId,
      activeUntil: row.activeUntil,
      nextUsableAt: row.nextUsableAt,
    })),
    [
      { userId: "user-2", sourcePowerupId: "decoy-2", activeUntil: consumedAt, nextUsableAt },
      { userId: "user-3", sourcePowerupId: "decoy-3", activeUntil: consumedAt, nextUsableAt },
    ],
  );
});
