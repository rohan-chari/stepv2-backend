const { Prisma } = require("@prisma/client");
const { prisma } = require("../../../db");
const { testOnlyFilter } = require("../../../shared/middleware/releaseChannel");
const { deductCoinsAtomic } = require("../../../shared/economy/deductCoinsAtomic");

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
// C4 + C5 (spec §5 Phases E/E2): a coin purchase changes BOTH the user's
// powerup inventory and their `/auth/me` balance. `deductCoinsAtomic` already
// DELs the auth/me key, but it runs INSIDE this command's transaction — so it
// fires just before the commit and a concurrent read could re-warm the stale
// balance. Invalidating again here, after the commit, closes that window for
// every path a user can actually trigger.
async function invalidateAfterPurchase(userId) {
  if (!userId) return;
  try {
    await require("../services/powerupInventoryCache").invalidateSafe(userId);
    await require("../../users/services/authMeCache").invalidateSafe(userId);
  } catch {}
}

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
      const outcome = await runTransaction(async (tx) => {
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

        const request = await tx.powerupPurchaseRequest.create({
          data: {
            userId,
            idempotencyKey: trimmedKey,
            powerupShopItemId: item.id,
            status: "PROCESSING",
            coinsSpent: 0,
          },
        });

        // Atomic conditional debit + ledger row via the canonical coin path,
        // inside THIS transaction — fails if the user can't afford it.
        if (item.priceCoins > 0) {
          await deductCoinsAtomic({
            tx,
            userId,
            amount: item.priceCoins,
            // refId must be unique per purchase (unique on user_id+reason+ref_id),
            // so use the per-purchase request id, not the catalog item id.
            reason: "powerup_purchase",
            refId: request.id,
            insufficientError: new PowerupPurchaseError("Insufficient coins", 400),
          });
        }

        // Increment the global inventory quantity (create on first purchase).
        const inventoryRow = await tx.userPowerupItem.upsert({
          where: {
            userId_powerupType: { userId, powerupType: item.powerupType },
          },
          create: { userId, powerupType: item.powerupType, quantity: 1 },
          update: { quantity: { increment: 1 } },
        });

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
      await invalidateAfterPurchase(userId);
      return outcome;
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
