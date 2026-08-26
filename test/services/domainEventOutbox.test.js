const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  MAX_PAYLOAD_BYTES,
  appendDomainEvent,
  canonicalJson,
  normalizeDomainEvent,
} = require("../../src/modules/domainEvents");

describe("durable domain-event append contract", () => {
  it("canonicalizes object keys without changing array order", () => {
    assert.equal(
      canonicalJson({ z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] }),
      '{"list":[{"x":1,"y":2}],"nested":{"a":1,"b":2},"z":1}',
    );
  });

  it("locks the exact additive V1 append shape and defaults availableAt", () => {
    const occurredAt = new Date("2026-08-25T12:00:00.000Z");
    const event = normalizeDomainEvent({
      eventKey: "FRIEND_REQUEST_SENT_V1:friendship-1",
      eventType: "FRIEND_REQUEST_SENT_V1",
      schemaVersion: 1,
      aggregateType: "FRIENDSHIP",
      aggregateId: "friendship-1",
      occurredAt,
      payload: { friendshipId: "friendship-1" },
    });
    assert.equal(event.availableAt.toISOString(), occurredAt.toISOString());
    assert.equal(event.eventKey, "FRIEND_REQUEST_SENT_V1:friendship-1");
  });

  it("rejects a payload larger than 64 KiB before repository access", async () => {
    let touched = false;
    const tx = { domainEventOutbox: { create: async () => { touched = true; } } };
    await assert.rejects(
      appendDomainEvent(tx, {
        eventKey: "TEST_V1:oversize",
        eventType: "TEST_V1",
        schemaVersion: 1,
        aggregateType: "TEST",
        aggregateId: "oversize",
        occurredAt: new Date(),
        payload: { text: "x".repeat(MAX_PAYLOAD_BYTES) },
      }),
      (error) => error?.code === "DOMAIN_EVENT_PAYLOAD_TOO_LARGE",
    );
    assert.equal(touched, false);
  });

  it("create-or-confirm-identical rejects an event-key collision", async () => {
    const stored = {
      id: "event-1",
      eventKey: "TEST_V1:source-1",
      eventType: "TEST_V1",
      schemaVersion: 1,
      aggregateType: "TEST",
      aggregateId: "source-1",
      occurredAt: new Date("2026-08-25T12:00:00.000Z"),
      availableAt: new Date("2026-08-25T12:00:00.000Z"),
      payload: { value: 1 },
    };
    const tx = { domainEventOutbox: {
      create: async () => { const error = new Error("unique"); error.code = "P2002"; throw error; },
      findUnique: async () => stored,
    } };
    await assert.rejects(
      appendDomainEvent(tx, {
        eventKey: stored.eventKey,
        eventType: stored.eventType,
        schemaVersion: 1,
        aggregateType: stored.aggregateType,
        aggregateId: stored.aggregateId,
        occurredAt: stored.occurredAt,
        payload: { value: 2 },
      }),
      (error) => error?.code === "DOMAIN_EVENT_INVARIANT_VIOLATION",
    );
  });
});
