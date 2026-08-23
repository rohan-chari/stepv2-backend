const { prisma } = require("../../../db");
const adRewards = require("../../economy/adRewards");
const {
  RacePayoutDouble,
} = require("../models/racePayoutDouble");
const {
  providerSubHash,
  boundedRacePayoutDoubleMaxBonus,
  computeRacePayoutDoubleBonus,
  normalizedRacePayoutDoubleAmounts,
  FLAT_50_REWARD_MODE,
  FLAT_50_COINS_PER_RACE,
} = require("../services/racePayoutDoublePolicy");

function serializeOffer(offer, allowance = {}) {
  // Older persisted PENDING rows may predate the restored 100-coin ceiling.
  // Serialize the claimable amount, never the stale oversized snapshot.
  const amounts = normalizedRacePayoutDoubleAmounts(offer, allowance);
  return {
    offerId: offer.id,
    raceIds: offer.items.map((item) => item.raceIdSnapshot),
    ...amounts,
  };
}

function buildGetRacePayoutDoubleOffer(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const config = dependencies.adRewardsConfig || adRewards;
  const model = dependencies.RacePayoutDouble || RacePayoutDouble;

  return async function getRacePayoutDoubleOffer({
    userId,
    completed,
    pendingOffer = null,
  }) {
    const pending = pendingOffer || await model.findPending(userId);
    if (pending) {
      const maxBonusCoins = boundedRacePayoutDoubleMaxBonus(
        config.racePayoutDoubleMaxBonusCoins(),
      );
      if (pending.rewardMode === FLAT_50_REWARD_MODE) {
        const serialized = serializeOffer(pending);
        return serialized.bonusCoins > 0 ? serialized : null;
      }
      const nowRows = await db.$queryRaw`SELECT NOW() AS now`;
      const now = nowRows[0].now;
      const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const velocity = await db.racePayoutDoubleVelocityGrant.aggregate({
        where: {
          providerSubHash: pending.providerSubHash,
          claimedAt: { gt: cutoff, lte: now },
        },
        _sum: { bonusCoins: true },
      });
      const rolling24hRemaining = Math.max(
        0,
        maxBonusCoins - (velocity._sum.bonusCoins || 0),
      );
      const serialized = serializeOffer(pending, {
        configuredMaxBonusCoins: maxBonusCoins,
        rolling24hRemaining,
      });
      return serialized.bonusCoins > 0 ? serialized : null;
    }

    if (!config.adsRacePayoutDoublePrepareEnabled()) return null;
    if (config.racePayoutDoubleAdUnitIds().length === 0) return null;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { appleId: true, googleSub: true },
    });
    const hash = providerSubHash(user);
    if (!hash) return null;
    const maxBonusCoins = boundedRacePayoutDoubleMaxBonus(
      config.racePayoutDoubleMaxBonusCoins(),
    );
    const nowRows = await db.$queryRaw`SELECT NOW() AS now`;
    const now = nowRows[0].now;
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const velocity = await db.racePayoutDoubleVelocityGrant.aggregate({
      where: { providerSubHash: hash, claimedAt: { gt: cutoff, lte: now } },
      _sum: { bonusCoins: true },
    });
    const rolling24hRemainingBeforeClaim = Math.max(
      0,
      maxBonusCoins - (velocity._sum.bonusCoins || 0),
    );

    const eligibleRows = completed.filter(
      (race) => race.myStatus === "ACCEPTED" && race.myResultsSeen === false,
    );
    if (!eligibleRows.length) return null;
    const participants = await db.raceParticipant.findMany({
      where: {
        userId,
        raceId: { in: eligibleRows.map((race) => race.id) },
        status: "ACCEPTED",
        race: { status: "COMPLETED" },
      },
      select: { id: true, raceId: true, placement: true },
    });
    const offered = await model.findOfferedParticipantIds(
      participants.map((participant) => participant.id),
    );
    const offeredIds = new Set(offered.map((row) => row.raceParticipantId));
    const items = await model.eligibleItems(
      userId,
      participants.filter((participant) => !offeredIds.has(participant.id)),
    );
    const baseCoins = items.reduce((sum, item) => sum + item.eligibleCoins, 0);
    const bonusCoins = FLAT_50_COINS_PER_RACE * items.length;
    if (bonusCoins <= 0) return null;
    const completedOrder = new Map(completed.map((race, index) => [race.id, index]));
    items.sort(
      (left, right) => completedOrder.get(left.raceId) - completedOrder.get(right.raceId),
    );
    return {
      offerId: null,
      raceIds: items.map((item) => item.raceId),
      baseCoins,
      bonusCoins,
      maxBonusCoins: bonusCoins,
      rolling24hRemainingBeforeClaim: bonusCoins,
      rewardMode: FLAT_50_REWARD_MODE,
    };
  };
}

const getRacePayoutDoubleOffer = buildGetRacePayoutDoubleOffer();

module.exports = {
  serializeOffer,
  buildGetRacePayoutDoubleOffer,
  getRacePayoutDoubleOffer,
};
