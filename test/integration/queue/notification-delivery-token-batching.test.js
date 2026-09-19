const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const { cleanDatabase, prisma, createTestUser } = require("../setup");
const { DeviceToken } = require("../../../src/shared/push/deviceToken");

describe("notification delivery token batches", () => {
  beforeEach(async () => { await cleanDatabase(); });

  it("matches each user's token order and limit with one shared-status read and one SQL lookup", async () => {
    const users = [(await createTestUser()).user, (await createTestUser()).user];
    const now = new Date();
    const tokens = users.flatMap((user) => [
      ...Array.from({ length: 12 }, (_, index) => ({
        userId: user.id, token: `${user.id}-${index}`, platform: "ios", status: "ACTIVE",
        lastRegisteredAt: new Date(now.getTime() - index * 1000), updatedAt: now,
      })),
      { userId: user.id, token: `${user.id}-legacy`, platform: "ios", status: null, lastRegisteredAt: null, updatedAt: now },
      { userId: user.id, token: `${user.id}-revoked`, platform: "ios", status: "REVOKED", lastRegisteredAt: null, updatedAt: now },
    ]);
    await prisma.deviceToken.createMany({ data: tokens });
    const expected = new Map();
    for (const user of users) expected.set(user.id, (await DeviceToken.findByUserId(user.id)).map((row) => row.id));

    let statusReads = 0;
    let tokenReads = 0;
    const client = {
      globalStepEventGenerationState: {
        async findUnique(args) {
          statusReads += 1;
          return prisma.globalStepEventGenerationState.findUnique(args);
        },
      },
      async $queryRawUnsafe(...args) {
        tokenReads += 1;
        return prisma.$queryRawUnsafe(...args);
      },
    };
    const actual = await DeviceToken.findForDeliveryByUserIds([users[0].id, users[1].id, users[0].id], client);
    assert.equal(statusReads, 1);
    assert.equal(tokenReads, 1);
    assert.equal(actual.length, 20);
    for (const user of users) {
      assert.deepEqual(actual.filter((row) => row.userId === user.id).map((row) => row.id), expected.get(user.id));
    }
    assert.ok(actual.every((row) => !row.token.endsWith("-revoked")));

    // Check the same SQL with quarantine active without mutating global state.
    const quarantined = await DeviceToken.findForDeliveryByUserIds(users.map((user) => user.id), {
      ...client,
      globalStepEventGenerationState: { async findUnique() { return { quarantineStartedAt: now }; } },
    });
    assert.equal(quarantined.length, 20);
    assert.ok(quarantined.every((row) => !row.token.endsWith("-legacy") && !row.token.endsWith("-revoked")));
  });
});
