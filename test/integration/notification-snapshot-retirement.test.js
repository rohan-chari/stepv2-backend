const assert = require("node:assert/strict");
const { before, beforeEach, afterEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { buildNotificationCompletenessReconciler } = require("../../src/modules/notifications/jobs/notificationCompletenessReconciler");
const { buildInboxDelivery } = require("../../src/modules/inbox/jobs/inboxDelivery");

const quiet = { log() {}, error() {}, warn() {} };
let server;
let current;

async function fixture(status, { admitted = false } = {}) {
  const account = await createTestUser();
  const deliveryKey = `snapshot-retirement:${account.user.id}`;
  const expiresAt = new Date(current.getTime() + 30 * 60_000);
  await prisma.notificationSchedule.create({ data: {
    recipientUserId: account.user.id, deliveryKey, type: "GLOBAL_EVENT_STARTED",
    title: "Event started", body: "Your event is ready", payload: { route: "home" },
    status: "MATERIALIZED", availableAt: current, expiresAt, releasedAt: current,
  } });
  const alert = await prisma.inboxAlert.create({ data: {
    userId: account.user.id, sourceKey: deliveryKey, type: "GLOBAL_EVENT_STARTED",
    title: "Event started", body: "Your event is ready", destination: { route: "home" },
    createdAt: current, expiresAt: new Date(current.getTime() + 86_400_000),
  } });
  const outbox = await prisma.inboxDeliveryOutbox.create({ data: {
    alertId: alert.id, status, availableAt: current, expiresAt,
    payload: { title: alert.title, body: alert.body, payload: { route: "home", type: alert.type } },
    ...(status.includes("LEASED") ? {
      leaseUntil: new Date(current.getTime() + 30_000), leaseToken: "original-owner",
    } : {}),
    ...(status === "DELIVERED" ? { deliveredAt: current } : {}),
    ...(admitted ? {
      admissionClass: "visible:GLOBAL_EVENT_STARTED", admissionSequence: 1n,
      admissionExpiresAt: expiresAt,
    } : {}),
  } });
  return { account, alert, outbox };
}

async function inbox(f) {
  const response = await request(server.baseUrl, "GET", "/inbox/alerts", {
    token: f.account.token, headers: { "X-Client-Features": "inbox_v1" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.alerts.length, 1);
  assert.equal(body.alerts[0].id, f.alert.id);
  assert.equal(body.alerts[0].title, f.alert.title);
  assert.equal(body.unreadCount, 1);
  return body;
}

function delivery(provider = { async sendNotification() { throw new Error("unexpected provider call"); } }) {
  return buildInboxDelivery({
    prisma, now: () => current, apnsService: provider, fcmService: provider,
    userFanoutDisabled: () => false, logger: quiet, random: () => 0,
  });
}

describe("notification delivery without historical snapshot repair", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlag("apiInboxV1Enabled", true);
    current = new Date();
  });
  afterEach(async () => { await appSettings.setFlag("apiInboxV1Enabled", false); });

  it("leaves malformed terminal outboxes finished without a wake or immediate repair rerun", async () => {
    let wakes = 0;
    const fixtures = await Promise.all([fixture("DELIVERED"), fixture("EXHAUSTED", { admitted: true })]);
    const before = await Promise.all(fixtures.map(inbox));
    const repair = buildNotificationCompletenessReconciler({
      prisma, now: () => current, pageSize: 1,
      publishDomainWake: async () => { wakes++; },
      publishNotificationWake: async () => { wakes++; },
    });
    const result = await repair();
    assert.equal(result.missingSnapshotsRearmed, 0);
    assert.equal(result.fullPage, false);
    assert.equal(wakes, 0);
    for (const [index, f] of fixtures.entries()) {
      assert.deepEqual(await prisma.inboxDeliveryOutbox.findUnique({ where: { id: f.outbox.id } }), f.outbox);
      assert.equal(await prisma.inboxDeliveryDeviceAttempt.count({ where: { outboxId: f.outbox.id } }), 0);
      assert.deepEqual(await inbox(f), before[index]);
    }
  });

  it("does not steal a live legacy lease while its target snapshot is absent", async () => {
    const f = await fixture("LEASED");
    const before = await inbox(f);
    const result = await buildNotificationCompletenessReconciler({ prisma, now: () => current })();
    assert.equal(result.missingSnapshotsRearmed, 0);
    assert.equal(result.overdueOutboxesRearmed, 0);
    assert.deepEqual(await prisma.inboxDeliveryOutbox.findUnique({ where: { id: f.outbox.id } }), f.outbox);
    assert.deepEqual(await inbox(f), before);
  });

  for (const admitted of [false, true]) {
    it(`recovers an abandoned ${admitted ? "admitted" : "legacy"} claim without the repair job`, async () => {
      const f = await fixture(admitted ? "ADMISSION_LEASED" : "LEASED", { admitted });
      const before = await inbox(f);
      // Simulate process loss between durable claim and target creation.
      current = new Date(current.getTime() + 31_000);
      await delivery()();
      const outbox = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: f.outbox.id } });
      assert.equal(outbox.status, "DELIVERED");
      assert.equal(outbox.leaseToken, null);
      const targets = await prisma.inboxDeliveryDeviceAttempt.findMany({ where: { outboxId: outbox.id } });
      assert.equal(targets.length, 1);
      assert.equal(targets[0].disposition, "NO_DEVICE");
      assert.equal(targets[0].recipientUserId, f.account.user.id);
      assert.deepEqual(await inbox(f), before);
    });
  }

  it("registers a device over HTTP and retries a transient push without snapshot repair", async () => {
    const f = await fixture("ADMISSION_FIRST", { admitted: true });
    const registration = await request(server.baseUrl, "POST", "/notifications/device-token", {
      token: f.account.token,
      body: { deviceToken: `retirement-${f.account.user.id}`, platform: "android", installationId: f.account.user.id },
    });
    assert.equal(registration.status, 200);
    const before = await inbox(f);
    let sends = 0;
    const worker = delivery({ async sendNotification() {
      sends++;
      return sends === 1
        ? { success: false, statusCode: 503, reason: "UNAVAILABLE", retryAfterMs: 250, permanent: false }
        : { success: true, statusCode: 200, providerMessageId: "test-delivered" };
    } });
    await worker();
    let outbox = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: f.outbox.id } });
    assert.equal(outbox.status, "ADMISSION_RETRY");
    assert.equal(sends, 1);
    const target = await prisma.inboxDeliveryDeviceAttempt.findFirstOrThrow({ where: { outboxId: outbox.id } });
    current = new Date(Math.max(new Date(outbox.availableAt).getTime(), current.getTime() + 2_000));
    await worker();
    outbox = await prisma.inboxDeliveryOutbox.findUniqueOrThrow({ where: { id: f.outbox.id } });
    assert.equal(outbox.status, "DELIVERED");
    assert.equal(sends, 2);
    const targets = await prisma.inboxDeliveryDeviceAttempt.findMany({ where: { outboxId: outbox.id } });
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, target.id);
    assert.equal(targets[0].disposition, "ACCEPTED");
    assert.deepEqual(await inbox(f), before);
  });
});
