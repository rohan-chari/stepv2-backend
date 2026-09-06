const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildNotificationIntentService,
  normalizeNotificationIntent,
} = require("../../src/modules/notifications/services/notificationDelivery");
const { scheduleInboxDelivery } = require("../../src/modules/inbox/jobs/inboxDelivery");

const NOW = new Date("2026-08-23T15:00:00.000Z");

function intent(overrides = {}) {
  return {
    recipientUserId: "user-1",
    type: "GLOBAL_EVENT_STARTED",
    title: "2x STEPS EVENT",
    body: "Double steps are LIVE.",
    payload: {
      type: "GLOBAL_EVENT_STARTED",
      route: "home",
      params: { eventId: "event-1" },
      multiplier: 2,
      messageId: "message-1",
      collapseId: "global-event-1",
      threadId: "global-events",
    },
    deliveryKey: "global-event:user-1:event-1",
    availableAt: NOW,
    ...overrides,
  };
}

test("normalized intent contract preserves the complete provider payload", () => {
  const normalized = normalizeNotificationIntent(intent());
  assert.deepEqual(normalized.payload, intent().payload);
  assert.equal(normalized.deliveryKey, "global-event:user-1:event-1");
  assert.equal(normalized.availableAt.toISOString(), NOW.toISOString());
});

test("immediate intent creates one Inbox alert/outbox and wakes only after persistence", async () => {
  const alerts = [];
  const wakeups = [];
  const transactions = [];
  const service = buildNotificationIntentService({
    now: () => NOW,
    createInboxAlert: async (row) => {
      alerts.push(row);
      return { id: "alert-1" };
    },
    transaction: async (work) => {
      const tx = { name: "transaction" };
      transactions.push(tx);
      return work(tx);
    },
    publishWakeup: async (hint) => wakeups.push(hint),
  });

  const result = await service.submit(intent());

  assert.equal(result.kind, "IMMEDIATE");
  assert.equal(transactions.length, 1);
  assert.deepEqual(alerts, [{
    userId: "user-1",
    type: "GLOBAL_EVENT_STARTED",
    title: "2x STEPS EVENT",
    body: "Double steps are LIVE.",
    destination: { route: "home" },
    sourceKey: "global-event:user-1:event-1",
    now: NOW,
    tx: transactions[0],
    payload: intent().payload,
  }]);
  assert.deepEqual(wakeups, [{ kind: "DUE_SCAN" }]);
});

test("scheduled intent is durable but does not create a visible Inbox alert before its boundary", async () => {
  const schedules = [];
  const alerts = [];
  const wakeups = [];
  const service = buildNotificationIntentService({
    now: () => NOW,
    createInboxAlert: async (row) => alerts.push(row),
    notificationSchedule: {
      upsert: async (args) => {
        schedules.push(args);
        return { id: "schedule-1", ...args.create };
      },
    },
    transaction: async (work) => work({ name: "transaction" }),
    publishWakeup: async (hint) => wakeups.push(hint),
  });
  const availableAt = new Date(NOW.getTime() + 60_000);

  const result = await service.submit(intent({ availableAt, expiresAt: new Date(NOW.getTime() + 30 * 60_000) }));

  assert.equal(result.kind, "SCHEDULED");
  assert.equal(alerts.length, 0);
  assert.equal(schedules.length, 1);
  assert.deepEqual(schedules[0].where, {
    recipientUserId_deliveryKey: {
      recipientUserId: "user-1",
      deliveryKey: "global-event:user-1:event-1",
    },
  });
  assert.deepEqual(schedules[0].create.payload, intent().payload);
  assert.deepEqual(wakeups, [{ kind: "DUE_SCAN" }]);
});

test("visible APNs/FCM calls are structurally confined to the centralized delivery worker", () => {
  const files = [
    "src/modules/notifications/notificationHandlers.js",
    "src/modules/races/services/raceResolutionDeliveryIntents.js",
    "src/modules/admin/routes.js",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
    assert.doesNotMatch(source, /\.sendNotification\s*\(/, `${file} still has a direct visible provider call`);
  }
});

test("the existing cron-owned delivery scheduler releases due rows and subscribes to wake-ups", async () => {
  const events = [];
  let wake;
  const scheduled = scheduleInboxDelivery({
    intervalMs: 60 * 60 * 1000,
    now: () => NOW,
    releaseDue: async ({ now }) => {
      events.push(["releaseDue", now]);
    },
    subscribeNotificationWakeup: async (handler) => {
      events.push(["subscribe"]);
      wake = handler;
      return async () => {};
    },
    run: async () => {
      events.push(["outboxScan"]);
      return { claimed: 0, delivered: 0, expired: 0 };
    },
    appSettings: { async getFlag() { return false; } },
    userFanoutDisabled: () => false,
    logger: { log() {}, error() {} },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof wake, "function");
  assert.deepEqual(events.map(([name]) => name), ["subscribe", "releaseDue", "outboxScan"]);
  await wake();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(([name]) => name), [
    "subscribe",
    "releaseDue",
    "outboxScan",
    "releaseDue",
    "outboxScan",
  ]);
  scheduled.stop();
});
