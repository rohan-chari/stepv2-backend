const { prisma: defaultPrisma } = require("../../../db");

function buildRaceResolutionPostTaskReceiptModel(prisma = defaultPrisma) {
  return {
    findByGeneration({ raceId, sourceGeneration }, tx = prisma) {
      return tx.raceResolutionPostTaskReceipt.findUnique({
        where: { raceId_sourceGeneration: { raceId, sourceGeneration } },
      });
    },
    findByDedupeKey(dedupeKey, tx = prisma) {
      return tx.raceResolutionPostTaskReceipt.findUnique({ where: { dedupeKey } });
    },
  };
}

const RaceResolutionPostTaskReceipt = buildRaceResolutionPostTaskReceiptModel();

module.exports = {
  buildRaceResolutionPostTaskReceiptModel,
  RaceResolutionPostTaskReceipt,
};
