const { Prisma } = require("@prisma/client");
const { prisma } = require("../../db");
const { serializeShopItem, CHARACTER_SLOT } = require("./shopCosmetics");
const { testOnlyFilter } = require("../../shared/middleware/releaseChannel");
const { deductCoinsAtomic } = require("../../shared/economy/deductCoinsAtomic");
const {
  SHOP_UNLOCK_REWARD_KIND,
  powerupUnlockMaxShortfall,
  powerupUnlockDailyCap,
} = require("../economy/adRewards");
const {
  adsNeededFor,
  resolveLocalDate,
  assertUnderDailyCap,
  consumedUnlocksToday,
  SHORTFALL_TOO_LARGE_MESSAGE,
} = require("../economy/services/adUnlockPolicy");

// 2026-07-25 §7 — "watch ads to afford it", for ACCESSORIES and CHARACTERS.
//
// A deliberate SIBLING of powerups/commands/unlockPowerupWithAds.js, not a
// generalization of it (spec §7.3). The two flows differ at every storage
// point — item table (shop_items vs powerup_shop_items), grant table
// (user_shop_items vs user_powerup_items), idempotency table
// (shop_purchase_requests vs powerup_purchase_requests) and testOnly semantics
// — so a single polymorphic command would put the coin-ZEROING debit behind a
// type switch. Two small near-identical commands are safer than one branchy one.
//
// Every safety property of the powerup command is mirrored exactly:
//   * idempotency claimed up front (unique userId+key), replayed on retry;
//   * server-authoritative shortfall + ad count (a client-sent amount is never
//     trusted);
//   * the shared daily cap checked INSIDE the transaction, before any consume
//     or debit, so a 409 costs the user nothing;
//   * conditional consume (`consumedAt: null`) so a concurrent unlock cannot
//     double-spend the same verified watch;
//   * the debit runs through deductCoinsAtomic, in THIS transaction, so the
//     ledger row and the balance can never disagree;
//   * testOnlyFilter(channel) so a testOnly cosmetic is not ad-unlockable from
//     a prod client.
class ShopUnlockWithAdsError extends Error {
  constructor(message, statusCode = 400, code) {
    super(message);
    this.name = "ShopUnlockWithAdsError";
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function unlockError(message, statusCode, code) {
  return new ShopUnlockWithAdsError(message, statusCode, code);
}

function idempotentResult(request) {
  if (!request?.resultJson || request.status !== "SUCCEEDED") {
    throw new ShopUnlockWithAdsError("Unlock is already being processed", 409);
  }
  return { ...request.resultJson, idempotent: true };
}

function buildUnlockShopItemWithAds(dependencies = {}) {
  const runTransaction =
    dependencies.runTransaction || ((fn) => prisma.$transaction((tx) => fn(tx)));

  return async function unlockShopItemWithAds({
    userId,
    sku,
    idempotencyKey,
    channel = "prod",
    // Mirrors the catalog gate: a build that never declared `characters`
    // support can't render an animal, so it may not ad-unlock one either.
    supportsCharacters = false,
    // OPTIONAL, exactly as on the powerup endpoint.
    localDate,
  }) {
    if (!idempotencyKey || typeof idempotencyKey !== "string") {
      throw new ShopUnlockWithAdsError("Idempotency-Key is required", 400);
    }
    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > 120) {
      throw new ShopUnlockWithAdsError("Idempotency-Key is invalid", 400);
    }
    if (!sku || typeof sku !== "string") {
      throw new ShopUnlockWithAdsError("sku is required", 400);
    }
    const effectiveLocalDate = resolveLocalDate(localDate, unlockError);

    try {
      return await runTransaction(async (tx) => {
        const existing = await tx.shopPurchaseRequest.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
        });
        if (existing) return idempotentResult(existing);

        // Accept the catalog `sku` (what the contract names) or the row id —
        // the cosmetic catalog serializes both and older client code keys on id.
        const item = await tx.shopItem.findFirst({
          where: {
            OR: [{ sku }, { id: sku }],
            active: true,
            earnOnly: false,
            ...testOnlyFilter(channel),
            ...(supportsCharacters ? {} : { slot: { not: CHARACTER_SLOT } }),
          },
        });
        if (!item) {
          throw new ShopUnlockWithAdsError("Shop item not found", 404);
        }

        const alreadyOwned = await tx.userShopItem.findUnique({
          where: { userId_shopItemId: { userId, shopItemId: item.id } },
        });
        if (alreadyOwned) {
          throw new ShopUnlockWithAdsError(
            "You already own this item",
            400,
            "ALREADY_OWNED"
          );
        }

        const user = await tx.user.findUnique({ where: { id: userId } });
        const coins = user?.coins ?? 0;
        const shortfall = item.priceCoins - coins;

        if (shortfall <= 0) {
          throw new ShopUnlockWithAdsError(
            "You can already afford this item",
            400,
            "ALREADY_AFFORDABLE"
          );
        }
        if (shortfall > powerupUnlockMaxShortfall()) {
          throw new ShopUnlockWithAdsError(
            SHORTFALL_TOO_LARGE_MESSAGE(),
            400,
            "SHORTFALL_TOO_LARGE"
          );
        }

        await assertUnderDailyCap(tx, userId, effectiveLocalDate, unlockError);

        const adsNeeded = adsNeededFor(shortfall);

        // Claim the idempotency row before anything is consumed/granted, so a
        // concurrent duplicate loses on the unique constraint first.
        const request = await tx.shopPurchaseRequest.create({
          data: {
            userId,
            idempotencyKey: trimmedKey,
            shopItemId: item.id,
            status: "PROCESSING",
            coinsSpent: 0,
          },
        });

        // Verified, still-unconsumed watches for THIS user + sku. Grants are
        // stamped with the catalog sku by grantAdReward from the SSV
        // custom_data "shop_unlock:<userId>:<sku>".
        const watches = await tx.adRewardGrant.findMany({
          where: {
            userId,
            rewardKind: SHOP_UNLOCK_REWARD_KIND,
            shopItemId: { in: [item.sku, item.id] },
            consumedAt: null,
          },
          orderBy: { createdAt: "asc" },
          take: adsNeeded,
          select: { id: true },
        });
        if (watches.length < adsNeeded) {
          throw new ShopUnlockWithAdsError(
            "Not enough verified ad watches yet",
            409,
            "AD_NOT_VERIFIED"
          );
        }

        // rewardType "COSMETIC" is a free-text String column on ad_reward_grants
        // (prisma/schema.prisma: `rewardType String?`), NOT an enum — so this
        // needs no migration and no backfill, and old rows are untouched.
        const consumed = await tx.adRewardGrant.updateMany({
          where: { id: { in: watches.map((w) => w.id) }, consumedAt: null },
          data: {
            consumedAt: new Date(),
            grantedDate: effectiveLocalDate,
            rewardType: "COSMETIC",
            shopItemId: item.sku,
          },
        });
        if (consumed.count !== adsNeeded) {
          throw new ShopUnlockWithAdsError(
            "Ad watches were already spent",
            409,
            "AD_ALREADY_SPENT"
          );
        }

        // Zero the wallet through the canonical debit path (audit ledger row).
        // refId is the request id, which is unique per unlock.
        if (coins > 0) {
          await deductCoinsAtomic({
            tx,
            userId,
            amount: coins,
            reason: "shop_unlock_ads",
            refId: request.id,
          });
        }

        await tx.userShopItem.create({
          data: { userId, shopItemId: item.id },
        });

        const cap = powerupUnlockDailyCap();
        const usedToday = await consumedUnlocksToday(tx, userId, effectiveLocalDate);

        const result = {
          coins: 0,
          adsWatched: adsNeeded,
          adUnlockDailyCap: cap,
          adUnlockRemainingToday: Math.max(0, cap - usedToday),
          item: serializeShopItem(item, { owned: true, equipped: false }),
          owned: true,
          idempotent: false,
        };

        await tx.shopPurchaseRequest.update({
          where: { userId_idempotencyKey: { userId, idempotencyKey: trimmedKey } },
          data: { status: "SUCCEEDED", coinsSpent: coins, resultJson: result },
        });

        return result;
      });
    } catch (error) {
      if (error instanceof ShopUnlockWithAdsError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await prisma.shopPurchaseRequest.findUnique({
          where: {
            userId_idempotencyKey: { userId, idempotencyKey: idempotencyKey.trim() },
          },
        });
        if (existing) return idempotentResult(existing);
      }
      throw error;
    }
  };
}

const unlockShopItemWithAds = buildUnlockShopItemWithAds();

module.exports = {
  buildUnlockShopItemWithAds,
  unlockShopItemWithAds,
  ShopUnlockWithAdsError,
};
