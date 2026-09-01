const test = require("node:test");
const assert = require("node:assert/strict");

const { createAuthShellAggregateBatch } = require("../../src/modules/users/services/authShellAggregateBatch");

test("auth shell aggregates for a launch wave use two bounded grouped reads", async () => {
  const calls = [];
  const prisma = {
    raceParticipant: { async groupBy(args) {
      calls.push(["held", args]);
      return args.where.userId.in.map((userId) => ({ userId, _sum: { buyInAmount: 7 } }));
    } },
    friendship: { async groupBy(args) {
      calls.push(["friends", args]);
      return args.where.addresseeId.in.map((addresseeId) => ({ addresseeId, _count: { _all: 2 } }));
    } },
  };
  const batch = createAuthShellAggregateBatch();
  const users = Array.from({ length: 100 }, (_, index) => `user-${index}`);

  const results = await Promise.all(users.map((userId) => batch.load({ prisma, userId })));

  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, args]) =>
    (args.where.userId?.in || args.where.addresseeId?.in).length === 100));
  assert.ok(results.every((result) =>
    result.heldCoins === 7 && result.incomingFriendRequests === 2));
});
