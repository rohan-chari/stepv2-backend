const { TextEncoder } = require("node:util");
const { deferUntilAfterCommit, isInPrismaTransactionScope } = require("../../../db");
const redisCache = require("../../../shared/cache/redisCache");

const MAX_PAYLOAD_BYTES = 64 * 1024;

class DomainEventInvariantError extends Error {
  constructor(message, code = "DOMAIN_EVENT_INVARIANT_VIOLATION") {
    super(message);
    this.name = "DomainEventInvariantError";
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    return Object.keys(value).sort().reduce((result, key) => {
      const item = value[key];
      if (item !== undefined) result[key] = canonicalize(item);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function asDate(value, field) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid date`);
  }
  return date;
}

function requiredBoundedString(value, field, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function normalizeAudience(audience = []) {
  if (!Array.isArray(audience)) throw new TypeError("audience must be an array");
  const recipients = new Set();
  return audience.map((entry, index) => {
    const source = typeof entry === "string" ? { recipientId: entry } : entry;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError("audience entries must be recipient IDs or objects");
    }
    const recipientId = requiredBoundedString(source.recipientId, "recipientId", 191);
    if (recipients.has(recipientId)) {
      throw new DomainEventInvariantError(`duplicate audience recipient ${recipientId}`);
    }
    recipients.add(recipientId);
    const facts = source.facts == null ? {} : source.facts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
      throw new TypeError("audience facts must be an object");
    }
    return { recipientId, ordinal: index, facts: canonicalize(facts) };
  });
}

function normalizeDomainEvent(input = {}) {
  const occurredAt = asDate(input.occurredAt, "occurredAt");
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("payload must be an object");
  }
  const normalized = {
    eventKey: requiredBoundedString(input.eventKey, "eventKey", 255),
    eventType: requiredBoundedString(input.eventType, "eventType", 96),
    schemaVersion: input.schemaVersion == null ? 1 : input.schemaVersion,
    aggregateType: requiredBoundedString(input.aggregateType, "aggregateType", 64),
    aggregateId: requiredBoundedString(input.aggregateId, "aggregateId", 191),
    occurredAt,
    availableAt: input.availableAt == null
      ? new Date(occurredAt)
      : asDate(input.availableAt, "availableAt"),
    payload: canonicalize(payload),
    audience: normalizeAudience(input.audience || []),
  };
  if (!Number.isInteger(normalized.schemaVersion) || normalized.schemaVersion < 1) {
    throw new TypeError("schemaVersion must be a positive integer");
  }
  const payloadBytes = new TextEncoder().encode(canonicalJson(normalized.payload)).length;
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new DomainEventInvariantError(
      `domain event payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      "DOMAIN_EVENT_PAYLOAD_TOO_LARGE",
    );
  }
  return normalized;
}

function equalDate(left, right) {
  return new Date(left).getTime() === new Date(right).getTime();
}

function sameImmutableEvent(stored, expected) {
  return stored &&
    stored.eventKey === expected.eventKey &&
    stored.eventType === expected.eventType &&
    stored.schemaVersion === expected.schemaVersion &&
    stored.aggregateType === expected.aggregateType &&
    stored.aggregateId === expected.aggregateId &&
    equalDate(stored.occurredAt, expected.occurredAt) &&
    equalDate(stored.availableAt, expected.availableAt) &&
    canonicalJson(stored.payload) === canonicalJson(expected.payload);
}

function sameAudience(stored = [], expected = []) {
  if (stored.length !== expected.length) return false;
  return stored.every((row, index) => {
    const wanted = expected[index];
    return row.recipientId === wanted.recipientId &&
      row.ordinal === wanted.ordinal &&
      canonicalJson(row.facts || {}) === canonicalJson(wanted.facts || {});
  });
}

function buildAppendDomainEvent(dependencies = {}) {
  const repository = dependencies.repository || require("../models/domainEventOutbox");
  const receiptModel = dependencies.receiptModel ||
    (dependencies.repository ? null : require("../models/domainEventReceipt").DomainEventReceipt);
  const logger = dependencies.logger || console;
  const publishWake = dependencies.publishWake ||
    (() => redisCache.publishDurableQueueWakeup("domain-event"));
  const publishAfterCommit = () => isInPrismaTransactionScope()
    ? deferUntilAfterCommit(publishWake)
    : publishWake();

  return async function appendDomainEvent(tx, input) {
    if (!tx || typeof tx !== "object") throw new TypeError("transaction client is required");
    const event = normalizeDomainEvent(input);
    const replaySourceType = input.replaySourceType || event.aggregateType;
    const replaySourceId = input.replaySourceId || event.aggregateId;
    const receiptsAvailable = Boolean(receiptModel && tx.domainEventReceipt);
    if (receiptsAvailable) {
      const receipt = await receiptModel.findByEventKey(event.eventKey, tx);
      if (receipt?.receiptState === "FINAL") {
        receiptModel.assertEnvelope(receipt, event);
        receiptModel.assertIdentity?.(receipt, {
          domainEventId: receipt.domainEventId,
          replaySourceType,
          replaySourceId,
        });
        const stored = await repository.findByEventKey(tx, event.eventKey);
        if (stored) {
          receiptModel.assertIdentity?.(receipt, {
            domainEventId: stored.id,
            replaySourceType,
            replaySourceId,
          });
          if (!sameImmutableEvent(stored, event) ||
              !sameAudience(stored.audience || [], event.audience)) {
            throw new DomainEventInvariantError(
              `eventKey ${event.eventKey} was reused with different immutable facts`,
            );
          }
          return { ...stored, terminalStatus: receipt.terminalStatus, receiptOnly: false };
        }
        return {
          id: receipt.domainEventId,
          eventKey: receipt.eventKey,
          eventType: receipt.eventType,
          status: receipt.terminalStatus,
          terminalStatus: receipt.terminalStatus,
          receiptOnly: true,
        };
      }
    }
    if (typeof repository.insertEventIfAbsent === "function" &&
        typeof tx.$queryRawUnsafe === "function") {
      const result = await repository.insertEventIfAbsent(tx, event);
      if (!sameImmutableEvent(result.event, event) ||
          !sameAudience(result.event?.audience || [], event.audience)) {
        throw new DomainEventInvariantError(
          `eventKey ${event.eventKey} was reused with different immutable facts`,
        );
      }
      if (!result.inserted) logger.log?.("[DOMAIN_EVENT] idempotent append replay", {
        eventId: result.event.id, eventType: result.event.eventType,
      });
      if (receiptsAvailable) await receiptModel.finalize({
        envelope: event,
        domainEventId: result.event.id,
        replaySourceType,
        replaySourceId,
      }, tx);
      if (result.inserted) await publishAfterCommit();
      return result.event;
    }
    try {
      const created = await repository.createEvent(tx, event);
      await publishAfterCommit();
      return created;
    } catch (error) {
      if (error?.code !== "P2002" && error?.code !== "23505") throw error;
      const stored = await repository.findByEventKey(tx, event.eventKey);
      if (!sameImmutableEvent(stored, event) || !sameAudience(stored?.audience || [], event.audience)) {
        throw new DomainEventInvariantError(
          `eventKey ${event.eventKey} was reused with different immutable facts`,
        );
      }
      logger.log?.("[DOMAIN_EVENT] idempotent append replay", {
        eventId: stored.id, eventType: stored.eventType,
      });
      return stored;
    }
  };
}

function buildBulkAppendDomainEvents(dependencies = {}) {
  const repository = dependencies.repository || require("../models/domainEventOutbox");
  const receiptModel = dependencies.receiptModel ||
    (dependencies.repository ? null : require("../models/domainEventReceipt").DomainEventReceipt);
  const publishWake = dependencies.publishWake ||
    (() => redisCache.publishDurableQueueWakeup("domain-event"));
  const publishAfterCommit = () => isInPrismaTransactionScope()
    ? deferUntilAfterCommit(publishWake)
    : publishWake();
  return async function bulkAppendDomainEvents(tx, inputs) {
    if (!tx || typeof tx !== "object") throw new TypeError("transaction client is required");
    if (!Array.isArray(inputs)) throw new TypeError("events must be an array");
    // All envelopes are normalized before the first SQL write. A malformed
    // event can therefore never leave an earlier event/baseline committed.
    const events = inputs.map(normalizeDomainEvent);
    const replaySourceByEventKey = new Map(inputs.map((input, index) => [
      events[index].eventKey,
      {
        replaySourceType: input.replaySourceType || events[index].aggregateType,
        replaySourceId: input.replaySourceId || events[index].aggregateId,
      },
    ]));
    const keys = new Set();
    const receiptFinalizations = [];
    for (const event of events) {
      if (keys.has(event.eventKey)) {
        throw new DomainEventInvariantError(`duplicate eventKey ${event.eventKey} in bulk append`);
      }
      keys.add(event.eventKey);
    }
    if (events.length === 0) {
      return { inserted: 0, replayed: 0, statementCount: 0 };
    }
    const receiptOnlyKeys = new Set();
    const receiptByKey = new Map();
    const receiptsAvailable = Boolean(receiptModel && tx.domainEventReceipt);
    if (receiptsAvailable) {
      const receipts = await tx.domainEventReceipt.findMany({
        where: { eventKey: { in: events.map((event) => event.eventKey) } },
      });
      const liveKeys = new Set((await tx.domainEventOutbox.findMany({
        where: { eventKey: { in: receipts.map((receipt) => receipt.eventKey) } },
        select: { eventKey: true },
      })).map((row) => row.eventKey));
      const eventByKey = new Map(events.map((event) => [event.eventKey, event]));
      for (const receipt of receipts) {
        receiptByKey.set(receipt.eventKey, receipt);
        if (receipt.receiptState !== "FINAL") continue;
        receiptModel.assertEnvelope(receipt, eventByKey.get(receipt.eventKey));
        const expected = eventByKey.get(receipt.eventKey);
        receiptModel.assertIdentity?.(receipt, {
          domainEventId: receipt.domainEventId,
          ...replaySourceByEventKey.get(expected.eventKey),
        });
        if (!liveKeys.has(receipt.eventKey)) receiptOnlyKeys.add(receipt.eventKey);
      }
    }
    const insertable = events.filter((event) => !receiptOnlyKeys.has(event.eventKey));
    const result = await repository.insertEventsIfAbsent(tx, insertable);
    const storedByKey = new Map(result.rows.map((row) => [row.eventKey, row]));
    for (const event of events) {
      if (receiptOnlyKeys.has(event.eventKey)) continue;
      const stored = storedByKey.get(event.eventKey);
      if (!sameImmutableEvent(stored, event) ||
          !sameAudience(stored?.audience || [], event.audience)) {
        throw new DomainEventInvariantError(
          `eventKey ${event.eventKey} was reused with different immutable facts`,
        );
      }
      if (receiptsAvailable) receiptFinalizations.push({
        envelope: event,
        domainEventId: stored.id,
        ...replaySourceByEventKey.get(event.eventKey),
      });
    }
    if (receiptFinalizations.length) {
      if (typeof receiptModel.finalizeMany === "function") {
        await receiptModel.finalizeMany({ items: receiptFinalizations }, tx);
      } else {
        for (const item of receiptFinalizations) await receiptModel.finalize(item, tx);
      }
    }
    if (result.insertedEventKeys.size > 0) await publishAfterCommit();
    const dispositions = events.map((event, ordinal) => {
      const receipt = receiptByKey.get(event.eventKey);
      const stored = storedByKey.get(event.eventKey);
      return {
        ordinal,
        eventKey: event.eventKey,
        domainEventId: receipt?.domainEventId || stored?.id || null,
        disposition: receiptOnlyKeys.has(event.eventKey)
          ? "RECEIPT_ONLY"
          : result.insertedEventKeys.has(event.eventKey) ? "INSERTED" : "REPLAYED",
        terminalStatus: receipt?.terminalStatus || null,
      };
    });
    return {
      inserted: result.insertedEventKeys.size,
      replayed: events.length - result.insertedEventKeys.size,
      receiptOnly: receiptOnlyKeys.size,
      statementCount: result.statementCount || 0,
      dispositions,
    };
  };
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  DomainEventInvariantError,
  canonicalJson,
  normalizeDomainEvent,
  buildAppendDomainEvent,
  buildBulkAppendDomainEvents,
};
