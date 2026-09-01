const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceParticipantPresentationRead,
} = require("../../src/modules/races/services/raceParticipantPresentationRead");

test("race-list leaders use the shared presentation cache instead of relation hydration", async () => {
  const calls = [];
  const service = buildRaceParticipantPresentationRead({
    prisma: { raceParticipant: { async findMany() { throw new Error("unexpected"); } } },
    presentationCache: {
      async getMany(ids, enabled) {
        calls.push({ ids, enabled });
        return new Map(ids.map((id) => [id, { id, displayName: id, equippedAccessories: [] }]));
      },
    },
  });

  const rows = await service.findPresentationsByUserIds(["u2", "u1", "u2"]);
  assert.deepEqual(calls, [{ ids: ["u2", "u1"], enabled: true }]);
  assert.deepEqual(rows.map((row) => row.id), ["u2", "u1"]);
});

test("podium reads participant scalars once and hydrates users through the shared cache", async () => {
  const participantCalls = [];
  const service = buildRaceParticipantPresentationRead({
    prisma: {
      raceParticipant: {
        async findMany(args) {
          participantCalls.push(args);
          return [
            { id: "p1", raceId: "r1", userId: "u1", totalSteps: 12, placement: 1, payoutCoins: 3 },
            { id: "p2", raceId: "r1", userId: "u2", totalSteps: 10, placement: 2, payoutCoins: 1 },
          ];
        },
      },
    },
    presentationCache: {
      async getMany(ids) {
        return new Map(ids.map((id) => [id, { id, displayName: `name-${id}`, equippedAccessories: [] }]));
      },
    },
  });

  const rows = await service.findPodiumForRaces(["r1"]);
  assert.equal(participantCalls.length, 1);
  assert.equal(participantCalls[0].include, undefined);
  assert.equal(participantCalls[0].select, undefined);
  assert.equal(rows[0].user.displayName, "name-u1");
  assert.equal(rows[1].user.displayName, "name-u2");
});
