const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const {
  readActiveImpactRolloutFence,
  sourceResolvedUnderFence,
} = require("../../../shared/config/activeImpactRolloutFence");

const CALCULATION_VERSION = 1;

function buildActiveRaceImpactModel(prisma = defaultPrisma) {
  async function upsertWork(input, client) {
    const {
      raceId,
      recipientUserId,
      sourceKind,
      sourceId,
      powerupType,
      resolvedAt,
      capturedDeltaSteps = null,
      inlineReceipt = false,
      calculationVersion = CALCULATION_VERSION,
    } = input;
    const inlineReceiptId = inlineReceipt ? crypto.randomUUID() : null;
    return client.activeRaceImpactWork.upsert({
      where: {
        raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
          raceId,
          recipientUserId,
          sourceKind,
          sourceId,
          calculationVersion,
        },
      },
      update: {},
      create: {
        raceId,
        recipientUserId,
        sourceKind,
        sourceId,
        powerupType,
        resolvedAt,
        capturedDeltaSteps,
        calculationVersion,
        inlineReceiptId,
      },
    });
  }

  return {
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

    async listUnacknowledged({ raceId, userId, limit = 20 }, client = prisma) {
      return client.activeRaceEffectImpact.findMany({
        where: { raceId, userId, acknowledgedAt: null },
        select: {
          id: true,
          powerupType: true,
          deltaSteps: true,
          valueStatus: true,
          resolvedAt: true,
        },
        orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
        take: Math.min(20, Math.max(1, Number(limit) || 20)),
      });
    },

    async countPending({ raceId, userId }, client = prisma) {
      return client.activeRaceImpactWork.count({
        where: { raceId, recipientUserId: userId, status: "PENDING" },
      });
    },

    async findSourceWorkStates({
      raceId,
      sourceKind,
      sourceIds,
      calculationVersion = CALCULATION_VERSION,
    }, client = prisma) {
      const ids = [...new Set((sourceIds || []).filter(Boolean))];
      if (!raceId || !sourceKind || ids.length === 0) return [];
      return client.activeRaceImpactWork.findMany({
        where: {
          raceId,
          sourceKind,
          sourceId: { in: ids },
          calculationVersion,
        },
        select: {
          recipientUserId: true,
          sourceId: true,
          status: true,
        },
      });
    },

    async suppressPendingForTerminalRace(raceId, client = prisma) {
      return client.activeRaceImpactWork.updateMany({
        where: { raceId, status: "PENDING", race: { status: { not: "ACTIVE" } } },
        data: { status: "SUPPRESSED_TERMINAL" },
      });
    },

    async createWork({
      raceId,
      recipientUserId,
      sourceKind,
      sourceId,
      powerupType,
      resolvedAt,
      capturedDeltaSteps = null,
      inlineReceipt = false,
      calculationVersion = CALCULATION_VERSION,
    }, client = prisma) {
      return upsertWork({
        raceId,
        recipientUserId,
        sourceKind,
        sourceId,
        powerupType,
        resolvedAt,
        capturedDeltaSteps,
        inlineReceipt,
        calculationVersion,
      }, client);
    },

    async createDirectSource({
      event,
      powerupType,
      deltas = [],
      receiptRecipientUserId = null,
      resolvedAt,
    }) {
      return prisma.$transaction(async (tx) => {
        // This shared row lock is the direct source's linearization point.
        // A disable transition takes the matching exclusive lock, so it either
        // commits first (this source stays unstamped) or waits until the source
        // and every recipient's durable work have committed.
        const fence = await readActiveImpactRolloutFence(tx);
        const eligible = sourceResolvedUnderFence(fence, resolvedAt);
        const row = await tx.racePowerupEvent.create({
          data: {
            ...event,
            ...(eligible
              ? {
                  metadata: {
                    ...(event.metadata || {}),
                    activeImpactCalculationVersion: CALCULATION_VERSION,
                    activeImpactPowerupType: powerupType,
                    activeImpactDeltas: deltas,
                  },
                }
              : {}),
          },
        });
        if (!eligible) return { event: row, work: [] };

        const work = [];
        for (const delta of deltas) {
          work.push(await upsertWork({
            raceId: row.raceId,
            recipientUserId: delta.userId,
            sourceKind: "POWERUP_EVENT",
            sourceId: row.id,
            powerupType,
            resolvedAt: row.createdAt,
            inlineReceipt:
              delta.userId === receiptRecipientUserId && delta.deltaSteps !== 0,
            calculationVersion: CALCULATION_VERSION,
          }, tx));
        }
        return { event: row, work };
      });
    },

    async resolveEffectBoundary({ effectId, fields, work = [], eligible = true }) {
      return prisma.$transaction(async (tx) => {
        const fence = eligible
          ? await readActiveImpactRolloutFence(tx)
          : { enabled: false, enabledFrom: null };
        const resolvedAt = work[0]?.resolvedAt || fields.expiresAt;
        const sourceEligible = eligible && sourceResolvedUnderFence(fence, resolvedAt);
        const effect = await tx.raceActiveEffect.update({
          where: { id: effectId },
          data: {
            ...fields,
            ...(!sourceEligible && eligible
              ? {
                  metadata: {
                    ...(fields.metadata || {}),
                    activeImpactResolutionSkippedVersion: 1,
                  },
                }
              : {}),
          },
        });
        const rows = [];
        for (const input of sourceEligible ? work : []) {
          rows.push(await upsertWork(input, tx));
        }
        return { effect, work: rows };
      });
    },

    async findOwnNotice({ raceId, userId, noticeId }, client = prisma) {
      return client.activeRaceEffectImpact.findFirst({
        where: { id: noticeId, raceId, userId },
        select: { id: true, acknowledgedAt: true },
      });
    },

    async acknowledgeNoticeIfActive({ raceId, userId, noticeId, now }, client = prisma) {
      return client.activeRaceEffectImpact.updateMany({
        where: {
          id: noticeId,
          raceId,
          userId,
          acknowledgedAt: null,
          race: { status: "ACTIVE" },
        },
        data: { acknowledgedAt: now },
      });
    },

    async findOwnReceipt({ raceId, userId, receiptId }, client = prisma) {
      return client.activeRaceImpactWork.findFirst({
        where: {
          raceId,
          recipientUserId: userId,
          inlineReceiptId: receiptId,
          calculationVersion: CALCULATION_VERSION,
        },
        select: { id: true, inlineAcknowledgedAt: true },
      });
    },

    async acknowledgeReceiptIfActive({ raceId, userId, receiptId, now }, client = prisma) {
      return client.activeRaceImpactWork.updateMany({
        where: {
          raceId,
          recipientUserId: userId,
          inlineReceiptId: receiptId,
          calculationVersion: CALCULATION_VERSION,
          inlineAcknowledgedAt: null,
          race: { status: "ACTIVE" },
        },
        data: { inlineAcknowledgedAt: now },
      });
    },

    async acknowledgeMaterializedImpactForWork({
      raceId,
      userId,
      workId,
      acknowledgedAt,
    }, client = prisma) {
      return client.activeRaceEffectImpact.updateMany({
        where: {
          raceId,
          userId,
          workId,
          acknowledgedAt: null,
        },
        data: { acknowledgedAt },
      });
    },
  };
}

const ActiveRaceImpact = buildActiveRaceImpactModel();

module.exports = {
  CALCULATION_VERSION,
  buildActiveRaceImpactModel,
  ActiveRaceImpact,
};
