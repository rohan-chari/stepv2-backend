const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, prisma } = require("./setup");
const {
  appendDomainEvent,
  bulkAppendDomainEvents,
} = require("../../src/modules/domainEvents");
const {
  DomainEventReceipt,
} = require("../../src/modules/domainEvents/models/domainEventReceipt");
const {
  buildDomainEventReceiptRecoveryWorker,
  MAX_RECOVERY_ATTEMPTS,
} = require("../../src/modules/domainEvents/jobs/domainEventReceiptRecovery");
const {
  DomainEventReceiptRecovery,
  RECOVERY_LEASE_MS,
} = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery");
const {
  coordinatedOptimizationMetrics,
} = require("../../src/shared/observability/coordinatedOptimizationMetrics");

function event(key, overrides = {}) {
  const occurredAt = overrides.occurredAt || new Date("2026-09-11T12:00:00.000Z");
  return {
    eventKey: key,
    eventType: "RECEIPT_RELIABILITY_TEST_V1",
    schemaVersion: 1,
    aggregateType: "TEST_SOURCE",
    aggregateId: overrides.aggregateId || key,
    occurredAt,
    availableAt: overrides.availableAt || occurredAt,
    payload: overrides.payload || { key },
    audience: overrides.audience || [],
  };
}

describe("transactional domain-event receipt reliability", () => {
  beforeEach(async () => {
    await cleanDatabase();
    coordinatedOptimizationMetrics.reset();
  });

  it("creates exactly one outbox event and FINAL receipt in one transaction", async () => {
    const input = event("receipt-transactional:one", {
      audience: [{ recipientId: "recipient-1", facts: { source: "test" } }],
    });
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    });
    assert.equal(created.id, receipt.domainEventId);
    assert.equal(receipt.receiptState, "FINAL");
    assert.equal(await prisma.domainEventOutbox.count(), 1);
    assert.equal(await prisma.domainEventReceipt.count(), 1);
  });

  it("rolls back the event and receipt together", async () => {
    const input = event("receipt-transactional:rollback");
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await appendDomainEvent(tx, input);
        throw new Error("forced receipt transaction rollback");
      }),
      /forced receipt transaction rollback/,
    );
    assert.equal(await prisma.domainEventOutbox.count(), 0);
    assert.equal(await prisma.domainEventReceipt.count(), 0);
  });

  it("retries the same event idempotently and rejects an envelope collision", async () => {
    const input = event("receipt-transactional:retry");
    const first = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    const replay = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    assert.equal(replay.id, first.id);
    assert.equal(await prisma.domainEventOutbox.count(), 1);
    assert.equal(await prisma.domainEventReceipt.count(), 1);

    await assert.rejects(
      prisma.$transaction((tx) => appendDomainEvent(tx, {
        ...input,
        payload: { key: "different" },
      })),
      (error) => error?.code === "DOMAIN_EVENT_RECEIPT_COLLISION",
    );
  });

  it("bulk append creates matching FINAL receipts without one receipt write per event", async () => {
    const inputs = Array.from({ length: 12 }, (_, index) => event(`receipt-bulk:${index}`, {
      audience: [{ recipientId: `recipient-${index}`, facts: {} }],
    }));
    const result = await prisma.$transaction((tx) => bulkAppendDomainEvents(tx, inputs));
    assert.equal(result.inserted, inputs.length);
    assert.equal(result.dispositions.length, inputs.length);
    assert.equal(await prisma.domainEventOutbox.count(), inputs.length);
    assert.equal(await prisma.domainEventReceipt.count({ where: { receiptState: "FINAL" } }), inputs.length);
  });

  it("claims recovery candidates once and repairs the exact canonical envelope", async () => {
    const input = event("receipt-recovery:repair", {
      audience: [{ recipientId: "recovery-recipient", facts: { ordinal: 0 } }],
    });
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: input.eventKey,
        reason: "LEGACY_MISSING",
        availableAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    });

    const worker = buildDomainEventReceiptRecoveryWorker({ prisma, now: () => new Date("2026-09-11T12:00:00.000Z") });
    const [first, second] = await Promise.all([worker.drain({ batchSize: 1 }), worker.drain({ batchSize: 1 })]);
    assert.equal(first.claimed + second.claimed, 1);
    assert.equal(await prisma.domainEventReceipt.count({ where: { eventKey: input.eventKey, receiptState: "FINAL" } }), 1);
    assert.equal((await prisma.domainEventReceiptRecovery.findUnique({ where: { eventKey: input.eventKey } })).status, "SUCCEEDED");
    assert.equal(coordinatedOptimizationMetrics.snapshot().counters["domain_event_receipt_repaired_total{reason=LEGACY_MISSING}"], 1);
  });

  for (const transition of ["completed", "deleted"]) it(`revalidates a source ${transition} after the recovery batch read`, async () => {
    const input = event(`receipt-recovery:source-race:${transition}`);
    const created = await appendDomainEvent(prisma, input);
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await DomainEventReceiptRecovery.enqueue({
      domainEventId: created.id, eventKey: input.eventKey, reason: "LEGACY_MISSING",
    });
    const completedAt = new Date();
    const worker = buildDomainEventReceiptRecoveryWorker({ prisma,
      loadEvent: async (id) => {
        const stale = await prisma.domainEventOutbox.findUniqueOrThrow({
          where: { id }, include: { audience: true },
        });
        if (transition === "deleted") await prisma.domainEventOutbox.delete({ where: { id } });
        else await prisma.domainEventOutbox.update({ where: { id }, data: { status: "COMPLETED", completedAt } });
        return stale;
      },
    });
    const result = await worker.drain({ batchSize: 1 });
    const receipt = await prisma.domainEventReceipt.findUnique({ where: { eventKey: input.eventKey } });
    const candidate = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({ where: { eventKey: input.eventKey } });
    if (transition === "deleted") {
      assert.equal(result.succeeded, 0);
      assert.equal(receipt, null, "deleted source cannot acquire a fabricated successful receipt");
      assert.equal(candidate.status, "FAILED_TERMINAL");
      assert.equal(candidate.lastErrorCode, "SOURCE_DELETED");
    } else {
      assert.equal(result.succeeded, 1);
      assert.equal(receipt.terminalStatus, "COMPLETED");
      assert.equal(receipt.completedAt.toISOString(), completedAt.toISOString());
      assert.equal(candidate.status, "SUCCEEDED");
    }
  });

  it("revisits a discovery candidate after another transaction releases its row lock", async () => {
    const input = event("receipt-recovery:locked-discovery");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    const predecessor = await prisma.domainEventOutbox.findFirst({
      where: {
        OR: [
          { createdAt: { lt: created.createdAt } },
          { createdAt: created.createdAt, id: { lt: created.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });
    let releaseLock;
    let acquiredLock;
    const lockAcquired = new Promise((resolve) => { acquiredLock = resolve; });
    const lockReleased = new Promise((resolve) => { releaseLock = resolve; });
    const lock = prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT id FROM domain_event_outbox WHERE id=$1::uuid FOR UPDATE",
        created.id,
      );
      acquiredLock();
      await lockReleased;
    });
    await lockAcquired;
    const discovery = DomainEventReceiptRecovery.discoverPage({
      cutoff: new Date(created.createdAt.getTime() + 1),
      cursor: predecessor,
      limit: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseLock();
    await lock;
    const result = await discovery;
    assert.equal(result.discovered, 1);
    assert.equal(result.nextCursor.id, created.id);
    assert.equal(
      await prisma.domainEventReceiptRecovery.count({ where: { domainEventId: created.id } }),
      1,
    );
  });

  it("advances discovery across bounded source pages even when receipts are already final", async () => {
    const inputs = [event("bounded:final"), event("bounded:missing")];
    for (const input of inputs) await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventOutbox.update({ where: { eventKey: inputs[0].eventKey }, data: { createdAt: new Date("2026-09-01") } });
    await prisma.domainEventOutbox.update({ where: { eventKey: inputs[1].eventKey }, data: { createdAt: new Date("2026-09-02") } });
    await prisma.domainEventReceipt.delete({ where: { eventKey: inputs[1].eventKey } });
    const first = await DomainEventReceiptRecovery.discoverPage({ cutoff: new Date("2026-09-03"), limit: 1 });
    assert.equal(first.scanned, 1);
    assert.equal(first.discovered, 0, "a page must bound source rows before filtering missing receipts");
    assert.equal(first.exhausted, false);
    const second = await DomainEventReceiptRecovery.discoverPage({ cutoff: new Date("2026-09-03"), limit: 1, cursor: first.nextCursor });
    assert.equal(second.scanned, 1);
    assert.equal(second.discovered, 1);
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 1);
  });

  it("returns the durable creation time on claims for accurate queue-age telemetry", async () => {
    const createdAt = new Date("2026-09-01");
    await prisma.domainEventReceiptRecovery.create({ data: {
      domainEventId: require("node:crypto").randomUUID(), eventKey: "claim:age", reason: "LEGACY_MISSING",
      createdAt, availableAt: createdAt,
    } });
    const claim = await DomainEventReceiptRecovery.claimPage({ now: new Date("2026-09-02"), limit: 1 });
    assert.equal(claim.rows[0].createdAt?.toISOString(), createdAt.toISOString());
  });

  it("resumes persisted discovery after a restart without resetting its cutoff", async () => {
    await prisma.$executeRawUnsafe("DELETE FROM domain_event_receipt_discovery");
    for (const key of ["persisted:1", "persisted:2"]) {
      await prisma.$transaction((tx) => appendDomainEvent(tx, event(key)));
      await prisma.domainEventReceipt.delete({ where: { eventKey: key } });
    }
    const cutoff = new Date(Date.now() + 1000);
    const first = await DomainEventReceiptRecovery.discoverNextPage({ cutoff, limit: 1 });
    const freshModel = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery").buildDomainEventReceiptRecoveryModel(prisma);
    const second = await freshModel.discoverNextPage({ cutoff: new Date(cutoff.getTime() + 1000), limit: 1 });
    assert.notEqual(first.nextCursor.id, second.nextCursor.id);
    assert.equal(second.cutoff.toISOString(), cutoff.toISOString());
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 2);
  });

  it("reserves a claim slot for a fresh failure while older historical work is queued", async () => {
    const crypto = require("node:crypto");
    await prisma.domainEventReceiptRecovery.createMany({ data: [
      ...Array.from({ length: 12 }, (_, i) => ({ domainEventId: crypto.randomUUID(), eventKey: `fair:old:${i}`, reason: "LEGACY_MISSING", availableAt: new Date("2026-09-01") })),
      { domainEventId: crypto.randomUUID(), eventKey: "fair:fresh", reason: "COMPAT_PROVISIONAL", availableAt: new Date("2026-09-02") },
    ] });
    const claim = await DomainEventReceiptRecovery.claimPage({ now: new Date("2026-09-03"), limit: 5 });
    assert.equal(claim.rows.length, 5);
    assert.ok(claim.rows.some((row) => row.eventKey === "fair:fresh"));
  });

  it("enqueues only committed legacy gaps and avoids queue writes for normal appends", async () => {
    await prisma.$transaction((tx) => appendDomainEvent(tx, event("bridge:normal")));
    assert.equal(await prisma.domainEventReceiptRecovery.count(), 0);
    const input = event("bridge:legacy");
    await prisma.domainEventOutbox.create({ data: {
      eventKey: input.eventKey, eventType: input.eventType, schemaVersion: 1,
      aggregateType: input.aggregateType, aggregateId: input.aggregateId,
      occurredAt: input.occurredAt, availableAt: input.availableAt, payload: input.payload,
    } });
    const candidate = await prisma.domainEventReceiptRecovery.findUnique({ where: { eventKey: input.eventKey } });
    assert.equal(candidate?.reason, "COMPAT_PROVISIONAL");
    assert.equal(candidate?.status, "QUEUED");
  });

  it("uses lease compare-and-set, bounded retry backoff, and terminal quarantine", async () => {
    const input = event("receipt-recovery:terminal");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: input.eventKey,
        reason: "MALFORMED_SOURCE",
        availableAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    });
    const worker = buildDomainEventReceiptRecoveryWorker({
      prisma,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
      loadEvent: async () => ({ ...input, id: created.id, payload: null, audience: [] }),
    });
    for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
      const result = await worker.drain({ batchSize: 1 });
      assert.equal(result.claimed, 1);
      if (attempt === 0) {
        const retry = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({ where: { eventKey: input.eventKey } });
        const delay = retry.availableAt.getTime() - new Date("2026-09-11T12:00:00.000Z").getTime();
        assert.ok(delay >= 54_000 && delay <= 66_000, `first retry delay ${delay}ms must be one minute +/-10%`);
      }
      if (attempt < MAX_RECOVERY_ATTEMPTS - 1) {
        await prisma.domainEventReceiptRecovery.update({
          where: { eventKey: input.eventKey },
          data: { availableAt: new Date("2026-09-11T12:00:00.000Z"), status: "RETRY" },
        });
      }
    }
    const candidate = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({ where: { eventKey: input.eventKey } });
    assert.equal(candidate.status, "FAILED_TERMINAL");
    assert.equal(candidate.attemptCount, MAX_RECOVERY_ATTEMPTS);
    assert.equal(candidate.lastErrorCode, "MALFORMED_SOURCE");
    assert.equal(await prisma.domainEventReceipt.count(), 0);
    assert.equal(coordinatedOptimizationMetrics.snapshot().counters["domain_event_receipt_quarantined_total{reason=MALFORMED_SOURCE}"], 1);
  });

  it("does not make a retry eligible before availableAt and applies the next backoff", async () => {
    const initialNow = new Date("2026-09-11T12:00:00.000Z");
    let currentNow = initialNow;
    const input = event("receipt-recovery:backoff-gate");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: input.eventKey,
        reason: "MALFORMED_SOURCE",
        availableAt: initialNow,
      },
    });
    const worker = buildDomainEventReceiptRecoveryWorker({
      prisma,
      now: () => currentNow,
      loadEvent: async () => ({ ...input, id: created.id, payload: null, audience: [] }),
    });

    assert.deepEqual(await worker.drain({ batchSize: 1 }), {
      claimed: 1, succeeded: 0, failed: 1, terminalized: 0,
    });
    const firstRetry = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    });
    const firstDelay = firstRetry.availableAt.getTime() - initialNow.getTime();
    assert.ok(firstDelay >= 54_000 && firstDelay <= 66_000);

    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 0);
    currentNow = new Date(firstRetry.availableAt.getTime() - 1);
    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 0);
    currentNow = new Date(firstRetry.availableAt);
    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 1);
    const secondRetry = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { eventKey: input.eventKey },
    });
    const secondDelay = secondRetry.availableAt.getTime() - currentNow.getTime();
    assert.ok(secondDelay >= 270_000 && secondDelay <= 330_000);
  });

  it("rejects completion by an expired or superseded lease token", async () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    const input = event("receipt-recovery:stale-lease");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    const candidate = await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: input.eventKey,
        reason: "LEGACY_MISSING",
        availableAt: now,
      },
    });
    const firstClaim = await DomainEventReceiptRecovery.claimPage({ now, limit: 1 });
    assert.equal(firstClaim.rows.length, 1);
    const firstToken = firstClaim.rows[0].leaseToken;
    const leaseExpiry = new Date(now.getTime() + RECOVERY_LEASE_MS);

    assert.equal(await DomainEventReceiptRecovery.completeSuccess({
      id: candidate.id, leaseToken: firstToken, now: leaseExpiry,
    }), false);
    assert.equal((await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { id: candidate.id },
    })).status, "PROCESSING");

    const takeover = await DomainEventReceiptRecovery.claimPage({ now: leaseExpiry, limit: 1 });
    assert.equal(takeover.rows.length, 1);
    assert.notEqual(takeover.rows[0].leaseToken, firstToken);
    assert.deepEqual(await DomainEventReceiptRecovery.completeFailure({
      id: candidate.id,
      leaseToken: firstToken,
      errorCode: "STALE_WORKER",
      now: new Date(leaseExpiry.getTime() + 1),
    }), { applied: false });
    const current = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    assert.equal(current.status, "PROCESSING");
    assert.equal(current.attemptCount, 2);
    assert.equal(current.lastErrorCode, null);
  });

  it("reclaims an expired lease and repairs the candidate on the next drain", async () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    const input = event("receipt-recovery:lease-expiry");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: input.eventKey,
        reason: "LEGACY_MISSING",
        availableAt: now,
      },
    });
    const firstClaim = await DomainEventReceiptRecovery.claimPage({ now, limit: 1 });
    assert.equal(firstClaim.rows.length, 1);
    assert.equal((await DomainEventReceiptRecovery.claimPage({
      now: new Date(now.getTime() + RECOVERY_LEASE_MS - 1), limit: 1,
    })).rows.length, 0);
    const worker = buildDomainEventReceiptRecoveryWorker({
      prisma,
      now: () => new Date(now.getTime() + RECOVERY_LEASE_MS + 1),
    });
    const result = await worker.drain({ batchSize: 1 });
    assert.equal(result.claimed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal((await prisma.domainEventReceiptRecovery.findUniqueOrThrow({ where: { eventKey: input.eventKey } })).status, "SUCCEEDED");
  });

  it("terminally quarantines a candidate whose event key does not match its source event", async () => {
    const input = event("receipt-recovery:source-key");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: "receipt-recovery:wrong-source-key",
        reason: "LEGACY_MISSING",
        availableAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    });
    const worker = buildDomainEventReceiptRecoveryWorker({
      prisma,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
    });
    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 1);
    const candidate = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { eventKey: "receipt-recovery:wrong-source-key" },
    });
    assert.equal(candidate.status, "FAILED_TERMINAL");
    assert.equal(candidate.lastErrorCode, "SOURCE_EVENT_KEY_MISMATCH");
    assert.equal(await prisma.domainEventReceipt.count(), 0);
  });

  it("quarantines a source-key mismatch even when the source payload is malformed", async () => {
    const input = event("receipt-recovery:source-key-malformed");
    const created = await prisma.$transaction((tx) => appendDomainEvent(tx, input));
    await prisma.domainEventReceipt.delete({ where: { eventKey: input.eventKey } });
    const candidateKey = "receipt-recovery:wrong-source-key-malformed";
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: created.id,
        eventKey: candidateKey,
        reason: "LEGACY_MISSING",
        availableAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    });
    const worker = buildDomainEventReceiptRecoveryWorker({
      prisma,
      now: () => new Date("2026-09-11T12:00:00.000Z"),
      loadEvent: async () => ({ ...input, id: created.id, payload: null, audience: [] }),
    });
    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 1);
    const candidate = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({
      where: { eventKey: candidateKey },
    });
    assert.equal(candidate.status, "FAILED_TERMINAL");
    assert.equal(candidate.lastErrorCode, "SOURCE_EVENT_KEY_MISMATCH");
  });

  it("quarantines a missing source event as SOURCE_DELETED and retains evidence", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    await prisma.domainEventReceiptRecovery.create({
      data: {
        domainEventId: id,
        eventKey: "receipt-recovery:deleted",
        reason: "LEGACY_MISSING",
        availableAt: new Date("2026-09-11T12:00:00.000Z"),
      },
    });
    const worker = buildDomainEventReceiptRecoveryWorker({ prisma, now: () => new Date("2026-09-11T12:00:00.000Z") });
    assert.equal((await worker.drain({ batchSize: 1 })).claimed, 1);
    const candidate = await prisma.domainEventReceiptRecovery.findUniqueOrThrow({ where: { eventKey: "receipt-recovery:deleted" } });
    assert.equal(candidate.status, "FAILED_TERMINAL");
    assert.equal(candidate.lastErrorCode, "SOURCE_DELETED");
  });
});
