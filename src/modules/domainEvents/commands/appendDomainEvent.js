const { TextEncoder } = require("node:util");

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
  const logger = dependencies.logger || console;

  return async function appendDomainEvent(tx, input) {
    if (!tx || typeof tx !== "object") throw new TypeError("transaction client is required");
    const event = normalizeDomainEvent(input);
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
      return result.event;
    }
    try {
      return await repository.createEvent(tx, event);
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

module.exports = {
  MAX_PAYLOAD_BYTES,
  DomainEventInvariantError,
  canonicalJson,
  normalizeDomainEvent,
  buildAppendDomainEvent,
};
