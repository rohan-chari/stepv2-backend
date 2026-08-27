const assert = require("node:assert/strict");
const test = require("node:test");

const { buildFcmService } = require("../../src/shared/push/fcm");

function mockMessaging() {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return "projects/x/messages/1";
    },
  };
}

test("sendNotification builds notification + stringified data and succeeds", async () => {
  const messaging = mockMessaging();
  const fcm = buildFcmService({ messaging });

  const result = await fcm.sendNotification({
    deviceToken: "android-token-1",
    title: "Race Invite",
    body: "Trail Walker invited you",
    payload: {
      type: "RACE_INVITE_SENT",
      route: "race_detail",
      params: { raceId: "race-1" },
    },
    collapseId: "race_chat_race-1",
  });

  assert.deepEqual(result, { success: true });
  assert.equal(messaging.sent.length, 1);
  const msg = messaging.sent[0];
  assert.equal(msg.token, "android-token-1");
  assert.deepEqual(msg.notification, {
    title: "Race Invite",
    body: "Trail Walker invited you",
  });
  // All data values must be strings; nested objects JSON-stringified.
  assert.equal(msg.data.type, "RACE_INVITE_SENT");
  assert.equal(msg.data.route, "race_detail");
  assert.equal(msg.data.params, '{"raceId":"race-1"}');
  assert.equal(msg.android.collapseKey, "race_chat_race-1");
  assert.equal(msg.android.notification.channelId, "bara_default");
});

test("event push clips FCM TTL and returns the provider message name", async () => {
  const messaging = mockMessaging();
  const now = new Date("2098-08-26T10:00:00.000Z");
  const fcm = buildFcmService({ messaging, now: () => now });
  const result = await fcm.sendNotification({
    deviceToken: "event-token",
    title: "2x STEPS EVENT",
    body: "Go!",
    expiresAt: new Date(now.getTime() + 90_500),
    collapseId: "event:bounded-hash",
  });
  assert.equal(messaging.sent[0].android.ttl, 90_500);
  assert.equal(result.providerMessageId, "projects/x/messages/1");
  assert.equal(result.success, true);
});

test("sendSilentNotification sends data-only (no notification block)", async () => {
  const messaging = mockMessaging();
  const fcm = buildFcmService({ messaging });

  const result = await fcm.sendSilentNotification({
    deviceToken: "android-token-2",
    payload: { type: "race_message", raceId: "race-9" },
  });

  assert.deepEqual(result, { success: true });
  const msg = messaging.sent[0];
  assert.equal(msg.notification, undefined);
  assert.equal(msg.data.type, "race_message");
  assert.equal(msg.data.raceId, "race-9");
});

test("maps registration-token-not-registered to unregistered:true", async () => {
  const fcm = buildFcmService({
    messaging: {
      async send() {
        const err = new Error("Requested entity was not found.");
        err.errorInfo = { code: "messaging/registration-token-not-registered" };
        throw err;
      },
    },
  });

  const result = await fcm.sendNotification({
    deviceToken: "dead-token",
    title: "t",
    body: "b",
  });

  assert.equal(result.success, false);
  assert.equal(result.unregistered, true);
  assert.equal(result.reason, "messaging/registration-token-not-registered");
});

test("generic send errors are not treated as unregistered", async () => {
  const fcm = buildFcmService({
    messaging: {
      async send() {
        const err = new Error("backend unavailable");
        err.errorInfo = { code: "messaging/server-unavailable" };
        throw err;
      },
    },
  });

  const result = await fcm.sendNotification({ deviceToken: "t" });
  assert.equal(result.success, false);
  assert.equal(result.unregistered, false);
});

test("normalizes FCM throttling metadata without invalidating the token", async () => {
  const fcm = buildFcmService({
    messaging: {
      async send() {
        const error = new Error("quota exceeded");
        error.errorInfo = { code: "messaging/quota-exceeded" };
        error.retryAfterMs = 250;
        throw error;
      },
    },
  });
  const result = await fcm.sendNotification({ deviceToken: "live-token" });
  assert.equal(result.invalidToken, false);
  assert.equal(result.permanent, false);
  assert.equal(result.statusCode, 429);
  assert.equal(result.retryAfterMs, 250);
});

test("fail-soft: never throws when firebase-admin init fails", async () => {
  const fcm = buildFcmService({
    firebase: {
      getApps: () => [],
      initializeApp() {
        throw new Error("missing service-account credential");
      },
      cert() {},
      applicationDefault() {},
      getMessaging() {},
    },
  });

  const result = await fcm.sendNotification({
    deviceToken: "t",
    title: "t",
    body: "b",
  });
  assert.equal(result.success, false);
  assert.match(result.reason, /service-account/);
});
