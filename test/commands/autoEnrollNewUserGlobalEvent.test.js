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
        async $queryRaw() {},
        race: {
          async findUnique() {
            return { status: race.status, maxParticipants: race.maxParticipants };
          },
        },
        raceParticipant: {
          async count() { return 0; },
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

  await buildAutoEnrollNewUser({
    prisma: db,
    eventBus: { emit() {} },
    acquireRaceWriteFence: async () => null,
    lockFundedExposureUsers: async () => null,
    lockCompetitionRows: async () => null,
  })({
    user: { id: "user-1", appleId: "apple-1" },
  });

  assert.equal(transactions, 1);
  assert.deepEqual(impacts, [{
    eventId: "event-1", raceId: "race-1", userId: "user-1", status: "PENDING",
  }]);
});

test("pending non-funded auto enrollment still uses C0 and the user guard", async () => {
  const calls = [];
  const race = {
    id: "pending-race",
    status: "PENDING",
    fundedPrize: false,
    maxParticipants: 10,
    powerupsEnabled: false,
  };
  const db = {
    user: { async update() {} },
    race: { async findMany() { return [race]; } },
    raceParticipant: {
      async count() { return 0; },
      async create() { assert.fail("membership must be written inside the fenced transaction"); },
    },
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe() {},
        async $queryRaw() {},
        race: {
          async findUnique() {
            return { status: "PENDING", maxParticipants: 10 };
          },
        },
        raceParticipant: {
          async count() { return 0; },
          async create() { calls.push("create"); return { id: "participant" }; },
        },
      });
    },
  };

  await buildAutoEnrollNewUser({
    prisma: db,
    eventBus: { emit() {} },
    acquireRaceWriteFence: async () => { calls.push("c0"); },
    lockFundedExposureUsers: async () => { calls.push("user"); },
    lockCompetitionRows: async () => null,
  })({ user: { id: "user-1", appleId: "apple-1" } });

  assert.deepEqual(calls, ["c0", "user", "create"]);
});
