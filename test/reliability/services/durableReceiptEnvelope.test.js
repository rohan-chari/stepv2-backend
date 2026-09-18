const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalDomainEventEnvelope,
  digestDomainEventEnvelope,
} = require("../../src/modules/domainEvents/models/domainEventReceipt");

function envelope(overrides = {}) {
  return {
    eventKey: "race:r1:placement:g2",
    eventType: "RACE_PLACEMENT_CHANGED",
    schemaVersion: 1,
    aggregateType: "race",
    aggregateId: "r1",
    occurredAt: new Date("2026-09-02T12:00:00.000Z"),
    availableAt: new Date("2026-09-02T12:00:05.000Z"),
    payload: { z: 1, nested: { b: 2, a: 1 } },
    audience: [
      { ordinal: 1, recipientId: "u2", facts: { role: "target" } },
      { ordinal: 0, recipientId: "u1", facts: { role: "actor" } },
    ],
    ...overrides,
  };
}

test("event receipt digest covers a canonical full immutable envelope", () => {
  const first = digestDomainEventEnvelope(envelope());
  const reordered = digestDomainEventEnvelope(envelope({
    payload: { nested: { a: 1, b: 2 }, z: 1 },
    audience: [...envelope().audience].reverse(),
  }));
  assert.equal(first, reordered);
  assert.match(first, /^[a-f0-9]{64}$/);

  const immutableVariants = [
    { eventKey: "different" },
    { eventType: "OTHER" },
    { schemaVersion: 2 },
    { aggregateType: "user" },
    { aggregateId: "r2" },
    { occurredAt: new Date("2026-09-02T12:00:01.000Z") },
    { availableAt: new Date("2026-09-02T12:00:06.000Z") },
    { payload: { z: 2, nested: { b: 2, a: 1 } } },
    { audience: [{ ordinal: 0, recipientId: "u1", facts: { role: "other" } }] },
  ];
  for (const variant of immutableVariants) {
    assert.notEqual(digestDomainEventEnvelope(envelope(variant)), first);
  }
});

test("canonical envelope rejects duplicate audience ordinals", () => {
  assert.throws(
    () => canonicalDomainEventEnvelope(envelope({
      audience: [
        { ordinal: 0, recipientId: "u1", facts: {} },
        { ordinal: 0, recipientId: "u2", facts: {} },
      ],
    })),
    /audience ordinal/,
  );
});
