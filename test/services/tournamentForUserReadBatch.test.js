const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTournamentForUserReadBatch,
} = require("../../src/modules/tournaments/services/tournamentForUserReadBatch");

test("tournament list reads collapse concurrent viewers and preserve membership filtering", async () => {
  let calls = 0;
  const prisma = { tournament: { async findMany({ where }) {
    calls += 1;
    assert.deepEqual(new Set(where.participants.some.userId.in), new Set(["u1", "u2"]));
    return [
      { id: "active", status: "ACTIVE", participants: [
        { userId: "u1", status: "ACCEPTED" },
        { userId: "u2", status: "DECLINED" },
      ] },
      { id: "pending", status: "PENDING", participants: [
        { userId: "u2", status: "INVITED" },
      ] },
    ];
  } } };
  const batch = createTournamentForUserReadBatch();
  const [one, two] = await Promise.all([
    batch.load({ prisma, userId: "u1", include: { participants: true } }),
    batch.load({ prisma, userId: "u2", include: { participants: true } }),
  ]);
  assert.deepEqual(one.map((row) => row.id), ["active"]);
  assert.deepEqual(two.map((row) => row.id), ["pending"]);
  assert.equal(calls, 1);
});
