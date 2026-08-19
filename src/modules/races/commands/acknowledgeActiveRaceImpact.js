const { prisma: defaultPrisma } = require("../../../db");
const { ActiveRaceImpact: defaultModel } = require("../models/activeRaceImpact");
const { NotFoundError, ConflictError } = require("../../../shared/errors/AppError");

function buildAcknowledgeActiveRaceImpact(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const model = dependencies.ActiveRaceImpact || defaultModel;
  const now = dependencies.now || (() => new Date());

  return async function acknowledgeActiveRaceImpact({ raceId, userId, noticeId }) {
    return prisma.$transaction(async (tx) => {
      const own = await model.findOwnNotice({ raceId, userId, noticeId }, tx);
      if (!own) throw new NotFoundError("Impact notice not found", "NOT_FOUND");
      const race = await model.getRaceAccess({ raceId, userId }, tx);
      if (!race || race.status !== "ACTIVE") {
        throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
      }
      if (own.acknowledgedAt) return { acknowledged: true };
      const result = await model.acknowledgeNoticeIfActive({
        raceId,
        userId,
        noticeId,
        now: now(),
      }, tx);
      if (result.count !== 1) {
        throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
      }
      return { acknowledged: true };
    });
  };
}

function buildAcknowledgeActiveImpactReceipt(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const model = dependencies.ActiveRaceImpact || defaultModel;
  const now = dependencies.now || (() => new Date());

  return async function acknowledgeActiveImpactReceipt({ raceId, userId, receiptId }) {
    return prisma.$transaction(async (tx) => {
      const own = await model.findOwnReceipt({ raceId, userId, receiptId }, tx);
      if (!own) throw new NotFoundError("Impact receipt not found", "NOT_FOUND");
      const race = await model.getRaceAccess({ raceId, userId }, tx);
      if (!race || race.status !== "ACTIVE") {
        throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
      }
      const acknowledgedAt = own.inlineAcknowledgedAt || now();
      if (!own.inlineAcknowledgedAt) {
        const result = await model.acknowledgeReceiptIfActive({
          raceId,
          userId,
          receiptId,
          now: acknowledgedAt,
        }, tx);
        if (result.count !== 1) {
          throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
        }
      }
      // Materialization may win either side of the receipt dismissal. Updating
      // both rows in this transaction closes the after-materialization race;
      // the worker separately copies inlineAcknowledgedAt on the before path.
      await model.acknowledgeMaterializedImpactForWork({
        raceId,
        userId,
        workId: own.id,
        acknowledgedAt,
      }, tx);
      return { acknowledged: true };
    });
  };
}

const acknowledgeActiveRaceImpact = buildAcknowledgeActiveRaceImpact();
const acknowledgeActiveImpactReceipt = buildAcknowledgeActiveImpactReceipt();

module.exports = {
  buildAcknowledgeActiveRaceImpact,
  buildAcknowledgeActiveImpactReceipt,
  acknowledgeActiveRaceImpact,
  acknowledgeActiveImpactReceipt,
};
