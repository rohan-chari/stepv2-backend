const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { serializeShopItem } = require("../utils/shopCosmetics");

class ShopPurchaseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ShopPurchaseError";
    this.statusCode = statusCode;
  }
}

function idempotentResultFromRequest(request) {
  if (!request?.resultJson || request.status !== "SUCCEEDED") {
    throw new ShopPurchaseError("Purchase is already being processed", 409);
  }

  return {
    ...request.resultJson,
    purchase: {
      ...(request.resultJson.purchase || {}),
      idempotent: true,
    },
  };
}

async function findExistingRequest({ userId, idempotencyKey, itemId }) {
  const request = await prisma.shopPurchaseRequest.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });

  if (!request) return null;

  if (request.shopItemId !== itemId) {
    throw new ShopPurchaseError(
      "Idempotency key was already used for a different purchase",
      409
    );
  }

  return idempotentResultFromRequest(request);
}

async function purchaseShopItem({ userId, itemId, idempotencyKey }) {
  if (!idempotencyKey || typeof idempotencyKey !== "string") {
    throw new ShopPurchaseError("Idempotency-Key header is required", 400);
  }

  const trimmedKey = idempotencyKey.trim();
  if (trimmedKey.length === 0 || trimmedKey.length > 120) {
    throw new ShopPurchaseError("Idempotency-Key header is invalid", 400);
  }

  const existingResult = await findExistingRequest({
    userId,
    idempotencyKey: trimmedKey,
    itemId,
  });
  if (existingResult) return existingResult;

  try {
    return await prisma.$transaction(async (tx) => {
      const item = await tx.shopItem.findFirst({
        where: { id: itemId, active: true },
      });
      if (!item) {
        throw new ShopPurchaseError("Shop item not found", 404);
      }

      await tx.shopPurchaseRequest.create({
        data: {
          userId,
          idempotencyKey: trimmedKey,
          shopItemId: item.id,
          status: "PROCESSING",
          coinsSpent: 0,
        },
      });

      const existingOwnership = await tx.userShopItem.findUnique({
        where: { userId_shopItemId: { userId, shopItemId: item.id } },
      });

      if (existingOwnership) {
        const user = await tx.user.findUnique({ where: { id: userId } });
        const result = {
          coins: user?.coins ?? 0,
          item: serializeShopItem(item, { owned: true, equipped: false }),
          purchase: {
            idempotent: false,
            alreadyOwned: true,
            coinsSpent: 0,
          },
        };

        await tx.shopPurchaseRequest.update({
          where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
          data: {
            status: "SUCCEEDED",
            resultJson: result,
          },
        });

        return result;
      }

      if (item.priceCoins > 0) {
        const updated = await tx.user.updateMany({
          where: { id: userId, coins: { gte: item.priceCoins } },
          data: { coins: { decrement: item.priceCoins } },
        });
        if (updated.count === 0) {
          throw new ShopPurchaseError("Insufficient coins", 400);
        }
      }

      await tx.userShopItem.create({
        data: { userId, shopItemId: item.id },
      });

      if (item.priceCoins > 0) {
        await tx.coinTransaction.create({
          data: {
            userId,
            amount: -item.priceCoins,
            reason: "shop_purchase",
            refId: item.id,
          },
        });
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      const result = {
        coins: user?.coins ?? 0,
        item: serializeShopItem(item, { owned: true, equipped: false }),
        purchase: {
          idempotent: false,
          alreadyOwned: false,
          coinsSpent: item.priceCoins,
        },
      };

      await tx.shopPurchaseRequest.update({
        where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
        data: {
          status: "SUCCEEDED",
          coinsSpent: item.priceCoins,
          resultJson: result,
        },
      });

      return result;
    });
  } catch (error) {
    if (error instanceof ShopPurchaseError) throw error;

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const result = await findExistingRequest({
        userId,
        idempotencyKey: trimmedKey,
        itemId,
      });
      if (result) return result;
    }

    throw error;
  }
}

module.exports = { purchaseShopItem, ShopPurchaseError };
