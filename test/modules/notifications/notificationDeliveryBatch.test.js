const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildNotificationDeliveryStreamWorker } = require("../../../src/modules/notifications/jobs/notificationDeliveryStreamWorker");

function fixture(count) {
  let current = new Date("2098-09-19T12:00:00Z");
  let providerFails = false;
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `entitlement-${i}`, userId: `user-${i}`, eventId: "event", scheduleRevision: 0,
    startProcessedAt: current, startOutcome: "ACTIVATED_ON_TIME",
    endsAt: new Date(current.getTime() + 30 * 60_000), event: { multiplier: 2 },
  }));
  const outboxes = new Map();
  const calls = { entitlements: 0, impacts: 0, tokens: 0 };
  const sent = [];
  const acknowledged = [];
  const prisma = {
    globalStepEventEntitlement: {
      async findMany({ where }) {
        calls.entitlements += 1;
        return rows.filter((row) => where.id.in.includes(row.id)).map((row) => ({ ...row }));
      },
    },
    globalEventRaceImpact: {
      async groupBy({ where }) {
        calls.impacts += 1;
        return where.OR.map(({ eventId, userId }) => ({ eventId, userId }));
      },
    },
    inboxDeliveryOutbox: {
      async findUnique({ where }) { return outboxes.get(where.id || where.alertId_kind.alertId); },
      async updateMany({ where, data }) {
        const row = outboxes.get(where.id);
        if (!["PENDING", "RETRY"].includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      async update({ where, data }) { Object.assign(outboxes.get(where.id), data); },
    },
    async $transaction(fn) { return fn(prisma); },
  };
  const provider = {
    async sendNotification(input) {
      sent.push(input);
      return { success: !providerFails };
    },
  };
  const worker = buildNotificationDeliveryStreamWorker({
    prisma, now: () => current,
    queue: {
      STREAMS: { NOTIFICATION_DELIVERY: "notification" },
      GROUPS: { NOTIFICATION_DELIVERY: "notification-workers" },
      consumerName: () => "test-claim",
      async ack(_stream, _group, id) { acknowledged.push(id); },
    },
    DeviceToken: {
      async findForDeliveryByUserIds(ids) {
        calls.tokens += 1;
        assert.ok(ids.length <= 100);
        return ids.map((userId) => ({ userId, token: `token-${userId}`, platform: "ios" }));
      },
    },
    apnsService: provider, fcmService: provider,
    async createInboxAlert({ userId }) {
      if (!outboxes.has(userId)) outboxes.set(userId, { id: userId, status: "PENDING" });
      return { id: userId };
    },
    logger: { log() {}, error() {} },
  });
  const entries = rows.map((row, i) => ({
    id: `1-${i}`,
    fields: {
      schemaVersion: "1", recipientUserId: row.userId, type: "GLOBAL_EVENT_STARTED",
      sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT", sourceId: row.id, sourceRevision: "0",
      deliveryKey: `visible:${row.userId}:event`, availableAt: current.toISOString(),
      expiresAt: row.endsAt.toISOString(),
    },
  }));
  return {
    worker, rows, calls, entries, sent, acknowledged, outboxes,
    failProvider(value) { providerFails = value; },
    advance(ms) { current = new Date(current.getTime() + ms); },
  };
}

test("notification prerequisites are read once per bounded batch while every recipient is delivered", async () => {
  const f = fixture(101);
  assert.equal(await f.worker.processEntries(f.entries), 101);
  assert.deepEqual(f.calls, { entitlements: 2, impacts: 2, tokens: 2 });
  assert.equal(f.sent.length, 101);
  assert.equal(new Set(f.sent.map((entry) => entry.deviceToken)).size, 101);
  assert.equal(f.acknowledged.length, 101);
  assert.ok([...f.outboxes.values()].every((row) => row.status === "DELIVERED"));
});

test("provider retry stays pending and reloads eligibility on the next batch", async () => {
  const f = fixture(2);
  f.failProvider(true);
  assert.equal(await f.worker.processEntries(f.entries), 0);
  assert.equal(f.acknowledged.length, 0);
  assert.ok([...f.outboxes.values()].every((row) => row.status === "RETRY"));
  f.rows[0].scheduleRevision = 1;
  f.failProvider(false);
  f.advance(2000);
  assert.equal(await f.worker.processEntries(f.entries), 2);
  assert.equal(f.calls.entitlements, 2);
  assert.equal(f.sent.length, 3, "only the still-eligible recipient is sent on retry");
  assert.equal(f.sent.at(-1).deviceToken, "token-user-1");
  assert.equal(f.outboxes.get("user-1").status, "DELIVERED");
});
