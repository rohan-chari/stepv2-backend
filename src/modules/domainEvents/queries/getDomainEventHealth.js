const { prisma: defaultPrisma } = require("../../../db");
const defaultRepository = require("../models/domainEventOutbox");

function buildGetDomainEventHealth(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const repository = dependencies.repository || defaultRepository;
  const now = dependencies.now || (() => new Date());
  return async function getDomainEventHealth() {
    const current = now();
    const {
      pendingByType,
      projectionByStatus,
      oldestEvent,
      oldestProjection,
      downstream,
      terminalFailures,
    } = await repository.readHealthSnapshot(prisma);
    const ageMs = (date) => date ? Math.max(0, current.getTime() - new Date(date).getTime()) : 0;
    return {
      pendingByType: pendingByType.map((row) => ({
        eventType: row.eventType,
        count: row._count._all,
        oldestAgeMs: ageMs(row._min.availableAt),
      })),
      projectionsByStatus: projectionByStatus.map((row) => ({
        status: row.status, count: row._count._all, oldestAgeMs: ageMs(row._min.availableAt),
      })),
      oldestEvent: oldestEvent ? { ...oldestEvent, ageMs: ageMs(oldestEvent.availableAt) } : null,
      oldestProjection: oldestProjection ? { ...oldestProjection, ageMs: ageMs(oldestProjection.availableAt) } : null,
      downstream: { pendingSchedules: downstream[0], pendingInboxOutbox: downstream[1] },
      terminalFailures: { events: terminalFailures[0], projections: terminalFailures[1] },
      domainHealthy: true,
      notificationBacklogAlert: terminalFailures[0] > 0 || terminalFailures[1] > 0 ||
        ageMs(oldestEvent?.availableAt) > 60_000 || ageMs(oldestProjection?.availableAt) > 60_000,
    };
  };
}

module.exports = { buildGetDomainEventHealth };
