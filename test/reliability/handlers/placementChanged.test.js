const assert = require("node:assert/strict");
const test = require("node:test");

const {
  registerNotificationHandlers,
} = require("../../src/modules/notifications/notificationHandlers");

function createMockEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    async emit(event, data) {
      const fns = handlers.get(event) || [];
      for (const fn of fns) await fn(data);
    },
  };
}

function setup({
  tokens = [{ token: "tok-ios", platform: "ios" }],
  apnsResult,
  fcmResult,
  inertSuppression = false,
} = {}) {
  const logs = [];
  const apnsCalls = { alert: [], silent: [] };
  const fcmCalls = { alert: [], silent: [] };
  const deleted = [];
  // Recording Notification model. The payout-drop variant (batch 2026-08-10
  // item 3) makes an INSERT-FIRST deliveryKey claim whose result decides
  // whether the push goes out, so this seam has to be injected here; the
  // unique-key behaviour itself is proved end-to-end against the real DB in
  // test/integration/payout-drop-push-window.test.js.
  const created = [];
  const deliveryKeys = new Set();
  const eventBus = createMockEventBus();
  let tokenReads = 0;
  registerNotificationHandlers({
    eventBus,
    Notification: {
      async create(row) {
        if (row.deliveryKey) {
          if (deliveryKeys.has(row.deliveryKey)) {
            const error = new Error("Unique constraint failed");
            error.code = "P2002";
            throw error;
          }
          deliveryKeys.add(row.deliveryKey);
        }
        created.push(row);
        return { id: `notif-${created.length}`, ...row };
      },
    },
    User: { async findById() { return null; } },
    DeviceToken: {
      async findByUserId() { tokenReads += 1; return tokens; },
      async deleteToken(arg) { deleted.push(arg); },
    },
    apnsService: {
      async sendNotification(a) { apnsCalls.alert.push(a); return apnsResult || { success: true }; },
      async sendSilentNotification(a) { apnsCalls.silent.push(a); return apnsResult || { success: true }; },
    },
    fcmService: {
      async sendNotification(a) { fcmCalls.alert.push(a); return fcmResult || { success: true }; },
      async sendSilentNotification(a) { fcmCalls.silent.push(a); return fcmResult || { success: true }; },
    },
    logger: {
      log(message, fields) { logs.push({ message, fields }); },
      warn() {},
      error() {},
    },
    getPerformanceFlags: () => ({
      placementInertPushSuppressionEnabled: inertSuppression,
    }),
  });
  return {
    eventBus,
    apnsCalls,
    fcmCalls,
    deleted,
    created,
    logs,
    tokenReads: () => tokenReads,
  };
}

const CHANGE = (over) => ({
  raceId: "r1",
  raceName: "Race 1",
  userId: "u1",
  previousPlacement: 1,
  placement: 2,
  ...over,
});

test("meaningful drop sends an ALERT push with PLACEMENT_CHANGED payload", async () => {
  const { eventBus, apnsCalls } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE());
  assert.equal(apnsCalls.alert.length, 1);
  assert.equal(apnsCalls.silent.length, 0);
  const a = apnsCalls.alert[0];
  assert.equal(a.deviceToken, "tok-ios");
  assert.match(a.body, /2nd/);
  assert.equal(a.payload.type, "PLACEMENT_CHANGED");
  assert.equal(a.payload.params.raceId, "r1");
  assert.equal(a.payload.placement, 2);
});

test("taking 1st sends an ALERT push", async () => {
  const { eventBus, apnsCalls } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ previousPlacement: 2, placement: 1 }));
  assert.equal(apnsCalls.alert.length, 1);
  assert.match(apnsCalls.alert[0].body, /1st/);
});

test("a mid-pack drop NOT crossing a payout cutoff is SILENT (no alert)", async () => {
  const { eventBus, apnsCalls } = setup();
  // 5th -> 6th in a race paying the top 3: not a lead change, still out of the
  // money on both sides -> no meaningful threshold crossed.
  await eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 5, placement: 6, paidPlaces: 3 })
  );
  assert.equal(apnsCalls.alert.length, 0);
  assert.equal(apnsCalls.silent.length, 1);
});

test("dropping out of the paid places sends an ALERT push", async () => {
  const { eventBus, apnsCalls } = setup();
  // 3rd -> 4th in a race paying the top 3: crosses the payout cutoff.
  await eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 3, placement: 4, paidPlaces: 3 })
  );
  assert.equal(apnsCalls.alert.length, 1);
  assert.match(apnsCalls.alert[0].body, /payout|prize/i);
});

