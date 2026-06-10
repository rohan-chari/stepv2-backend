const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { testOnlyFilter } = require("../utils/releaseChannel");

class PowerupPurchaseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "PowerupPurchaseError";
    this.statusCode = statusCode;
  }
}

function serializeInventory(row, powerupType) {
  return {
    powerupType: row?.powerupType ?? powerupType,
    quantity: row?.quantity ?? 0,
  };
}

function idempotentResultFromRequest(request) {
  if (!request?.resultJson || request.status !== "SUCCEEDED") {
    throw new PowerupPurchaseError("Purchase is already being processed", 409);
  }
  return {
    ...request.resultJson,
    purchase: {
      ...(request.resultJson.purchase || {}),
      idempotent: true,
    },
  };
}

// `dependencies.runTransaction(fn)` lets tests inject a fake transactional
// runner with a mocked model surface (tx). In production it runs a real
// prisma.$transaction.
function buildPurchasePowerupItem(dependencies = {}) {
  const runTransaction =
    dependencies.runTransaction ||
    ((fn) => prisma.$transaction((tx) => fn(tx)));
  const findExistingRequest =
    dependencies.findExistingRequest ||
    (async (tx, { userId, idempotencyKey }) =>
      tx.powerupPurchaseRequest.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      }));

  return async function purchasePowerupItem({ userId, sku, powerupType, idempotencyKey, channel = "prod" }) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new PowerupPurchaseError("Idempotency-Key is required", 400);
    }
    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > 120) {
      throw new PowerupPurchaseError("Idempotency-Key is invalid", 400);
    }
    if (!sku && !powerupType) {
      throw new PowerupPurchaseError("sku or powerupType is required", 400);
    }

    try {
      return await runTransaction(async (tx) => {
        // Idempotency replay check inside the transaction.
        const existing = await findExistingRequest(tx, {
          userId,
          idempotencyKey: trimmedKey,
        });
        if (existing) return idempotentResultFromRequest(existing);

        // Find the active catalog item (by sku, else by powerupType). The
        // testOnly filter blocks a prod-channel client from buying a hidden
        // powerup even if it somehow learned the sku/type.
        const where = sku
          ? { sku, active: true, ...testOnlyFilter(channel) }
          : { powerupType, active: true, ...testOnlyFilter(channel) };
        const item = await tx.powerupShopItem.findFirst({ where });
        if (!item) {
          throw new PowerupPurchaseError("Powerup not found", 404);
        }

        await tx.powerupPurchaseRequest.create({
          data: {
            userId,
            idempotencyKey: trimmedKey,
            powerupShopItemId: item.id,
            status: "PROCESSING",
            coinsSpent: 0,
          },
        });

        // Atomic conditional debit — fails (count 0) if the user can't afford it.
        if (item.priceCoins > 0) {
          const debit = await tx.user.updateMany({
            where: { id: userId, coins: { gte: item.priceCoins } },
            data: { coins: { decrement: item.priceCoins } },
          });
          if (debit.count === 0) {
            throw new PowerupPurchaseError("Insufficient coins", 400);
          }
        }

        // Increment the global inventory quantity (create on first purchase).
        const inventoryRow = await tx.userPowerupItem.upsert({
          where: {
            userId_powerupType: { userId, powerupType: item.powerupType },
          },
          create: { userId, powerupType: item.powerupType, quantity: 1 },
          update: { quantity: { increment: 1 } },
        });

        if (item.priceCoins > 0) {
          await tx.coinTransaction.create({
            data: {
              userId,
              amount: -item.priceCoins,
              reason: "powerup_purchase",
              refId: item.id,
            },
          });
        }

        const user = await tx.user.findUnique({ where: { id: userId } });
        const result = {
          coins: user?.coins ?? 0,
          inventory: serializeInventory(inventoryRow, item.powerupType),
          item: {
            sku: item.sku,
            name: item.name,
            priceCoins: item.priceCoins,
            powerupType: item.powerupType,
          },
          purchase: {
            idempotent: false,
            coinsSpent: item.priceCoins,
          },
        };

        await tx.powerupPurchaseRequest.update({
          where: {
            userId_idempotencyKey: { userId, idempotencyKey: trimmedKey },
          },
          data: {
            status: "SUCCEEDED",
            coinsSpent: item.priceCoins,
            resultJson: result,
          },
        });

        return result;
      });
    } catch (error) {
      if (error instanceof PowerupPurchaseError) throw error;
      // Concurrent duplicate (same key) racing the ledger insert: replay.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const replayed = await runTransaction(async (tx) => {
          const existing = await findExistingRequest(tx, {
            userId,
            idempotencyKey: trimmedKey,
          });
          return existing ? idempotentResultFromRequest(existing) : null;
        });
        if (replayed) return replayed;
      }
      throw error;
    }
  };
}

const purchasePowerupItem = buildPurchasePowerupItem();

module.exports = {
  buildPurchasePowerupItem,
  purchasePowerupItem,
  PowerupPurchaseError,
};
