// STEP_SYNC_REQUEST is an internal push scheduler contract, not an HTTP route.
// Enter through its public service API while retaining real user/token storage.
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const { cleanDatabase, prisma, createTestUser } = require("./setup");
const {
  buildStepSyncPushService,
} = require("../../src/shared/push/stepSyncPush");

describe("bulk step-sync persistence integration", () => {
  beforeEach(cleanDatabase);

  it("stamps only a successful user and deletes only the exact unregistered tuple", async () => {
    const first = await createTestUser();
    const second = await createTestUser();
    await prisma.deviceToken.createMany({
      data: [
        { userId: first.user.id, token: "shared-token", platform: "ios" },
        { userId: second.user.id, token: "shared-token", platform: "ios" },
      ],
    });
    const attemptedAt = new Date("2026-08-13T15:00:00.000Z");
    let sends = 0;
    const service = buildStepSyncPushService({
      now: () => attemptedAt,
      getPerformanceFlags: () => ({
        stepSyncBulkEnabled: true,
        stepSyncPushConcurrency: 1,
      }),
      apnsService: {
        async sendSilentNotification({ deviceToken }) {
          assert.equal(deviceToken, "shared-token");
          sends += 1;
          return sends === 1
            ? { success: false, unregistered: true }
            : { success: true };
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await service.requestStepSyncForUsers([first.user.id, second.user.id]);
    const tokens = await prisma.deviceToken.findMany();
    assert.equal(tokens.length, 1);
    const users = await prisma.user.findMany({
      where: { id: { in: [first.user.id, second.user.id] } },
      select: { id: true, lastSilentPushSentAt: true },
    });
    const stamped = users.find((row) => row.lastSilentPushSentAt);
    assert.equal(tokens[0].userId, stamped.id);
    assert.equal(stamped.lastSilentPushSentAt.toISOString(), attemptedAt.toISOString());
    assert.equal(
      users.find((row) => row.id !== stamped.id).lastSilentPushSentAt,
      null
    );
  });

  it("cannot move the cooldown timestamp backward when overlapping sends finish in reverse order", async () => {
    const { user } = await createTestUser();
    await prisma.deviceToken.create({
      data: { userId: user.id, token: "overlap-token", platform: "ios" },
    });
    let releaseOlder;
    const olderBlocked = new Promise((resolve) => { releaseOlder = resolve; });
    const older = buildStepSyncPushService({
      now: () => new Date("2026-08-13T15:00:00.000Z"),
      getPerformanceFlags: () => ({ stepSyncBulkEnabled: true, stepSyncPushConcurrency: 1 }),
      apnsService: {
        async sendSilentNotification() {
          await olderBlocked;
          return { success: true };
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    const newer = buildStepSyncPushService({
      now: () => new Date("2026-08-13T16:00:00.000Z"),
      getPerformanceFlags: () => ({ stepSyncBulkEnabled: true, stepSyncPushConcurrency: 1 }),
      apnsService: { async sendSilentNotification() { return { success: true }; } },
      logger: { log() {}, warn() {}, error() {} },
    });

    const olderRun = older.requestStepSyncForUsers([user.id]);
    await new Promise((resolve) => setImmediate(resolve));
    await newer.requestStepSyncForUsers([user.id]);
    releaseOlder();
    await olderRun;
    const persisted = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(
      persisted.lastSilentPushSentAt.toISOString(),
      "2026-08-13T16:00:00.000Z"
    );
  });
});
