const crypto = require("node:crypto");
const { prisma } = require("../../../db");
const {
  AppError,
  ValidationError,
  ForbiddenError,
  ConflictError,
} = require("../../../shared/errors/AppError");
const adRewards = require("../../economy/adRewards");
const {
  eligibleItemsForParticipants,
} = require("../models/racePayoutDouble");
const {
  ROLLOUT_SETTING,
  providerSubHash,
  cohortBucket,
  boundedRolloutPercent,
} = require("../services/racePayoutDoublePolicy");
const {
  withRacePayoutDoubleTransaction,
} = require("../services/withRacePayoutDoubleTransaction");

function sameSet(left, right) {
  return left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
}

function responseFor(offer, created) {
  return {
    created,
    body: {
      offerId: offer.id,
      raceIds: offer.items.map((item) => item.raceIdSnapshot),
      baseCoins: offer.baseCoins,
      bonusCoins: offer.bonusCoins,
      maxBonusCoins: offer.maxBonusCoins,
      rolling24hRemainingBeforeClaim:
        offer.rolling24hRemainingBeforeClaim,
      status: offer.status,
    },
  };
}

function buildCreateRacePayoutDoubleOffer(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const config = dependencies.adRewardsConfig || adRewards;

  return async function createRacePayoutDoubleOffer({
    userId,
    raceIds,
    clientFeatures,
  }) {
    if (
      !Array.isArray(raceIds) ||
      raceIds.length === 0 ||
      raceIds.length > 10 ||
      raceIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(raceIds).size !== raceIds.length
    ) {
      throw new ValidationError("Invalid raceIds", "INVALID_REQUEST");
    }
    if (
      !clientFeatures?.has("race_payout_double") ||
      !config.adsRacePayoutDoublePrepareEnabled() ||
      config.racePayoutDoubleAdUnitIds().length === 0
    ) {
      throw new ForbiddenError(
        "Race payout double preparation is disabled",
        "PREPARATION_DISABLED",
      );
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { appleId: true, googleSub: true },
    });
    const hash = providerSubHash(user);
    if (!hash) {
      throw new ForbiddenError(
        "Race payout double preparation is disabled",
        "PREPARATION_DISABLED",
      );
    }
    const bucket = cohortBucket(hash);
    const maxBonusCoins = config.racePayoutDoubleMaxBonusCoins();

    try {
      return await withRacePayoutDoubleTransaction(async (tx) => {
        await tx.racePayoutDoubleIdentity.upsert({
          where: { providerSubHash: hash },
          create: { providerSubHash: hash, cohortBucket: bucket },
          update: {},
        });
        await tx.$queryRaw`SELECT provider_sub_hash FROM race_payout_double_identities WHERE provider_sub_hash = ${hash} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;

        const pending = await tx.racePayoutDoubleOffer.findFirst({
          where: { userId, status: "PENDING" },
          include: { items: { orderBy: { raceIdSnapshot: "asc" } } },
        });
        if (pending) {
          const pendingIds = pending.items.map((item) => item.raceIdSnapshot);
          if (sameSet(raceIds, pendingIds)) return responseFor(pending, false);
          throw new ConflictError("Another offer is pending", "OFFER_PENDING");
        }

        const rollout = await tx.appSetting.findUnique({
          where: { key: ROLLOUT_SETTING },
          select: { value: true },
        });
        const percent = boundedRolloutPercent(rollout?.value);
        if (bucket >= percent) {
          throw new ForbiddenError(
            "Race payout double preparation is disabled",
            "PREPARATION_DISABLED",
          );
        }

        const nowRows = await tx.$queryRaw`SELECT NOW() AS now`;
        const now = nowRows[0].now;
        const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const velocity = await tx.racePayoutDoubleVelocityGrant.aggregate({
          where: { providerSubHash: hash, claimedAt: { gt: cutoff, lte: now } },
          _sum: { bonusCoins: true },
        });
        const rolling24hRemainingBeforeClaim = Math.max(
          0,
          maxBonusCoins - (velocity._sum.bonusCoins || 0),
        );

        const completed = await tx.race.findMany({
          where: {
            status: "COMPLETED",
            tournamentId: null,
            participants: { some: { userId, status: { not: "DECLINED" } } },
          },
          select: {
            id: true,
            isTeamRace: true,
            participants: {
              where: { userId },
              select: {
                id: true,
                raceId: true,
                status: true,
                placement: true,
                resultsSeenAt: true,
              },
            },
          },
          orderBy: { completedAt: "desc" },
          take: 10,
        });
        const supportsTeamRaces = clientFeatures?.has("team_races") ?? false;
        const pageParticipants = completed
          .filter((race) => supportsTeamRaces || !race.isTeamRace)
          .map((race) => race.participants[0])
          .filter(Boolean);
        if (pageParticipants.some(
          (participant) => raceIds.includes(participant.raceId) && participant.resultsSeenAt,
        )) {
          throw new ConflictError("Results were already seen", "RESULTS_ALREADY_SEEN");
        }
        const candidates = pageParticipants.filter(
          (participant) => participant.status === "ACCEPTED" && !participant.resultsSeenAt,
        );
        const offeredRows = candidates.length
          ? await tx.racePayoutDoubleOfferItem.findMany({
              where: { raceParticipantId: { in: candidates.map((row) => row.id) } },
              select: { id: true, raceParticipantId: true },
              orderBy: { raceParticipantId: "asc" },
            })
          : [];
        for (const item of offeredRows) {
          await tx.$queryRaw`SELECT id FROM race_payout_double_offer_items WHERE id = ${item.id} FOR UPDATE`;
        }
        for (const participant of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
          await tx.$queryRaw`SELECT id FROM race_participants WHERE id = ${participant.id} FOR UPDATE`;
        }
        const offeredIds = new Set(offeredRows.map((row) => row.raceParticipantId));
        const items = await eligibleItemsForParticipants(
          tx,
          userId,
          candidates.filter((participant) => !offeredIds.has(participant.id)),
        );
        const eligibleIds = items.map((item) => item.raceId);
        if (!sameSet(raceIds, eligibleIds)) {
          throw new ConflictError("Offer snapshot changed", "OFFER_CHANGED");
        }
        const baseCoins = items.reduce((sum, item) => sum + item.eligibleCoins, 0);
        // §4.15: a verified offer is one full additional copy of its durable,
        // already-rounded base ledger payout. The historical cap fields remain
        // serialized for old clients/observability but cannot clip an approved
        // v1 offer into a partial award.
        const bonusCoins = baseCoins;
        if (baseCoins <= 0 || bonusCoins <= 0) {
          throw new ConflictError("Offer snapshot changed", "OFFER_CHANGED");
        }
        items.sort((left, right) => raceIds.indexOf(left.raceId) - raceIds.indexOf(right.raceId));
        const offer = await tx.racePayoutDoubleOffer.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            baseCoins,
            bonusCoins,
            maxBonusCoins,
            rolling24hRemainingBeforeClaim,
            providerSubHash: hash,
            items: { create: items },
          },
          include: { items: { orderBy: { raceIdSnapshot: "asc" } } },
        });
        return responseFor(offer, true);
      }, { ...dependencies, prisma: db });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.code === "P2002") {
        const winner = await db.racePayoutDoubleOffer.findFirst({
          where: { userId, status: "PENDING" },
          include: { items: { orderBy: { raceIdSnapshot: "asc" } } },
        });
        if (winner && sameSet(raceIds, winner.items.map((item) => item.raceIdSnapshot))) {
          return responseFor(winner, false);
        }
        throw new ConflictError("Another offer is pending", "OFFER_PENDING");
      }
      throw new AppError(
        "Reward temporarily unavailable",
        "REWARD_TEMPORARILY_UNAVAILABLE",
        503,
      );
    }
  };
}

const createRacePayoutDoubleOffer = buildCreateRacePayoutDoubleOffer();

module.exports = {
  sameSet,
  buildCreateRacePayoutDoubleOffer,
  createRacePayoutDoubleOffer,
};
