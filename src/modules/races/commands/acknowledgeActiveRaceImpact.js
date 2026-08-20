const { prisma: defaultPrisma } = require("../../../db");
const {
  RaceImpactEvent: defaultModel,
  parsePresentationId,
} = require("../models/raceImpactEvent");
const { NotFoundError, ConflictError } = require("../../../shared/errors/AppError");

function buildAcknowledge(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const model = dependencies.RaceImpactEvent || defaultModel;
  const now = dependencies.now || (() => new Date());

  return async function acknowledge({ raceId, userId, presentationId }) {
    const id = parsePresentationId(presentationId);
    if (!id) throw new NotFoundError("Impact event not found", "NOT_FOUND");
    return prisma.$transaction(async (tx) => {
      // Ownership is intentionally checked before race state so malformed,
      // missing, and foreign IDs all share the same nondisclosing 404.
      const own = await model.findOwn({ raceId, userId, id }, tx);
      if (!own) throw new NotFoundError("Impact event not found", "NOT_FOUND");
      const race = await model.getRaceAccess({ raceId, userId }, tx);
      if (!race || race.status !== "ACTIVE") {
        throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
      }
      if (own.popupAcknowledgedAt) return { acknowledged: true };
      const result = await model.acknowledgeIfActive({
        raceId,
        userId,
        id,
        now: now(),
      }, tx);
      if (result.count !== 1) {
        throw new ConflictError("Race is not active", "RACE_NOT_ACTIVE");
      }
      return { acknowledged: true };
    });
  };
}

function buildAcknowledgeActiveRaceImpact(dependencies = {}) {
  const acknowledge = buildAcknowledge(dependencies);
  return ({ raceId, userId, noticeId }) =>
    acknowledge({ raceId, userId, presentationId: noticeId });
}

function buildAcknowledgeActiveImpactReceipt(dependencies = {}) {
  const acknowledge = buildAcknowledge(dependencies);
  return ({ raceId, userId, receiptId }) =>
    acknowledge({ raceId, userId, presentationId: receiptId });
}

const acknowledgeActiveRaceImpact = buildAcknowledgeActiveRaceImpact();
const acknowledgeActiveImpactReceipt = buildAcknowledgeActiveImpactReceipt();

module.exports = {
  buildAcknowledgeActiveRaceImpact,
  buildAcknowledgeActiveImpactReceipt,
  acknowledgeActiveRaceImpact,
  acknowledgeActiveImpactReceipt,
};
