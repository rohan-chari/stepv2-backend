const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPendingEnrollments,
  enrollIfGlobalEventActive,
} = require("../../src/modules/steps/services/globalEventEnrollment");

test("global enrollment writes one PENDING row per distinct race/user", async () => {
  const calls = [];
  const tx = {
    globalEventRaceImpact: {
      async createMany(input) { calls.push(input); return { count: input.data.length }; },
    },
  };

  const created = await createPendingEnrollments(tx, {
    eventId: "event-1", raceId: "race-1", userIds: ["user-b", "user-a", "user-b", null],
  });

  assert.equal(created, 2);
  assert.deepEqual(calls[0], {
    data: [
      { eventId: "event-1", raceId: "race-1", userId: "user-a", status: "PENDING" },
      { eventId: "event-1", raceId: "race-1", userId: "user-b", status: "PENDING" },
    ],
    skipDuplicates: true,
  });
});

test("late joins enroll only while a global event is active", async () => {
  const writes = [];
  const activeTx = {
    globalStepEvent: {
      async findFirst(input) {
        assert.equal(input.where.startsAt.lte.toISOString(), "2026-08-17T12:00:00.000Z");
        return { id: "event-1" };
      },
    },
    globalEventRaceImpact: {
      async createMany(input) { writes.push(input); return { count: 1 }; },
    },
  };
  const event = await enrollIfGlobalEventActive(activeTx, {
    raceId: "race-1", userIds: ["user-1"], at: new Date("2026-08-17T12:00:00.000Z"),
  });
  assert.equal(event.id, "event-1");
  assert.equal(writes.length, 1);

  const inactiveTx = {
    globalStepEvent: { async findFirst() { return null; } },
    globalEventRaceImpact: { async createMany() { throw new Error("must not write"); } },
  };
  assert.equal(await enrollIfGlobalEventActive(inactiveTx, {
    raceId: "race-1", userIds: ["user-1"], at: new Date(),
  }), null);
});
