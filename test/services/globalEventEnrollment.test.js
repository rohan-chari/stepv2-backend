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

test("late enrollment scans every local parent before returning the active match", async () => {
  const writes = [];
  const visitedParents = [];
  const now = new Date("2026-08-20T12:10:00.000Z");
  const parents = [
    { id: "today", scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2026-08-20" },
    { id: "tomorrow", scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2026-08-21" },
  ];
  const entitlements = new Map([
    ["today", {
      id: "ent-today", eventId: "today", userId: "user-1",
      startsAt: new Date("2026-08-20T12:00:00.000Z"),
      endsAt: new Date("2026-08-20T12:30:00.000Z"),
      startOutcome: "NO_ACTIVE_RACES", startProcessedAt: now,
    }],
    ["tomorrow", {
      id: "ent-tomorrow", eventId: "tomorrow", userId: "user-1",
      startsAt: new Date("2026-08-21T12:00:00.000Z"),
      endsAt: new Date("2026-08-21T12:30:00.000Z"),
      startOutcome: "PENDING", startProcessedAt: null,
    }],
  ]);
  const tx = {
    async $executeRawUnsafe() {},
    globalStepEvent: {
      async findFirst() { return null; },
      async findMany() { return parents; },
    },
    globalEventRaceImpact: {
      async createMany({ data }) { writes.push(...data); return { count: data.length }; },
    },
    globalStepEventEntitlement: {
      async findUnique({ where }) {
        visitedParents.push(where.eventId_userId.eventId);
        return entitlements.get(where.eventId_userId.eventId) || null;
      },
      async updateMany({ where, data }) {
        const row = [...entitlements.values()].find((item) => item.id === where.id);
        Object.assign(row, data);
        return { count: row ? 1 : 0 };
      },
    },
    user: {
      async findUnique() {
        return { id: "user-1", timezone: "UTC", globalEventTimezone: "UTC" };
      },
    },
  };

  const matched = await enrollIfGlobalEventActive(tx, {
    raceId: "race-1", userIds: ["user-1"], at: now,
  });

  assert.equal(matched.id, "today");
  assert.deepEqual(visitedParents, ["today", "tomorrow"]);
  assert.deepEqual(writes, [{
    eventId: "today", raceId: "race-1", userId: "user-1", status: "PENDING",
  }]);
  assert.equal(entitlements.get("today").startOutcome, "ACTIVATED_LATE_JOIN");
  assert.equal(entitlements.get("tomorrow").startOutcome, "PENDING");
});
