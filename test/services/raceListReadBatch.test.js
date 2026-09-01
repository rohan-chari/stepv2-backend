const test = require("node:test");
const assert = require("node:assert/strict");

const { createRaceListReadBatch } = require("../../src/modules/races/services/raceListReadBatch");

test("simultaneous race lists share bounded participant reads and remain user-scoped", async () => {
  const calls = [];
  const prisma = { raceParticipant: { async findMany(args) {
    calls.push(args);
    return args.where.userId.in.map((userId) => ({
      id: `participant-${userId}`,
      userId,
      raceId: "race-1",
      status: "ACCEPTED",
      race: { id: "race-1", status: "ACTIVE", updatedAt: new Date(0) },
    }));
  } } };
  const batch = createRaceListReadBatch();
  const userIds = Array.from({ length: 100 }, (_, index) => `user-${index}`);

  const results = await Promise.all(userIds.map((userId) => batch.loadRows({
    prisma,
    userId,
    select: { id: true, userId: true, race: { select: { id: true } } },
  })));

  assert.equal(calls.length, 1, "a launch cohort shares one bounded 128-user query page");
  assert.ok(calls.every((call) => call.where.userId.in.length <= 128));
  assert.ok(results.every((rows, index) =>
    rows.length === 1 && rows[0].userId === userIds[index]));
});
