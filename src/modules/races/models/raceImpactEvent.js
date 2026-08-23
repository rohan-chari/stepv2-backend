const { prisma: defaultPrisma } = require("../../../db");

const CALCULATION_VERSION = 2;
const VALUE_STATUS = "SYNCED_SNAPSHOT";
const PRESENTATION_PREFIX = "impact:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function presentationId(id) {
  return typeof id === "string" && UUID_PATTERN.test(id)
    ? `${PRESENTATION_PREFIX}${id}`
    : null;
}

function parsePresentationId(value) {
  if (typeof value !== "string" || !value.startsWith(PRESENTATION_PREFIX)) {
    return null;
  }
  const id = value.slice(PRESENTATION_PREFIX.length);
  return UUID_PATTERN.test(id) ? id : null;
}

function isValidEvent(row) {
  return Boolean(
    row &&
      presentationId(row.id) &&
      typeof row.powerupType === "string" && row.powerupType.length > 0 &&
      Number.isInteger(row.deltaSteps) && row.deltaSteps !== 0 &&
      typeof row.description === "string" && row.description.trim().length > 0 &&
      row.valueStatus === VALUE_STATUS &&
      row.calculationVersion === CALCULATION_VERSION &&
      row.resolvedAt instanceof Date && Number.isFinite(row.resolvedAt.getTime())
  );
}

function popupProjection(row) {
  if (!isValidEvent(row)) return null;
  return {
    id: presentationId(row.id),
    powerupType: row.powerupType,
    deltaSteps: row.deltaSteps,
    description: row.description,
    sourceFeedEventId:
      typeof row.sourceFeedEventId === "string" ? row.sourceFeedEventId : null,
    impactScope: "ACTIVE_SYNCED_SNAPSHOT",
    valueStatus: VALUE_STATUS,
    resolvedAt: row.resolvedAt,
  };
}

function activityProjection(row) {
  const popup = popupProjection(row);
  if (!popup) return null;
  return {
    id: popup.id,
    eventType: "EFFECT_IMPACT",
    powerupType: popup.powerupType,
    deltaSteps: popup.deltaSteps,
    description: popup.description,
    sourceFeedEventId: popup.sourceFeedEventId,
    impactScope: popup.impactScope,
    valueStatus: popup.valueStatus,
    createdAt: popup.resolvedAt,
  };
}

function impactDescription(powerupType, deltaSteps) {
  const title = String(powerupType || "Effect")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
  const amount = Math.abs(deltaSteps).toLocaleString("en-US");
  return deltaSteps > 0
    ? `You gained ${amount} synced steps from ${title}.`
    : `You lost ${amount} synced steps to ${title}.`;
}

function buildRaceImpactEventModel(prisma = defaultPrisma) {
  return {
    async createDirectSource({
      event,
      powerupType,
      deltas = [],
      receiptRecipientUserId = null,
    }) {
      return prisma.$transaction(async (tx) => {
        const source = await tx.racePowerupEvent.create({ data: event });
        const canonical = (deltas || []).filter((delta) =>
          typeof delta?.userId === "string" &&
          Number.isInteger(delta.deltaSteps) &&
          delta.deltaSteps !== 0
        );
        if (canonical.length > 0) {
          await tx.raceImpactEvent.createMany({
            data: canonical.map((delta) => ({
              raceId: source.raceId,
              recipientUserId: delta.userId,
              sourceKind: "POWERUP_EVENT",
              sourceId: source.id,
              sourceFeedEventId: source.id,
              powerupType,
              deltaSteps: delta.deltaSteps,
              description: impactDescription(powerupType, delta.deltaSteps),
              valueStatus: VALUE_STATUS,
              calculationVersion: CALCULATION_VERSION,
              resolvedAt: source.createdAt,
            })),
            skipDuplicates: true,
          });
        }
        const impacts = canonical.length === 0 ? [] : await tx.raceImpactEvent.findMany({
          where: {
            raceId: source.raceId,
            sourceKind: "POWERUP_EVENT",
            sourceId: source.id,
            calculationVersion: CALCULATION_VERSION,
          },
        });
        return {
          event: source,
          work: impacts.map((impact) => ({
            ...impact,
            inlineReceiptId: impact.recipientUserId === receiptRecipientUserId
              ? presentationId(impact.id)
              : null,
          })),
        };
      });
    },

    async getRaceAccess({ raceId, userId }, client = prisma) {
      return client.race.findUnique({
        where: { id: raceId },
        select: {
          id: true,
          status: true,
          participants: {
            where: { userId, status: "ACCEPTED" },
            select: { id: true },
            take: 1,
          },
        },
      });
    },

    async listUnacknowledged({ raceId, userId, limit = 20, resolvedAfter = null }, client = prisma) {
      return client.raceImpactEvent.findMany({
        where: {
          raceId,
          recipientUserId: userId,
          popupAcknowledgedAt: null,
          calculationVersion: CALCULATION_VERSION,
          ...(resolvedAfter instanceof Date && Number.isFinite(resolvedAfter.getTime())
            ? { resolvedAt: { gt: resolvedAfter } }
            : {}),
        },
        orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
        take: Math.min(20, Math.max(1, Number(limit) || 20)),
      });
    },

    async listActivity({ raceId, userId, cursor = null, limit = 50 }, client = prisma) {
      return client.raceImpactEvent.findMany({
        where: {
          raceId,
          recipientUserId: userId,
          calculationVersion: CALCULATION_VERSION,
          ...(cursor ? {
            OR: [
              { resolvedAt: { lt: cursor.resolvedAt } },
              { resolvedAt: cursor.resolvedAt, id: { lt: cursor.id } },
            ],
          } : {}),
        },
        orderBy: [{ resolvedAt: "desc" }, { id: "desc" }],
        take: Math.min(50, Math.max(1, Number(limit) || 50)) + 1,
      });
    },

    async findOwn({ raceId, userId, id }, client = prisma) {
      return client.raceImpactEvent.findFirst({
        where: {
          id,
          raceId,
          recipientUserId: userId,
          calculationVersion: CALCULATION_VERSION,
        },
        select: { id: true, popupAcknowledgedAt: true },
      });
    },

    async acknowledgeIfActive({ raceId, userId, id, now }, client = prisma) {
      return client.raceImpactEvent.updateMany({
        where: {
          id,
          raceId,
          recipientUserId: userId,
          popupAcknowledgedAt: null,
          calculationVersion: CALCULATION_VERSION,
          race: { status: "ACTIVE" },
        },
        data: { popupAcknowledgedAt: now },
      });
    },

    async createMany({ rows }, client = prisma) {
      const data = (rows || []).filter((row) => Number.isInteger(row?.deltaSteps) && row.deltaSteps !== 0)
        .map((row) => ({
          ...row,
          valueStatus: VALUE_STATUS,
          calculationVersion: CALCULATION_VERSION,
        }));
      if (data.length === 0) return { count: 0 };
      return client.raceImpactEvent.createMany({ data, skipDuplicates: true });
    },
  };
}

const RaceImpactEvent = buildRaceImpactEventModel();

module.exports = {
  CALCULATION_VERSION,
  VALUE_STATUS,
  presentationId,
  parsePresentationId,
  isValidEvent,
  popupProjection,
  activityProjection,
  impactDescription,
  buildRaceImpactEventModel,
  RaceImpactEvent,
};
