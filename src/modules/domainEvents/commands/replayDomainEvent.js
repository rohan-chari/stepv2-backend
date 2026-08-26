const { prisma: defaultPrisma } = require("../../../db");
const defaultRepository = require("../models/domainEventOutbox");

function buildReplayDomainEvent(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const repository = dependencies.repository || defaultRepository;
  const now = dependencies.now || (() => new Date());
  return async function replayDomainEvent({ eventIds = [], projectionIds = [] } = {}) {
    if ((!Array.isArray(eventIds) || !Array.isArray(projectionIds)) ||
        (eventIds.length === 0 && projectionIds.length === 0)) {
      throw new TypeError("explicit eventIds or projectionIds are required");
    }
    const current = now();
    return repository.replayTerminal(prisma, {
      eventIds,
      projectionIds,
      now: current,
    });
  };
}

module.exports = { buildReplayDomainEvent };
