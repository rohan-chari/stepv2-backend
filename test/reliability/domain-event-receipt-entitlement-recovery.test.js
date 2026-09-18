const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

// These reconciliation/root-writer failure states have no HTTP entry point.
// Exercise the real worker writers and PostgreSQL transactions directly.
const database = new URL(process.env.DATABASE_URL || "postgresql://invalid/");
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
assert.ok(["postgres:", "postgresql:"].includes(database.protocol));
assert.match(database.pathname, /_test$/);

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  appendScheduledEntitlementEventsBatch,
  materializePreparedEntitlementsSetBased,
} = require("../../src/modules/steps/services/globalStepEventEntitlement");
const { appendDomainEvent, bulkAppendDomainEvents } = require("../../src/modules/domainEvents");
const redisCache = require("../../src/shared/cache/redisCache");

const originalTime = new Date("2098-12-01T08:00:00.000Z");
const retryTime = new Date("2098-12-01T09:00:00.000Z");

async function fixture() {
  const { user } = await createTestUser();
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt: new Date("2098-12-01T12:00:00.000Z"),
    endsAt: new Date("2098-12-01T12:30:00.000Z"),
    multiplier: 2, scheduleMode: "LOCAL_ENTITLEMENTS", eventDay: "2098-12-01",
    localStartMinute: 720, durationMinutes: 30,
  } });
  const entitlement = await prisma.globalStepEventEntitlement.create({ data: {
    eventId: event.id, userId: user.id, timezone: "UTC", localDate: event.eventDay,
    startsAt: event.startsAt, endsAt: event.endsAt,
  } });
  return { event, entitlement };
}

const writers = {
  batch: (tx, { event, entitlement }, occurredAt) =>
    appendScheduledEntitlementEventsBatch(tx, { event, entitlements: [entitlement], occurredAt }),
  materialize: (tx, { event, entitlement }, occurredAt) =>
    materializePreparedEntitlementsSetBased(tx, {
      event, prepared: [entitlement], occurredAt, generationReady: true,
    }),
};

async function initialPublication(context) {
  await prisma.$transaction(tx => writers.batch(tx, context, originalTime));
  return prisma.domainEventOutbox.findFirstOrThrow({
    include: { audience: { orderBy: { ordinal: "asc" } } },
  });
}

function assertCount(name, result) {
  assert.deepEqual(result, name === "batch" ? 1 : { created: 0, selected: 1, events: 1 });
}

