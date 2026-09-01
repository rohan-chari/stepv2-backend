const assert = require("node:assert/strict");
const test = require("node:test");

const {
  hydrateRaceListPeople,
} = require("../../src/modules/races/models/race");

test("stable race-list rows hydrate repeated creators and winners through one shared cache read", async () => {
  const calls = [];
  const races = [
    { id: "r1", creatorId: "u1", winnerUserId: "u2" },
    { id: "r2", creatorId: "u1", winnerUserId: null },
  ];
  const result = await hydrateRaceListPeople(races, {
    async getMany(ids, enabled) {
      calls.push({ ids, enabled });
      return new Map(ids.map((id) => [id, {
        id, displayName: `name-${id}`, profilePhotoUrl: null,
      }]));
    },
  });

  assert.deepEqual(calls, [{ ids: ["u1", "u2"], enabled: true }]);
  assert.equal(result[0].creator.displayName, "name-u1");
  assert.equal(result[0].winner.displayName, "name-u2");
  assert.equal(result[1].creator.displayName, "name-u1");
  assert.equal(result[1].winner, null);
});
