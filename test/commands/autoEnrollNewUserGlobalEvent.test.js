const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAutoEnrollNewUser,
} = require("../../src/modules/races/commands/autoEnrollNewUser");

// Legacy-global event impact creation was retired with local entitlements.
// Keep the permanent enrollment fencing invariant here.

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