test("dropping WITHIN the paid places (1st -> 2nd of top 3) alerts as a lost lead", async () => {
  const { eventBus, apnsCalls } = setup();
  await eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 1, placement: 2, paidPlaces: 3 })
  );
  // Still paid, but losing 1st is meaningful on its own.
  assert.equal(apnsCalls.alert.length, 1);
  assert.match(apnsCalls.alert[0].body, /2nd/);
});

test("non-meaningful improvement (3rd -> 2nd) sends a SILENT push only", async () => {
  const { eventBus, apnsCalls } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ previousPlacement: 3, placement: 2 }));
  assert.equal(apnsCalls.alert.length, 0);
  assert.equal(apnsCalls.silent.length, 1);
  assert.equal(apnsCalls.silent[0].payload.type, "PLACEMENT_CHANGED");
});

test("inert suppression returns before token lookup and the flag-off path stays legacy", async () => {
  const enabled = setup({ inertSuppression: true });
  await enabled.eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 3, placement: 2 })
  );
  assert.equal(enabled.tokenReads(), 0);
  assert.equal(enabled.apnsCalls.silent.length, 0);

  const legacy = setup({ inertSuppression: false });
  await legacy.eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 3, placement: 2 })
  );
  assert.equal(legacy.tokenReads(), 1);
  assert.equal(legacy.apnsCalls.silent.length, 1);
});

test("potentially visible placement still checks tokens before any alert work", async () => {
  const enabled = setup({ inertSuppression: true, tokens: [] });
  await enabled.eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({ previousPlacement: 2, placement: 1 })
  );
  assert.equal(enabled.tokenReads(), 1);
  assert.equal(enabled.created.length, 0);
  assert.equal(enabled.apnsCalls.alert.length, 0);
});

test("outside-window payout cutoff is classified inert before token lookup", async () => {
  const enabled = setup({ inertSuppression: true });
  await enabled.eventBus.emit(
    "PLACEMENT_CHANGED",
    CHANGE({
      previousPlacement: 3,
      placement: 4,
      paidPlaces: 3,
      endsAt: new Date(Date.now() + 17 * 60 * 60 * 1000),
    })
  );
  assert.equal(enabled.tokenReads(), 0);
  assert.equal(enabled.apnsCalls.alert.length, 0);
  assert.equal(enabled.apnsCalls.silent.length, 0);
  const perf = enabled.logs.find(
    (entry) => entry.message === "[PERF] placement notification"
  );
  assert.equal(perf.fields.outcome, "skipped-inert");
  assert.equal(typeof perf.fields.durationMs, "number");
});

test("visible placement logs handler completion duration and push outcomes", async () => {
  const visible = setup();
  await visible.eventBus.emit("PLACEMENT_CHANGED", CHANGE());
  const perf = visible.logs.find(
    (entry) => entry.message === "[PERF] placement notification"
  );
  assert.equal(perf.fields.outcome, "alert-sent");
  assert.equal(perf.fields.tokenReads, 1);
  assert.equal(perf.fields.pushAttempts, 1);
  assert.equal(perf.fields.pushSuccesses, 1);
  assert.equal(typeof perf.fields.durationMs, "number");
});

test("alert cooldown: a second meaningful move within the window is silent", async () => {
  const { eventBus, apnsCalls } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ previousPlacement: 1, placement: 2 })); // alert
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ previousPlacement: 2, placement: 3 })); // silent
  assert.equal(apnsCalls.alert.length, 1);
  assert.equal(apnsCalls.silent.length, 1);
});

test("routes android tokens to FCM and ios tokens to APNs", async () => {
  const { eventBus, apnsCalls, fcmCalls } = setup({
    tokens: [
      { token: "tok-ios", platform: "ios" },
      { token: "tok-android", platform: "android" },
    ],
  });
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE());
  assert.equal(apnsCalls.alert.length, 1);
  assert.equal(apnsCalls.alert[0].deviceToken, "tok-ios");
  assert.equal(fcmCalls.alert.length, 1);
  assert.equal(fcmCalls.alert[0].deviceToken, "tok-android");
});

test("deletes stale token on unregistered response", async () => {
  const { eventBus, deleted } = setup({ apnsResult: { success: false, unregistered: true } });
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE());
  assert.deepEqual(deleted, [{ userId: "u1", token: "tok-ios" }]);
});

test("no device tokens -> no-op", async () => {
  const { eventBus, apnsCalls, fcmCalls } = setup({ tokens: [] });
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE());
  assert.equal(apnsCalls.alert.length, 0);
  assert.equal(fcmCalls.alert.length, 0);
});

test("missing userId or placement is ignored safely", async () => {
  const { eventBus, apnsCalls, fcmCalls } = setup();
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ userId: undefined }));
  await eventBus.emit("PLACEMENT_CHANGED", CHANGE({ placement: undefined }));
  assert.equal(apnsCalls.alert.length, 0);
  assert.equal(apnsCalls.silent.length, 0);
});
