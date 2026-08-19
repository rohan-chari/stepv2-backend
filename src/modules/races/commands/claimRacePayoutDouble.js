const { prisma } = require("../../../db");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
} = require("../../../shared/errors/AppError");
const adRewards = require("../../economy/adRewards");
const {
  eligibleItemsForParticipants,
} = require("../models/racePayoutDouble");
const {
  canonicalUuid,
  boundedRacePayoutDoubleMaxBonus,
  computeRacePayoutDoubleBonus,
} = require("../services/racePayoutDoublePolicy");
const {
  withRacePayoutDoubleTransaction,
} = require("../services/withRacePayoutDoubleTransaction");

function claimBody(offer, items, coins, alreadyClaimed) {
  return {
    awarded: !alreadyClaimed,
    alreadyClaimed,
    baseCoins: offer.baseCoins,
    bonusCoins: offer.bonusCoins,
    maxBonusCoins: offer.maxBonusCoins,
    rolling24hRemainingBeforeClaim:
      offer.rolling24hRemainingBeforeClaim,
    coins,
    raceIds: items.map((item) => item.raceIdSnapshot),
  };
}

function buildClaimRacePayoutDouble(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const config = dependencies.adRewardsConfig || adRewards;
  const award = dependencies.awardCoins || awardCoins;

  return async function claimRacePayoutDouble({ userId, offerId, clientFeatures }) {
    if (!canonicalUuid(offerId)) {
      throw new ValidationError("Invalid offer ID", "INVALID_REQUEST");
    }
    const owned = await db.racePayoutDoubleOffer.findFirst({
      where: { id: offerId, userId },
      select: { providerSubHash: true },
    });
    if (!owned) throw new NotFoundError("Offer not found", "OFFER_NOT_FOUND");

    try {
      return await withRacePayoutDoubleTransaction(async (tx) => {
        await tx.$queryRaw`SELECT provider_sub_hash FROM race_payout_double_identities WHERE provider_sub_hash = ${owned.providerSubHash} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM race_payout_double_offers WHERE id = ${offerId} FOR UPDATE`;
        const offer = await tx.racePayoutDoubleOffer.findFirst({
          where: { id: offerId, userId },
          include: { items: { orderBy: { raceIdSnapshot: "asc" } } },
        });
        if (!offer) throw new NotFoundError("Offer not found", "OFFER_NOT_FOUND");
        const currentUser = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        if (offer.status === "CLAIMED") {
          return claimBody(offer, offer.items, currentUser.coins, true);
        }
        if (offer.status === "FORFEITED") {
          throw new ConflictError("Offer was forfeited", "OFFER_FORFEITED");
        }
        if (
          !clientFeatures?.has("race_payout_double") ||
          !config.adsRacePayoutDoubleClaimEnabled() ||
          config.racePayoutDoubleAdUnitIds().length === 0
        ) {
          throw new ForbiddenError(
            "Race payout double claims are disabled",
            "CLAIMS_DISABLED",
          );
        }

        for (const item of offer.items) {
          await tx.$queryRaw`SELECT id FROM race_payout_double_offer_items WHERE id = ${item.id} FOR UPDATE`;
        }

        const participantIds = offer.items
          .map((item) => item.raceParticipantId)
          .filter(Boolean)
          .sort();
        if (participantIds.length !== offer.items.length) {
          throw new ConflictError("Offer snapshot changed", "OFFER_CHANGED");
        }
        await tx.$queryRawUnsafe(
          `SELECT id FROM race_participants WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
          participantIds,
        );
        const participants = await tx.raceParticipant.findMany({
          where: { id: { in: participantIds }, userId },
          select: {
            id: true,
            raceId: true,
            placement: true,
            status: true,
            race: { select: { status: true } },
          },
          orderBy: { id: "asc" },
        });
        if (
          participants.length !== offer.items.length ||
          participants.some(
            (participant) =>
              participant.status !== "ACCEPTED" ||
              participant.race.status !== "COMPLETED",
          )
        ) {
          throw new ConflictError("Offer snapshot changed", "OFFER_CHANGED");
        }
        const currentItems = await eligibleItemsForParticipants(tx, userId, participants);
        const immutableByParticipant = new Map(
          offer.items.map((item) => [item.raceParticipantId, item]),
        );
        const exact = currentItems.length === offer.items.length &&
          currentItems.every((item) => {
            const frozen = immutableByParticipant.get(item.raceParticipantId);
            return frozen &&
              frozen.eligibleCoins === item.eligibleCoins &&
              frozen.sourceReason === item.sourceReason &&
              frozen.sourceRefId === item.sourceRefId &&
              frozen.placementSnapshot === item.placementSnapshot &&
              frozen.raceIdSnapshot === item.raceId;
          });
        const currentBase = currentItems.reduce((sum, item) => sum + item.eligibleCoins, 0);
        if (!exact || currentBase !== offer.baseCoins) {
          throw new ConflictError("Offer snapshot changed", "OFFER_CHANGED");
        }

        // Recompute the allowance under the durable identity lock. Offer
        // preparation is not an issuance authority: a stale/oversized row can
        // never make the ledger, grant, velocity record, or receipt exceed the
        // server's hard 100-coin ceiling.
        const maxBonusCoins = boundedRacePayoutDoubleMaxBonus(
          config.racePayoutDoubleMaxBonusCoins(),
        );
        const settledAt = (await tx.$queryRaw`SELECT NOW() AS now`)[0].now;
        const cutoff = new Date(settledAt.getTime() - 24 * 60 * 60 * 1000);
        const velocity = await tx.racePayoutDoubleVelocityGrant.aggregate({
          where: {
            providerSubHash: offer.providerSubHash,
            claimedAt: { gt: cutoff, lte: settledAt },
          },
          _sum: { bonusCoins: true },
        });
        const rolling24hRemainingBeforeClaim = Math.max(
          0,
          maxBonusCoins - (velocity._sum.bonusCoins || 0),
        );
        const bonusCoins = computeRacePayoutDoubleBonus({
          baseCoins: Math.min(currentBase, offer.bonusCoins),
          configuredMaxBonusCoins: maxBonusCoins,
          rolling24hRemaining: rolling24hRemainingBeforeClaim,
        });
        if (bonusCoins <= 0) {
          throw new ConflictError("Offer is no longer claimable", "OFFER_CHANGED");
        }
        const claimableOffer = {
          ...offer,
          bonusCoins,
          maxBonusCoins,
          rolling24hRemainingBeforeClaim,
        };

        const grant = await tx.adRewardGrant.findFirst({
          where: {
            userId,
            rewardKind: adRewards.RACE_PAYOUT_DOUBLE_REWARD_KIND,
            contextId: offerId,
            consumedAt: null,
          },
          orderBy: { createdAt: "asc" },
        });
        if (
          !grant ||
          !config
            .racePayoutDoubleAdUnitSuffixes()
            .includes(adRewards.normalizeAdUnit(grant.adUnit))
        ) {
          throw new ConflictError("Ad reward has not been verified", "AD_NOT_VERIFIED");
        }
        await tx.$queryRaw`SELECT id FROM ad_reward_grants WHERE id = ${grant.id} FOR UPDATE`;

        const awarded = await award({
          tx,
          userId,
          amount: bonusCoins,
          reason: "race_payout_ad_double",
          refId: offerId,
          createdAt: settledAt,
        });
        if (typeof dependencies.beforeRacePayoutDoubleCommit === "function") {
          await dependencies.beforeRacePayoutDoubleCommit({
            tx,
            offerId,
            userId,
          });
        }
        const grantUpdate = await tx.adRewardGrant.updateMany({
          where: { id: grant.id, consumedAt: null },
          data: {
            consumedAt: settledAt,
            rewardType: "COINS",
            coinAmount: bonusCoins,
          },
        });
        const offerUpdate = await tx.racePayoutDoubleOffer.updateMany({
          where: { id: offerId, status: "PENDING" },
          data: {
            status: "CLAIMED",
            claimedAt: settledAt,
            bonusCoins,
            maxBonusCoins,
            rolling24hRemainingBeforeClaim,
          },
        });
        if (!awarded.awarded || grantUpdate.count !== 1 || offerUpdate.count !== 1) {
          throw Object.assign(new Error("Concurrent claim"), { code: "40001" });
        }
        await tx.racePayoutDoubleVelocityGrant.create({
          data: {
            providerSubHash: offer.providerSubHash,
            offerId,
            bonusCoins,
            claimedAt: settledAt,
          },
        });
        await tx.racePayoutDoubleClaimReceipt.create({
          data: {
            offerId,
            providerSubHash: offer.providerSubHash,
            bonusCoins,
            claimedAt: settledAt,
          },
        });
        return claimBody(claimableOffer, offer.items, awarded.coins, false);
      }, { ...dependencies, prisma: db });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (typeof dependencies.onRacePayoutDoubleError === "function") {
        try { dependencies.onRacePayoutDoubleError(error); } catch {}
      }
      throw new AppError(
        "Reward temporarily unavailable",
        "REWARD_TEMPORARILY_UNAVAILABLE",
        503,
      );
    }
  };
}

const claimRacePayoutDouble = buildClaimRacePayoutDouble();

module.exports = {
  claimBody,
  buildClaimRacePayoutDouble,
  claimRacePayoutDouble,
};
