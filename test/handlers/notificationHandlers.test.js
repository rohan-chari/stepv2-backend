const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerNotificationHandlers,
} = require("../../src/handlers/notificationHandlers");

function createMockEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    async emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) {
        await fn(data);
      }
    },
  };
}

test("sends push to challenged user with correct title/body/payload", async () => {
  const eventBus = createMockEventBus();
  let sentNotification;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById(id) {
        return { id, displayName: "Trail Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "device-token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotification = args;
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.equal(sentNotification.deviceToken, "device-token-1");
  assert.equal(sentNotification.title, "New Challenge");
  assert.equal(sentNotification.body, "Trail Walker challenged you!");
  assert.deepEqual(sentNotification.payload, {
    type: "CHALLENGE_INITIATED",
    route: "challenge_detail",
    params: { instanceId: "inst-1" },
  });
});

test("sends to all device tokens for a user", async () => {
  const eventBus = createMockEventBus();
  const sentTokens = [];

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        return { displayName: "Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [
          { token: "token-a", platform: "ios" },
          { token: "token-b", platform: "android" },
        ];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification({ deviceToken }) {
        sentTokens.push(deviceToken);
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.deepEqual(sentTokens, ["token-a", "token-b"]);
});

test('uses "Someone" when challenger has no displayName', async () => {
  const eventBus = createMockEventBus();
  let sentBody;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        return { id: "user-1", displayName: null };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification({ body }) {
        sentBody = body;
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.equal(sentBody, "Someone challenged you!");
});

test("no-op when challenged user has no device tokens", async () => {
  const eventBus = createMockEventBus();
  let sendCalled = false;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        return { displayName: "Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        sendCalled = true;
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.equal(sendCalled, false);
});

test("deletes stale token on unregistered response", async () => {
  const eventBus = createMockEventBus();
  let deletedArgs;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        return { displayName: "Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "stale-token", platform: "ios" }];
      },
      async deleteToken(args) {
        deletedArgs = args;
      },
    },
    apnsService: {
      async sendNotification() {
        return { success: false, unregistered: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.deepEqual(deletedArgs, {
    userId: "user-2",
    token: "stale-token",
  });
});

test("logs push failure details when APNs returns unsuccessful result", async () => {
  const eventBus = createMockEventBus();
  const warnings = [];

  registerNotificationHandlers({
    eventBus,
    logger: {
      warn(message, meta) {
        warnings.push({ message, meta });
      },
      error() {},
    },
    User: {
      async findById() {
        return { displayName: "Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "prod-token-1234", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        return {
          success: false,
          reason: "APNS signing key missing",
          statusCode: 500,
        };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /CHALLENGE_INITIATED/);
  assert.equal(warnings[0].meta.reason, "APNS signing key missing");
  assert.equal(warnings[0].meta.statusCode, 500);
  assert.equal(warnings[0].meta.deviceTokenSuffix, "oken-1234");
});

test("FRIEND_REQUEST_SENT sends push to addressee with friends route payload", async () => {
  const eventBus = createMockEventBus();
  let sentNotification;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById(id) {
        return { id, displayName: "Trail Walker" };
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        assert.equal(userId, "user-2");
        return [{ token: "friend-token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotification = args;
        return { success: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await eventBus.emit("FRIEND_REQUEST_SENT", {
    userId: "user-1",
    addresseeId: "user-2",
  });

  assert.equal(sentNotification.deviceToken, "friend-token-1");
  assert.equal(sentNotification.title, "New Friend Request");
  assert.equal(sentNotification.body, "Trail Walker sent you a friend request");
  assert.deepEqual(sentNotification.payload, {
    type: "FRIEND_REQUEST_SENT",
    route: "friends",
  });
});

test("FRIEND_REQUEST_ACCEPTED sends push to requester with friends route payload", async () => {
  const eventBus = createMockEventBus();
  let sentNotification;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById(id) {
        return { id, displayName: "Summit Buddy" };
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        assert.equal(userId, "user-1");
        return [{ token: "accept-token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotification = args;
        return { success: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await eventBus.emit("FRIEND_REQUEST_ACCEPTED", {
    userId: "user-2",
    requesterId: "user-1",
    friendshipId: "f-1",
  });

  assert.equal(sentNotification.deviceToken, "accept-token-1");
  assert.equal(sentNotification.title, "Friend Request Accepted");
  assert.equal(sentNotification.body, "Summit Buddy accepted your friend request");
  assert.deepEqual(sentNotification.payload, {
    type: "FRIEND_REQUEST_ACCEPTED",
    route: "friends",
  });
});

test("STAKE_ACCEPTED sends push to proposer with challenge detail payload", async () => {
  const eventBus = createMockEventBus();
  let sentNotification;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById(id) {
        return { id, displayName: "Summit Buddy" };
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        assert.equal(userId, "user-1");
        return [{ token: "stake-accepted-token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotification = args;
        return { success: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await eventBus.emit("STAKE_ACCEPTED", {
    instanceId: "inst-1",
    acceptedById: "user-2",
    proposedById: "user-1",
    stakeId: "stake-1",
  });

  assert.equal(sentNotification.deviceToken, "stake-accepted-token-1");
  assert.equal(sentNotification.title, "Challenge Accepted");
  assert.equal(sentNotification.body, "Summit Buddy accepted your challenge");
  assert.deepEqual(sentNotification.payload, {
    type: "STAKE_ACCEPTED",
    route: "challenge_detail",
    params: { instanceId: "inst-1" },
  });
});

test("doesn't throw when APNs fails", async () => {
  const eventBus = createMockEventBus();

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        return { displayName: "Walker" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        throw new Error("connection refused");
      },
    },
  });

  // Should not throw
  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });
});

test("doesn't throw when User.findById fails", async () => {
  const eventBus = createMockEventBus();
  let sentBody;

  registerNotificationHandlers({
    eventBus,
    User: {
      async findById() {
        throw new Error("db connection lost");
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification({ body }) {
        sentBody = body;
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_INITIATED", {
    instanceId: "inst-1",
    userId: "user-1",
    friendUserId: "user-2",
    challengeId: "ch-1",
  });

  assert.equal(sentBody, "Someone challenged you!");
});

// --- CHALLENGE_DROPPED tests ---

test("CHALLENGE_DROPPED broadcasts to all device tokens with correct payload", async () => {
  const eventBus = createMockEventBus();
  const sentNotifications = [];

  registerNotificationHandlers({
    eventBus,
    DeviceToken: {
      async findAll() {
        return [
          { userId: "user-1", token: "token-a", platform: "ios" },
          { userId: "user-2", token: "token-b", platform: "ios" },
        ];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotifications.push(args);
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_DROPPED", {
    challengeId: "ch-weekly-1",
    title: "10k Steps Daily",
    weekOf: "2026-03-16",
  });

  assert.equal(sentNotifications.length, 2);
  assert.equal(sentNotifications[0].deviceToken, "token-a");
  assert.equal(sentNotifications[0].title, "New Competition");
  assert.equal(sentNotifications[0].body, "This week's competition: 10k Steps Daily");
  assert.deepEqual(sentNotifications[0].payload, {
    type: "WEEKLY_CHALLENGE_DROPPED",
    route: "challenges",
    params: { challengeId: "ch-weekly-1" },
  });
  assert.equal(sentNotifications[1].deviceToken, "token-b");
});

test("CHALLENGE_DROPPED no-op when no device tokens exist", async () => {
  const eventBus = createMockEventBus();
  let sendCalled = false;

  registerNotificationHandlers({
    eventBus,
    DeviceToken: {
      async findAll() {
        return [];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        sendCalled = true;
        return { success: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_DROPPED", {
    challengeId: "ch-1",
    title: "Walk More",
    weekOf: "2026-03-16",
  });

  assert.equal(sendCalled, false);
});

test("CHALLENGE_DROPPED deletes stale tokens", async () => {
  const eventBus = createMockEventBus();
  const deletedArgs = [];

  registerNotificationHandlers({
    eventBus,
    DeviceToken: {
      async findAll() {
        return [
          { userId: "user-1", token: "stale-token", platform: "ios" },
        ];
      },
      async deleteToken(args) {
        deletedArgs.push(args);
      },
    },
    apnsService: {
      async sendNotification() {
        return { success: false, unregistered: true };
      },
    },
  });

  await eventBus.emit("CHALLENGE_DROPPED", {
    challengeId: "ch-1",
    title: "Walk More",
    weekOf: "2026-03-16",
  });

  assert.deepEqual(deletedArgs, [{ userId: "user-1", token: "stale-token" }]);
});

test("CHALLENGE_DROPPED doesn't throw when APNs fails", async () => {
  const eventBus = createMockEventBus();

  registerNotificationHandlers({
    eventBus,
    DeviceToken: {
      async findAll() {
        return [{ userId: "user-1", token: "token-1", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        throw new Error("connection refused");
      },
    },
  });

  await eventBus.emit("CHALLENGE_DROPPED", {
    challengeId: "ch-1",
    title: "Walk More",
    weekOf: "2026-03-16",
  });
});
