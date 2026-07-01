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

test("POWERUP_USED pushes an attack alert while the race is live (ACTIVE, before endsAt)", async () => {
  const eventBus = createMockEventBus();
  let sentNotification;

  registerNotificationHandlers({
    eventBus,
    Race: {
      async findUnique() {
        return { status: "ACTIVE", endsAt: new Date(Date.now() + 3_600_000) };
      },
    },
    User: {
      async findById(id) {
        return { id, displayName: "Nathan" };
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        assert.equal(userId, "victim-1");
        return [{ token: "victim-token", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotification = args;
        return { success: true };
      },
    },
    logger: { warn() {}, error() {} },
  });

  await eventBus.emit("POWERUP_USED", {
    raceId: "race-1",
    userId: "attacker-1",
    powerupType: "LEG_CRAMP",
    targetUserId: "victim-1",
  });

  assert.ok(sentNotification, "a push should be sent for a live race");
  assert.equal(sentNotification.title, "Powerup Attack!");
});

test("POWERUP_USED does NOT push for an expired-but-unsettled race (past endsAt, still ACTIVE)", async () => {
  const eventBus = createMockEventBus();
  let pushed = false;

  registerNotificationHandlers({
    eventBus,
    Race: {
      async findUnique() {
        // raceExpiry hasn't flipped status yet, but endsAt is in the past.
        return { status: "ACTIVE", endsAt: new Date(0) };
      },
    },
    User: {
      async findById(id) {
        return { id, displayName: "Nathan" };
      },
    },
    DeviceToken: {
      async findByUserId() {
        return [{ token: "victim-token", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification() {
        pushed = true;
        return { success: true };
      },
    },
    logger: { warn() {}, error() {} },
  });

  await eventBus.emit("POWERUP_USED", {
    raceId: "race-1",
    userId: "attacker-1",
    powerupType: "SHORTCUT",
    targetUserId: "victim-1",
  });

  assert.equal(pushed, false, "no attack push for a race that already ended");
});

test("RACE_MESSAGE_SENT notifies accepted unmuted participants and updates cooldown", async () => {
  const eventBus = createMockEventBus();
  const sentNotifications = [];
  const updates = [];

  registerNotificationHandlers({
    eventBus,
    RaceParticipant: {
      async findMany() {
        return [
          {
            id: "rp-2",
            raceId: "race-1",
            userId: "user-2",
            status: "ACCEPTED",
            chatMuted: false,
            lastChatPushAt: null,
          },
        ];
      },
      async update(args) {
        updates.push(args);
      },
    },
    DeviceToken: {
      async findByUserId(userId) {
        assert.equal(userId, "user-2");
        return [{ token: "race-chat-token", platform: "ios" }];
      },
      async deleteToken() {},
    },
    apnsService: {
      async sendNotification(args) {
        sentNotifications.push(args);
        return { success: true };
      },
    },
    logger: {
      warn() {},
      error() {},
    },
  });

  await eventBus.emit("RACE_MESSAGE_SENT", {
    raceId: "race-1",
    messageId: "msg-1",
    senderId: "user-1",
    body: "See you at the finish",
    senderName: "Trail Walker",
    raceName: "Evening Sprint",
  });

  assert.equal(sentNotifications.length, 1);
  assert.equal(sentNotifications[0].deviceToken, "race-chat-token");
  assert.equal(sentNotifications[0].title, "Evening Sprint");
  assert.equal(sentNotifications[0].body, "Trail Walker: See you at the finish");
  assert.deepEqual(sentNotifications[0].payload, {
    type: "race_message",
    route: "race_detail",
    params: { raceId: "race-1" },
    raceId: "race-1",
    messageId: "msg-1",
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "rp-2");
  assert.ok(updates[0].data.lastChatPushAt instanceof Date);
});
