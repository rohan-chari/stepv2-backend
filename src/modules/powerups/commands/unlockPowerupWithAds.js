const { Prisma } = require("@prisma/client");
const { prisma } = require("../../../db");
const { testOnlyFilter } = require("../../../shared/middleware/releaseChannel");
const { deductCoinsAtomic } = require("../../../shared/economy/deductCoinsAtomic");
const {
  POWERUP_UNLOCK_REWARD_KIND,
  POWERUP_UNLOCK_MAX_SHORTFALL,
  POWERUP_UNLOCK_COINS_PER_AD,
  POWERUP_UNLOCK_MAX_ADS,
} = require("../../economy/adRewards");

// Item 10 (2026-07-24): "watch ads to afford a powerup". When a user is within
// POWERUP_UNLOCK_MAX_SHORTFALL (150) coins of a powerup, they may unlock it by
// watching ceil(shortfall/50) SSV-verified ads (capped at 3); on success the
// server ZEROES their coins and grants one powerup. The server is the sole
// authority on shortfall and the ad count — never a client-sent amount — and the
// watches must be SSV-verified (grantAdReward mints them from the AdMob callback
// with custom_data "powerup_unlock:<userId>:<sku>").
class UnlockWithAdsError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = "UnlockWithAdsError";
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function adsNeededFor(shortfall) {
  return Math.min(
    POWERUP_UNLOCK_MAX_ADS,
    Math.ceil(shortfall / POWERUP_UNLOCK_COINS_PER_AD)
  );
}

function idempotentResult(request) {
  if (!request?.resultJson || request.status !== "SUCCEEDED") {
    throw new UnlockWithAdsError("Unlock is already being processed", 409);
  }
  return { ...request.resultJson, idempotent: true };
}

function buildUnlockPowerupWithAds(dependencies = {}) {
  const runTransaction =
    dependencies.runTransaction || ((fn) => prisma.$transaction((tx) => fn(tx)));

  return async function unlockPowerupWithAds({ userId, sku, idempotencyKey, channel = "prod" }) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new UnlockWithAdsError("Idempotency-Key is required", 400);
    }
    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > 120) {
      throw new UnlockWithAdsError("Idempotency-Key is invalid", 400);
    }
    if (!sku || typeof sku !== "string") {
      throw new UnlockWithAdsError("sku is required", 400);
    }

    try {
      return await runTransaction(async (tx) => {
        // Idempotency replay: a retry returns the same result, never re-grants.
        const existing = await tx.powerupPurchaseRequest.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
        });
        if (existing) return idempotentResult(existing);

        const item = await tx.powerupShopItem.findFirst({
          where: { sku, active: true, ...testOnlyFilter(channel) },
        });
        if (!item) {
          throw new UnlockWithAdsError("Powerup not found", 404);
        }

        const user = await tx.user.findUnique({ where: { id: userId } });
        const coins = user?.coins ?? 0;
        const shortfall = item.priceCoins - coins;

        // Server-authoritative gates (client-sent amounts are never trusted).
        if (shortfall <= 0) {
          throw new UnlockWithAdsError(
            "You can already afford this powerup",
            400,
            "ALREADY_AFFORDABLE"
          );
        }
        if (shortfall > POWERUP_UNLOCK_MAX_SHORTFALL) {
          throw new UnlockWithAdsError(
            "Too many coins short — get more coins first",
            400,
            "SHORTFALL_TOO_LARGE"
          );
        }

        const adsNeeded = adsNeededFor(shortfall);

        // Claim the record row up front so a concurrent duplicate (same key)
        // loses on the unique constraint before anything is consumed/granted.
        const request = await tx.powerupPurchaseRequest.create({
          data: {
            userId,
            idempotencyKey: trimmedKey,
            powerupShopItemId: item.id,
            status: "PROCESSING",
            coinsSpent: 0,
          },
        });

        // Verified, still-unconsumed watches for THIS user + sku.
        const watches = await tx.adRewardGrant.findMany({
          where: {
            userId,
            rewardKind: POWERUP_UNLOCK_REWARD_KIND,
            shopItemId: sku,
            consumedAt: null,
          },
          orderBy: { createdAt: "asc" },
          take: adsNeeded,
          select: { id: true },
        });
        if (watches.length < adsNeeded) {
          throw new UnlockWithAdsError(
            "Not enough verified ad watches yet",
            409,
            "AD_NOT_VERIFIED"
          );
        }

        // Consume exactly adsNeeded watches, conditional on still-unconsumed so a
        // concurrent unlock for the same sku can't double-spend the same watch.
        const consumed = await tx.adRewardGrant.updateMany({
          where: { id: { in: watches.map((w) => w.id) }, consumedAt: null },
          data: { consumedAt: new Date(), rewardType: "POWERUP", powerupType: item.powerupType },
        });
        if (consumed.count !== adsNeeded) {
          throw new UnlockWithAdsError(
            "Ad watches were already spent",
            409,
            "AD_ALREADY_SPENT"
          );
        }

        // Zero the wallet (audit ledger row via the canonical debit path). A user
        // sitting at exactly 0 coins is a no-op debit, which is fine.
        if (coins > 0) {
          await deductCoinsAtomic({
            tx,
            userId,
            amount: coins,
            reason: "powerup_unlock_ads",
            refId: request.id,
          });
        }

        // Grant one powerup into the global inventory.
        const inventoryRow = await tx.userPowerupItem.upsert({
          where: { userId_powerupType: { userId, powerupType: item.powerupType } },
          create: { userId, powerupType: item.powerupType, quantity: 1 },
          update: { quantity: { increment: 1 } },
        });

        const result = {
          coins: 0,
          adsWatched: adsNeeded,
          inventory: {
            powerupType: inventoryRow.powerupType,
            quantity: inventoryRow.quantity ?? 0,
          },
          item: {
            sku: item.sku,
            name: item.name,
            priceCoins: item.priceCoins,
            powerupType: item.powerupType,
          },
          idempotent: false,
        };

        await tx.powerupPurchaseRequest.update({
          where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
          data: { status: "SUCCEEDED", coinsSpent: coins, resultJson: result },
        });

        return result;
      });
    } catch (error) {
      if (error instanceof UnlockWithAdsError) throw error;
      // Concurrent duplicate (same key) racing the request insert: replay.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await prisma.powerupPurchaseRequest.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: idempotencyKey.trim() } },
        });
        if (existing) return idempotentResult(existing);
      }
      throw error;
    }
  };
}

const unlockPowerupWithAds = buildUnlockPowerupWithAds();

module.exports = {
  buildUnlockPowerupWithAds,
  unlockPowerupWithAds,
  UnlockWithAdsError,
  adsNeededFor,
};
