const {
  MAX_PAYLOAD_BYTES,
  canonicalJson,
  normalizeDomainEvent,
  buildAppendDomainEvent,
  buildBulkAppendDomainEvents,
} = require("./commands/appendDomainEvent");

const appendDomainEvent = buildAppendDomainEvent();
const bulkAppendDomainEvents = buildBulkAppendDomainEvents();

// Publish the domain-only append surface before loading projector/cron modules.
// Notification handlers depend on domain commands that import this index; an
// eager all-at-once export would expose `appendDomainEvent` as undefined during
// that CommonJS cycle.
module.exports = {
  MAX_PAYLOAD_BYTES,
  canonicalJson,
  normalizeDomainEvent,
  buildAppendDomainEvent,
  buildBulkAppendDomainEvents,
  appendDomainEvent,
  bulkAppendDomainEvents,
};

// Producers import this module for the append surface while several legacy
// notification handlers still import those same producers. Keep operational
// exports lazy so a domain write cannot eagerly pull the projector (and the
// notification graph) into a CommonJS initialization cycle.
const lazyExports = {
  buildReplayDomainEvent: ["./commands/replayDomainEvent", "buildReplayDomainEvent"],
  buildGetDomainEventHealth: ["./queries/getDomainEventHealth", "buildGetDomainEventHealth"],
  buildDomainEventProjectionJob: ["./jobs/domainEventProjection", "buildDomainEventProjectionJob"],
  scheduleDomainEventProjection: ["./jobs/domainEventProjection", "scheduleDomainEventProjection"],
  buildDomainEventRetention: ["./jobs/domainEventRetention", "buildDomainEventRetention"],
  scheduleDomainEventRetention: ["./jobs/domainEventRetention", "scheduleDomainEventRetention"],
};

for (const [exportName, [modulePath, memberName]] of Object.entries(lazyExports)) {
  Object.defineProperty(module.exports, exportName, {
    configurable: false,
    enumerable: true,
    get() { return require(modulePath)[memberName]; },
  });
}
