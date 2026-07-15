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

// Helper: a service whose only observable output is whether a send happened, for
// the throttle-window tests below.
function buildProbeService({ now, lastStepSyncAt, lastSilentPushSentAt }) {
  const state = { sendCalled: false };
  const service = buildStepSyncPushService({
    now: () => now,
    User: {
      async findById() {
        return { id: "user-1", lastStepSyncAt, lastSilentPushSentAt };
      },
      async update() {},
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "ios-token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendSilentNotification() {
        state.sendCalled = true;
        return { success: true };
      },
    },
    logger: { warn() {}, error() {} },
  });
  return { service, state };
}

test("custom minIntervalMs (30min): pushed 40min ago -> sends", async () => {
  const { service, state } = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:20:00.000Z"), // 40 min ago
  });

  await service.requestStepSyncForUser("user-1", { minIntervalMs: 30 * 60 * 1000 });

  assert.equal(state.sendCalled, true);
});

test("custom minIntervalMs (30min): pushed 20min ago -> skips", async () => {
  const { service, state } = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:40:00.000Z"), // 20 min ago
  });

  await service.requestStepSyncForUser("user-1", { minIntervalMs: 30 * 60 * 1000 });

  assert.equal(state.sendCalled, false);
});

test("custom minIntervalMs applies to lastStepSyncAt too (synced 20min ago + 30min -> skips)", async () => {
  const { service, state } = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: new Date("2026-03-19T11:40:00.000Z"), // 20 min ago
    lastSilentPushSentAt: null,
  });

  await service.requestStepSyncForUser("user-1", { minIntervalMs: 30 * 60 * 1000 });

  assert.equal(state.sendCalled, false);
});

test("default (no options) still uses the 1-hour window: pushed 40min ago -> skips", async () => {
  const { service, state } = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:20:00.000Z"), // 40 min ago
  });

  await service.requestStepSyncForUser("user-1");

  assert.equal(state.sendCalled, false);
});

test("minIntervalMs is clamped to a 15-minute floor (10min request behaves as 15min)", async () => {
  // Pushed 12 min ago: below the 15-min floor, so a clamped service must still skip
  // even though the caller asked for a 10-min window.
  const skip = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:48:00.000Z"), // 12 min ago
  });
  await skip.service.requestStepSyncForUser("user-1", { minIntervalMs: 10 * 60 * 1000 });
  assert.equal(skip.state.sendCalled, false);

  // Pushed 18 min ago: outside the 15-min floor -> sends.
  const send = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:42:00.000Z"), // 18 min ago
  });
  await send.service.requestStepSyncForUser("user-1", { minIntervalMs: 10 * 60 * 1000 });
  assert.equal(send.state.sendCalled, true);
});

test("requestStepSyncForUsers passes minIntervalMs through to each user", async () => {
  const { service, state } = buildProbeService({
    now: new Date("2026-03-19T12:00:00.000Z"),
    lastStepSyncAt: null,
    lastSilentPushSentAt: new Date("2026-03-19T11:20:00.000Z"), // 40 min ago
  });

  // Default window (1h) would skip; the 30-min override should send.
  await service.requestStepSyncForUsers(["user-1"], { minIntervalMs: 30 * 60 * 1000 });

  assert.equal(state.sendCalled, true);
});
