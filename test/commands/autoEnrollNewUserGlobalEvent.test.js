const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAutoEnrollNewUser,
} = require("../../src/modules/races/commands/autoEnrollNewUser");

test("active seeded-race auto enrollment creates participant and event impact in one transaction", async () => {
  const impacts = [];
  let transactions = 0;
  const race = {
    id: "race-1", status: "ACTIVE", maxParticipants: 10,
    powerupsEnabled: false, startedAt: new Date("2026-08-20T13:00:00Z"),
  };
  const db = {
    user: { async update() {} },
    race: { async findMany() { return [race]; } },
    raceParticipant: {
      async count() { return 0; },
      async create() { assert.fail("active membership must not commit outside the transaction"); },
    },
    async $transaction(callback) {
      transactions += 1;
      return callback({
        async $executeRawUnsafe() {},
        raceParticipant: {
          async create() {
            return { id: "participant-1", raceId: race.id, userId: "user-1" };
          },
        },
        globalStepEvent: {
          async findFirst() {
            return { id: "event-1", scheduleMode: "LEGACY_GLOBAL" };
          },
        },
        globalEventRaceImpact: {
          async createMany({ data }) { impacts.push(...data); return { count: data.length }; },
        },
      });
    },
  };

  await buildAutoEnrollNewUser({ prisma: db, eventBus: { emit() {} } })({
    user: { id: "user-1", appleId: "apple-1" },
  });

  assert.equal(transactions, 1);
  assert.deepEqual(impacts, [{
    eventId: "event-1", raceId: "race-1", userId: "user-1", status: "PENDING",
  }]);
});
