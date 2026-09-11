const assert = require("node:assert/strict");
const { beforeEach, it } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(decodeURIComponent(target.pathname), /_test$/);
assert.equal(process.env.NODE_ENV, "test");
const { prisma, cleanDatabase } = require("./setup");
const { bulkAppendDomainEvents } = require("../../src/modules/domainEvents");
const { scheduleDomainEventReceiptRecovery, buildDomainEventReceiptRecoveryWorker } = require("../../src/modules/domainEvents/jobs/domainEventReceiptRecovery");
const { buildDomainEventRetention } = require("../../src/modules/domainEvents/jobs/domainEventRetention");
const { DomainEventReceiptRecovery } = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery");

beforeEach(cleanDatabase);
const logger = { log() {}, error() {} };
async function seed(count, prefix = "single-release") {
  await bulkAppendDomainEvents(prisma, Array.from({ length: count }, (_, i) => ({
    eventKey: `${prefix}:${i}`, eventType: "RECEIPT_SINGLE_RELEASE_TEST_V1",
    schemaVersion: 1, aggregateType: "TEST", aggregateId: `${prefix}:${i}`,
    occurredAt: new Date("2026-08-01"), availableAt: new Date("2026-08-01"),
    payload: { index: i }, audience: [],
  })));
  return prisma.domainEventOutbox.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

it("real recovery scheduler automatically traverses FINAL-only history and repairs gaps without a manual CLI", async () => {
  // These cron transitions have no HTTP entry point. Run the real scheduler,
  // worker, receipt model and database; disable only optional Redis wake hints.
  const events = await seed(501);
  await prisma.domainEventReceipt.delete({ where: { eventKey: events[500].eventKey } });
  const job = scheduleDomainEventReceiptRecovery({ prisma, logger,
    subscribeWake: async () => async () => {},
  });
  try {
    await job.ready;
    await delay(20);
    await job.whenIdle();
    const [first] = await prisma.$queryRawUnsafe("SELECT * FROM domain_event_receipt_discovery WHERE id='automatic-v1'");
    assert.equal(Number(first?.scanned), 500, "startup must visit a bounded source page even with an empty queue");
    assert.equal(first.completed_at, null);
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 0, "FINAL-only pages add no repair work");
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const receipt = await prisma.domainEventReceipt.findUnique({ where: { eventKey: events[500].eventKey } });
      if (receipt?.receiptState === "FINAL") break;
      await delay(50);
    }
    await job.whenIdle();
    const [finished] = await prisma.$queryRawUnsafe("SELECT * FROM domain_event_receipt_discovery WHERE id='automatic-v1'");
    assert.ok(finished.completed_at, "all-FINAL pages must schedule another paced discovery tick");
    assert.equal(Number(finished.scanned), 501);
    assert.equal((await prisma.domainEventReceipt.findUnique({ where: { eventKey: events[500].eventKey } })).receiptState, "FINAL");
    assert.equal((await prisma.domainEventReceiptRecovery.findUnique({ where: { eventKey: events[500].eventKey } })).status, "SUCCEEDED");
    const checkpoint = finished.cursor_id;
    await job.tick();
    assert.equal((await prisma.$queryRawUnsafe("SELECT cursor_id FROM domain_event_receipt_discovery WHERE id='automatic-v1'"))[0].cursor_id, checkpoint);
  } finally { await job.stop(); }
});

it("repairs fresh work even when historical discovery fails, then retries the unchanged checkpoint", async () => {
  const [event] = await seed(1, "discovery-failure");
  await prisma.domainEventReceipt.delete({ where: { eventKey: event.eventKey } });
  await DomainEventReceiptRecovery.enqueue({ domainEventId: event.id, eventKey: event.eventKey, reason: "COMPAT_MISSING" });
  let attempted = 0;
  const recovery = Object.create(DomainEventReceiptRecovery);
  recovery.discoverAutomaticPage = async (options) => {
    attempted++;
    if (attempted === 1) throw Object.assign(new Error("historical lock timeout"), { code: "55P03" });
    return DomainEventReceiptRecovery.discoverAutomaticPage(options);
  };
  const job = scheduleDomainEventReceiptRecovery({ prisma, recovery, logger,
    subscribeWake: async () => async () => {},
  });
  try {
    await job.ready;
    await delay(20);
    await job.whenIdle();
    assert.equal(attempted, 1);
    assert.equal((await prisma.domainEventReceipt.findUnique({ where: { eventKey: event.eventKey } })).receiptState, "FINAL");
    assert.equal((await prisma.$queryRawUnsafe("SELECT id FROM domain_event_receipt_discovery WHERE id='automatic-v1'")).length, 0);
    await job.tick();
    assert.equal(attempted, 2);
    assert.ok((await prisma.$queryRawUnsafe("SELECT completed_at FROM domain_event_receipt_discovery WHERE id='automatic-v1'"))[0].completed_at);
  } finally { await job.stop(); }
});

