const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAutoJoinFeaturedRaces,
} = require("../../src/modules/races/commands/autoJoinFeaturedRaces");

test("non-funded featured auto-join fences each membership and enrolls ACTIVE global events", async () => {
  const calls = [];
  const race = {
    id: "active-seeded-race",
    seedId: null,
    status: "ACTIVE",
    fundedPrize: false,
    maxParticipants: 10,
  };
  const prisma = {
    user: { async findMany() { return [{ id: "user-1" }]; } },
    raceParticipant: {
      async count() { return 0; },
      async createMany() { assert.fail("membership must not use the unfenced bulk writer"); },
    },
    async $transaction(callback) {
      return callback({
        async $executeRawUnsafe() {},
        async $queryRaw() {},
        race: {
          async findUnique() { return { status: "ACTIVE", maxParticipants: 10 }; },
        },
        raceParticipant: {
          async findUnique() { return null; },
          async count() { return 0; },
          async createMany() { calls.push("create"); return { count: 1 }; },
        },
      });
    },
  };
  const { enrollAutoJoinUsers } = buildAutoJoinFeaturedRaces({
    prisma,
    appSettings: { async getFlag() { return false; } },
    logger: { warn() {}, error() {} },
    acquireRaceWriteFence: async () => { calls.push("c0"); },
    acquireGlobalEnrollmentLock: async () => { calls.push("global"); },
    lockFundedExposureUsers: async () => { calls.push("user"); },
    lockCompetitionRows: async () => { calls.push("competition"); },
    enrollIfGlobalEventActive: async () => { calls.push("global-enroll"); },
  });

  assert.equal(
    await enrollAutoJoinUsers({ ...race, kind: "DAILY_10K" }),
    1,
  );
  assert.deepEqual(calls, [
    "c0",
    "global",
    "user",
    "competition",
    "create",
    "global-enroll",
  ]);
});
