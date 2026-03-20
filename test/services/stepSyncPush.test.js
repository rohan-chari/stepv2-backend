const assert = require("node:assert/strict");
const test = require("node:test");

const { buildStepSyncPushService } = require("../../src/services/stepSyncPush");

test("requestStepSyncForUsers sends a silent push for stale users outside the cooldown", async () => {
  const sentNotifications = [];
  const updatedUsers = [];

  const service = buildStepSyncPushService({
    now: () => new Date("2026-03-19T12:00:00.000Z"),
    User: {
      async findById(id) {
        assert.equal(id, "user-1");
        return {
          id,
          lastStepSyncAt: new Date("2026-03-19T10:00:00.000Z"),
          lastSilentPushSentAt: new Date("2026-03-19T10:30:00.000Z"),
        };
      },
      async update(id, fields) {
        updatedUsers.push({ id, fields });
      },
    },
    DeviceToken: {
      async findByUserId(id) {
        assert.equal(id, "user-1");
        return [
          { token: "ios-token-1", platform: "ios" },
          { token: "android-token-1", platform: "android" },
        ];
      },
      async deleteToken() {
        throw new Error("should not delete tokens");
      },
    },
    apnsService: {
      async sendSilentNotification(args) {
        sentNotifications.push(args);
        return { success: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await service.requestStepSyncForUsers(["user-1"]);

  assert.deepEqual(sentNotifications, [
    {
      deviceToken: "ios-token-1",
      payload: { type: "STEP_SYNC_REQUEST" },
    },
  ]);
  assert.deepEqual(updatedUsers, [
    {
      id: "user-1",
      fields: {
        lastSilentPushSentAt: new Date("2026-03-19T12:00:00.000Z"),
      },
    },
  ]);
});

test("requestStepSyncForUsers skips users synced within the last hour", async () => {
  let sendCalled = false;

  const service = buildStepSyncPushService({
    now: () => new Date("2026-03-19T12:00:00.000Z"),
    User: {
      async findById() {
        return {
          id: "user-1",
          lastStepSyncAt: new Date("2026-03-19T11:30:00.000Z"),
          lastSilentPushSentAt: null,
        };
      },
      async update() {
        throw new Error("should not update cooldown");
      },
    },
    DeviceToken: {
      async findByUserId() {
        throw new Error("should not load tokens");
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendSilentNotification() {
        sendCalled = true;
        return { success: true };
      },
    },
  });

  await service.requestStepSyncForUsers(["user-1"]);

  assert.equal(sendCalled, false);
});

test("requestStepSyncForUsers skips users already pushed within the last hour", async () => {
  let sendCalled = false;

  const service = buildStepSyncPushService({
    now: () => new Date("2026-03-19T12:00:00.000Z"),
    User: {
      async findById() {
        return {
          id: "user-1",
          lastStepSyncAt: new Date("2026-03-19T09:00:00.000Z"),
          lastSilentPushSentAt: new Date("2026-03-19T11:15:00.000Z"),
        };
      },
      async update() {
        throw new Error("should not update cooldown");
      },
    },
    DeviceToken: {
      async findByUserId() {
        throw new Error("should not load tokens");
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendSilentNotification() {
        sendCalled = true;
        return { success: true };
      },
    },
  });

  await service.requestStepSyncForUsers(["user-1"]);

  assert.equal(sendCalled, false);
});

test("requestStepSyncForUsers deletes stale tokens and does not stamp cooldown without a success", async () => {
  const deletedTokens = [];
  let updated = false;

  const service = buildStepSyncPushService({
    now: () => new Date("2026-03-19T12:00:00.000Z"),
    User: {
      async findById() {
        return {
          id: "user-1",
          lastStepSyncAt: new Date("2026-03-19T08:00:00.000Z"),
          lastSilentPushSentAt: null,
        };
      },
      async update() {
        updated = true;
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "stale-token", platform: "ios" }];
      },
      async deleteToken(args) {
        deletedTokens.push(args);
      },
    },
    apnsService: {
      async sendSilentNotification() {
        return { success: false, unregistered: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await service.requestStepSyncForUsers(["user-1"]);

  assert.deepEqual(deletedTokens, [
    { userId: "user-1", token: "stale-token" },
  ]);
  assert.equal(updated, false);
});
