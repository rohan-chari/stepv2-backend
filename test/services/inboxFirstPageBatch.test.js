const test = require("node:test");
const assert = require("node:assert/strict");

const { createInboxFirstPageBatch } = require("../../src/modules/inbox/services/inboxFirstPageBatch");

test("simultaneous first inbox pages use one page query and one outbox hydration", async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(_sql, requestsJson) {
      calls.push("pages");
      return JSON.parse(requestsJson).map((request) => ({
        requestUserId: request.userId,
        unreadCount: 2n,
        supportUnreadCount: 1n,
        id: `alert-${request.userId}`,
        userId: request.userId,
        type: "TEST",
        destination: { route: "home" },
        title: "Title",
        body: "Body",
        sourceKey: `source-${request.userId}`,
        readAt: null,
        createdAt: new Date(0),
        expiresAt: new Date(1),
      }));
    },
    inboxDeliveryOutbox: { async findMany(args) {
      calls.push("outbox");
      return args.where.alertId.in.map((alertId) => ({
        alertId, kind: "PUSH", payload: {},
      }));
    } },
  };
  const batch = createInboxFirstPageBatch();
  const users = Array.from({ length: 50 }, (_, index) => `user-${index}`);

  const results = await Promise.all(users.map((userId) => batch.load({
    prisma, userId, now: new Date(), limit: 25,
  })));

  assert.equal(calls.filter((call) => call === "pages").length, 1);
  assert.equal(calls.filter((call) => call === "outbox").length, 1);
  assert.ok(results.every((result, index) =>
    result.rows.length === 1 &&
    result.rows[0].userId === users[index] &&
    result.rows[0].outbox.length === 1 &&
    result.unreadCount === 2 && result.totalUnreadCount === 3));
});
