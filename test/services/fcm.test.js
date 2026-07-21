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