it("real retention preserves missing and PROVISIONAL sources without the broad event scan", async () => {
  const events = await seed(3, "retention-safety");
  const [missing, provisional, final] = events;
  await prisma.domainEventOutbox.updateMany({ data: { status: "COMPLETED", completedAt: new Date("2026-07-01") } });
  await prisma.domainEventReceipt.delete({ where: { eventKey: missing.eventKey } });
  await prisma.domainEventReceipt.update({ where: { eventKey: provisional.eventKey }, data: {
    receiptState: "PROVISIONAL", envelopeDigest: null, finalizedAt: null,
  } });
  await prisma.$executeRawUnsafe(`INSERT INTO domain_event_receipt_discovery(id,cutoff)
    VALUES ('automatic-v1',clock_timestamp() AT TIME ZONE 'UTC')`);
  await prisma.domainEventReceiptRecovery.createMany({ data: [
    { domainEventId: missing.id, eventKey: missing.eventKey, reason: "LEGACY_MISSING", status: "FAILED_TERMINAL", lastErrorCode: "MALFORMED_SOURCE" },
    { domainEventId: provisional.id, eventKey: provisional.eventKey, reason: "LEGACY_PROVISIONAL", status: "RETRY", availableAt: new Date("2099-01-01") },
  ] });
  const retention = buildDomainEventRetention({ prisma, logger,
    now: () => new Date("2026-09-11T12:00:00Z"),
    JobRun: { lastRanFor: async () => null, claimRun: async () => true },
    isReceiptCleanupCutoffAccepted: async () => false,
    // Exercise the real deletion SQL; local tests have no replica-lag exporter.
    cleanupBudget: { runPage: async (operation) => ({ rows: await operation(), allowedContinue: true, durationMs: 1 }) },
  });
  const result = await retention();
  assert.equal(result.eventReceiptsBackfilled, 0, "new release must not invoke the full-history repair scan");
  assert.equal(await prisma.domainEventOutbox.count({ where: { id: { in: [missing.id, provisional.id] } } }), 2);
  assert.equal(await prisma.domainEventOutbox.count({ where: { id: final.id } }), 0);
  assert.equal(await prisma.domainEventReceipt.count({ where: { eventKey: missing.eventKey } }), 0);
  assert.equal((await prisma.domainEventReceipt.findUnique({ where: { eventKey: provisional.eventKey } })).receiptState, "PROVISIONAL");
  assert.equal(await prisma.domainEventReceiptRecovery.count(), 2, "retry/quarantine evidence survives retention while the sweep is incomplete");
});

it("bounds the bulk source read when a table lock would otherwise stall the recovery worker", async () => {
  const [event] = await seed(1, "bounded-source-read");
  await prisma.domainEventReceipt.delete({ where: { eventKey: event.eventKey } });
  await DomainEventReceiptRecovery.enqueue({ domainEventId: event.id, eventKey: event.eventKey, reason: "LEGACY_MISSING" });
  let unlock, acquired;
  const held = new Promise((resolve) => { unlock = resolve; });
  const locked = new Promise((resolve) => { acquired = resolve; });
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("LOCK TABLE domain_event_outbox IN ACCESS EXCLUSIVE MODE");
    acquired();
    await held;
  });
  await locked;
  const draining = buildDomainEventReceiptRecoveryWorker({ prisma, logger }).drain();
  try {
    const outcome = await Promise.race([
      draining.then(() => "unexpected_success", () => "bounded_failure"),
      delay(1000).then(() => "stalled"),
    ]);
    assert.equal(outcome, "bounded_failure", "source/audience reads must obey the same lock budget as repair writes");
  } finally {
    unlock();
    await blocker;
    await draining.catch(() => {});
  }
  assert.equal((await prisma.domainEventReceiptRecovery.findUnique({ where: { eventKey: event.eventKey } })).status, "PROCESSING", "failed reads retain a reclaimable lease, not a false success");
  assert.equal(await prisma.domainEventReceipt.count({ where: { eventKey: event.eventKey } }), 0);
});