describe("entitlement receipt publication recovery", () => {
  beforeEach(cleanDatabase);

  for (const [name, write] of Object.entries(writers)) {
    for (const occurredAt of [originalTime, retryTime]) {
      it(`${name} restores a missing nonterminal publication at ${occurredAt.toISOString()}`, async () => {
        const context = await fixture();
        const original = await initialPublication(context);
        const receipt = await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey: original.eventKey } });
        assert.equal(receipt.receiptState, "FINAL");
        assert.equal(receipt.terminalStatus, null);
        await prisma.domainEventOutbox.delete({ where: { id: original.id } });

        assertCount(name, await prisma.$transaction(tx => write(tx, context, occurredAt)));
        const recovered = await prisma.domainEventOutbox.findUniqueOrThrow({
          where: { eventKey: original.eventKey }, include: { audience: { orderBy: { ordinal: "asc" } } },
        });
        assert.equal(recovered.id, original.id);
        assert.equal(recovered.status, "PENDING");
        assert.deepEqual(recovered.occurredAt, original.occurredAt);
        assert.deepEqual(recovered.availableAt, original.availableAt);
        assert.deepEqual(recovered.payload, original.payload);
        assert.deepEqual(recovered.audience.map(({ recipientId, ordinal, facts }) => ({ recipientId, ordinal, facts })),
          original.audience.map(({ recipientId, ordinal, facts }) => ({ recipientId, ordinal, facts })));
        assert.equal((await prisma.domainEventReceipt.findUniqueOrThrow({ where: { eventKey: original.eventKey } })).envelopeDigest,
          receipt.envelopeDigest);
        assertCount(name, await prisma.$transaction(tx => write(tx, context, retryTime)));
        assert.equal(await prisma.domainEventOutbox.count(), 1);
        assert.equal(await prisma.domainEventReceipt.count(), 1);
      });
    }

    it(`${name} wakes publication only after recovery commits and rolls back a failed recovery`, async (t) => {
      const context = await fixture();
      const original = await initialPublication(context);
      await prisma.domainEventOutbox.delete({ where: { id: original.id } });
      const wake = t.mock.method(redisCache, "publishDurableQueueWakeup", async () => true);

      await assert.rejects(prisma.$transaction(async tx => {
        assertCount(name, await write(tx, context, retryTime));
        assert.equal(wake.mock.callCount(), 0);
        throw new Error("forced recovery rollback");
      }), /forced recovery rollback/);
      assert.equal(wake.mock.callCount(), 0);
      assert.equal(await prisma.domainEventOutbox.count(), 0);
      assert.equal(await prisma.domainEventAudience.count(), 0);
      assert.equal(await prisma.domainEventReceipt.count(), 1);

      await prisma.$transaction(async tx => {
        assertCount(name, await write(tx, context, retryTime));
        assert.equal(wake.mock.callCount(), 0);
      });
      assert.equal(wake.mock.callCount(), 1);
      assert.deepEqual(wake.mock.calls[0].arguments, ["domain-event"]);
    });

    it(`${name} counts a terminal receipt-only replay once without republishing`, async () => {
      const context = await fixture();
      const original = await initialPublication(context);
      await prisma.domainEventReceipt.update({ where: { eventKey: original.eventKey },
        data: { terminalStatus: "COMPLETED", completedAt: originalTime } });
      await prisma.domainEventOutbox.delete({ where: { id: original.id } });
      assertCount(name, await prisma.$transaction(tx => write(tx, context, originalTime)));
      assertCount(name, await prisma.$transaction(tx => write(tx, context, retryTime)));
      assert.equal(await prisma.domainEventOutbox.count(), 0);
      assert.equal(await prisma.domainEventReceipt.count(), 1);
    });

    for (const mutation of ["payload", "source", "provisional"]) {
      it(`${name} rejects ${mutation} mismatch before restoring publication`, async () => {
        const context = await fixture();
        const original = await initialPublication(context);
        await prisma.domainEventOutbox.delete({ where: { id: original.id } });
        if (mutation === "payload") context.event.multiplier = 3;
        else await prisma.domainEventReceipt.update({ where: { eventKey: original.eventKey }, data:
          mutation === "source" ? { replaySourceId: "wrong-source" } : {
            receiptState: "PROVISIONAL", envelopeDigest: null, finalizedAt: null,
          },
        });
        await assert.rejects(prisma.$transaction(tx => write(tx, context, retryTime)),
          error => error.code === "DOMAIN_EVENT_RECEIPT_COLLISION");
        assert.equal(await prisma.domainEventOutbox.count(), 0);
        assert.equal(await prisma.domainEventAudience.count(), 0);
      });
    }
  }
});

describe("root-client append transaction ownership", () => {
  beforeEach(cleanDatabase);

  for (const bulk of [false, true]) {
    it(`${bulk ? "bulk" : "single"} rolls back outbox and audience when FINAL receipt insertion fails`, async () => {
      const input = {
        eventKey: "entitlement-root-rollback", eventType: "TEST_V1", schemaVersion: 1,
        aggregateType: "TEST", aggregateId: "root-rollback", occurredAt: originalTime,
        availableAt: originalTime, payload: {}, audience: [{ recipientId: "test-recipient", facts: {} }],
      };
      await prisma.$executeRawUnsafe(`ALTER TABLE domain_event_receipts ADD CONSTRAINT
        entitlement_test_reject_final CHECK (receipt_state <> 'FINAL')`);
      try {
        await assert.rejects(bulk ? bulkAppendDomainEvents(prisma, [input]) : appendDomainEvent(prisma, input),
          /entitlement_test_reject_final/);
        assert.equal(await prisma.domainEventOutbox.count(), 0, "failed root append must not commit an outbox row");
        assert.equal(await prisma.domainEventAudience.count(), 0);
        assert.equal(await prisma.domainEventReceipt.count(), 0);
      } finally {
        await prisma.$executeRawUnsafe("ALTER TABLE domain_event_receipts DROP CONSTRAINT entitlement_test_reject_final");
      }
    });
  }
});
