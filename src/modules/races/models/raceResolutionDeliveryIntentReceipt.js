const { prisma: defaultPrisma } = require("../../../db");

function buildRaceResolutionDeliveryIntentReceiptModel(prisma = defaultPrisma) {
  const model = {
    findByDeliveryKeyHash(deliveryKeyHash, tx = prisma) {
      return tx.raceResolutionDeliveryIntentReceipt.findUnique({
        where: { deliveryKeyHash },
      });
    },
    assertReplayIdentity({ receipt, raceId, sourceGeneration, taskDedupeKey, intentKind }) {
      if (!receipt) return null;
      if (
        receipt.raceId !== raceId ||
        Number(receipt.sourceGeneration) !== Number(sourceGeneration) ||
        receipt.taskDedupeKey !== taskDedupeKey ||
        receipt.intentKind !== intentKind
      ) {
        const error = new Error("delivery intent receipt immutable identity mismatch");
        error.code = "DELIVERY_INTENT_RECEIPT_COLLISION";
        throw error;
      }
      return receipt.terminalDisposition;
    },
  };
  return model;
}

const RaceResolutionDeliveryIntentReceipt =
  buildRaceResolutionDeliveryIntentReceiptModel();

module.exports = {
  buildRaceResolutionDeliveryIntentReceiptModel,
  RaceResolutionDeliveryIntentReceipt,
};
