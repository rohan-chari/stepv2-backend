const { prisma } = require("../../../db");
const { JobRun } = require("../../../shared/db/jobRun");
const {
  safeStructuredEvent,
  HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS,
} = require("../services/racePayoutDoublePolicy");
const { RACE_PAYOUT_DOUBLE_REWARD_KIND } = require("../../economy/adRewards");

const JOB_NAME = "race-payout-double-reconcile";
const HEALTHY_JOB_NAME = "race-payout-double-reconcile-healthy";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 48 * 60 * 60 * 1000;

function fiveMinuteBucket(date) {
  const bucket = new Date(date);
  bucket.setUTCSeconds(0, 0);
  bucket.setUTCMinutes(Math.floor(bucket.getUTCMinutes() / 5) * 5);
  return bucket.toISOString().slice(0, 16);
}

function sourceIsExact(item) {
  if (!Number.isInteger(item.placementSnapshot) || item.placementSnapshot <= 0) {
    return false;
  }
  if (item.sourceReason === "race_prize_pool_payout") {
    return item.sourceRefId === `${item.raceIdSnapshot}:${item.placementSnapshot}`;
  }
  if (item.sourceReason === "race_finish_reward") {
    return item.sourceRefId ===
      `${item.raceIdSnapshot}:rank:${item.placementSnapshot}`;
  }
  return false;
}

function oneBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = row[key];
    const list = map.get(value) || [];
    list.push(row);
    map.set(value, list);
  }
  return map;
}

function buildRacePayoutDoubleReconcile(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const jobRun = dependencies.JobRun || JobRun;
  const logger = dependencies.logger || console;

  return async function reconcileRacePayoutDouble() {
    const now = dependencies.now
      ? new Date(dependencies.now)
      : (await db.$queryRaw`SELECT NOW() AS now`)[0].now;
    const bucket = fiveMinuteBucket(now);
    if (!(await jobRun.claimRun(JOB_NAME, bucket))) {
      return { claimed: false, healthy: null };
    }
    const cutoff = new Date(now.getTime() - DAY_MS);
    const retentionCutoff = new Date(now.getTime() - RETENTION_MS);
    try {
      // The claimed offer is the canonical 24-hour settlement anchor. First
      // collect every ID that has any in-window settlement evidence, then load
      // all counterparts for those IDs without independently time-filtering
      // them. This prevents app-clock/DB-clock skew or a transaction straddling
      // the exact cutoff from manufacturing a false orphan.
      const [offersInWindow, ledgerInWindow, grantsInWindow, velocitiesInWindow, receiptsInWindow] = await Promise.all([
        db.racePayoutDoubleOffer.findMany({
          where: { status: "CLAIMED", claimedAt: { gt: cutoff, lte: now } },
          select: { id: true },
        }),
        db.coinTransaction.findMany({
          where: {
            reason: "race_payout_ad_double",
            createdAt: { gt: cutoff, lte: now },
          },
          select: { refId: true },
        }),
        db.adRewardGrant.findMany({
          where: {
            rewardKind: RACE_PAYOUT_DOUBLE_REWARD_KIND,
            consumedAt: { gt: cutoff, lte: now },
          },
          select: { contextId: true },
        }),
        db.racePayoutDoubleVelocityGrant.findMany({
          where: { claimedAt: { gt: cutoff, lte: now } },
          select: { offerId: true },
        }),
        db.racePayoutDoubleClaimReceipt.findMany({
          where: { claimedAt: { gt: cutoff, lte: now } },
          select: { offerId: true },
        }),
      ]);
      const relevantOfferIds = [...new Set([
        ...offersInWindow.map((row) => row.id),
        ...ledgerInWindow.map((row) => row.refId),
        ...grantsInWindow.map((row) => row.contextId),
        ...velocitiesInWindow.map((row) => row.offerId),
        ...receiptsInWindow.map((row) => row.offerId),
      ].filter(Boolean))];
      const [offers, ledger, grants, velocities, receipts] = relevantOfferIds.length
        ? await Promise.all([
            db.racePayoutDoubleOffer.findMany({
              where: { id: { in: relevantOfferIds }, status: "CLAIMED" },
              include: { items: true },
            }),
            db.coinTransaction.findMany({
              where: {
                reason: "race_payout_ad_double",
                refId: { in: relevantOfferIds },
              },
            }),
            db.adRewardGrant.findMany({
              where: {
                rewardKind: RACE_PAYOUT_DOUBLE_REWARD_KIND,
                contextId: { in: relevantOfferIds },
                consumedAt: { not: null },
              },
            }),
            db.racePayoutDoubleVelocityGrant.findMany({
              where: { offerId: { in: relevantOfferIds } },
            }),
            db.racePayoutDoubleClaimReceipt.findMany({
              where: { offerId: { in: relevantOfferIds } },
            }),
          ])
        : [[], [], [], [], []];
      const offerById = new Map(offers.map((row) => [row.id, row]));
      const ledgerByOffer = oneBy(ledger, "refId");
      const grantsByOffer = oneBy(grants, "contextId");
      const velocityByOffer = oneBy(velocities, "offerId");
      const receiptByOffer = oneBy(receipts, "offerId");
      const failures = [];

      for (const offer of offers) {
        const coinRows = ledgerByOffer.get(offer.id) || [];
        const grantRows = grantsByOffer.get(offer.id) || [];
        const velocityRows = velocityByOffer.get(offer.id) || [];
        const receiptRows = receiptByOffer.get(offer.id) || [];
        if (
          offer.bonusCoins > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS ||
          offer.maxBonusCoins > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS ||
          offer.rolling24hRemainingBeforeClaim > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS ||
          coinRows.some((row) => row.amount > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS) ||
          grantRows.some((row) => row.coinAmount > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS) ||
          velocityRows.some((row) => row.bonusCoins > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS) ||
          receiptRows.some((row) => row.bonusCoins > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS)
        ) failures.push("hard_cap_equation");
        if (coinRows.length !== 1 || coinRows[0]?.amount !== offer.bonusCoins) {
          failures.push("ledger_equation");
        }
        if (
          grantRows.length !== 1 ||
          grantRows[0]?.coinAmount !== offer.bonusCoins ||
          grantRows[0]?.rewardType !== "COINS"
        ) failures.push("grant_equation");
        if (velocityRows.length !== 1 || velocityRows[0]?.bonusCoins !== offer.bonusCoins) {
          failures.push("velocity_equation");
        }
        if (receiptRows.length !== 1 || receiptRows[0]?.bonusCoins !== offer.bonusCoins) {
          failures.push("receipt_equation");
        }
        const itemSum = offer.items.reduce((sum, item) => sum + item.eligibleCoins, 0);
        if (itemSum !== offer.baseCoins || offer.items.some((item) => !sourceIsExact(item))) {
          failures.push("source_equation");
        }
      }

      for (const velocity of velocities) {
        if (offerById.has(velocity.offerId)) continue;
        const receiptRows = receiptByOffer.get(velocity.offerId) || [];
        if (
          receiptRows.length !== 1 ||
          receiptRows[0].bonusCoins !== velocity.bonusCoins ||
          !receiptRows[0].accountDeletedAt
        ) failures.push("unexplained_velocity_orphan");
      }
      for (const receipt of receipts) {
        if (!offerById.has(receipt.offerId) && !receipt.accountDeletedAt) {
          failures.push("unexplained_receipt_orphan");
        }
      }
      for (const row of ledger) {
        if (!offerById.has(row.refId)) failures.push("ledger_orphan");
      }
      for (const grant of grants) {
        if (!offerById.has(grant.contextId)) failures.push("grant_orphan");
      }

      const rollingBonusByIdentity = new Map();
      for (const velocity of velocities) {
        if (!(velocity.claimedAt > cutoff && velocity.claimedAt <= now)) continue;
        rollingBonusByIdentity.set(
          velocity.providerSubHash,
          (rollingBonusByIdentity.get(velocity.providerSubHash) || 0) + velocity.bonusCoins,
        );
      }
      if ([...rollingBonusByIdentity.values()].some(
        (total) => total > HARD_MAX_RACE_PAYOUT_DOUBLE_BONUS_COINS,
      )) failures.push("rolling_cap_equation");

      const inWindowOfferIds = new Set(offersInWindow.map((row) => row.id));
      const metricOffers = offers.filter((offer) => inWindowOfferIds.has(offer.id));
      const bonus = metricOffers.reduce((sum, offer) => sum + offer.bonusCoins, 0);
      const identityCount = new Set(metricOffers.map((offer) => offer.providerSubHash)).size;
      const batchesPerIdentity = identityCount > 0 ? metricOffers.length / identityCount : 0;
      const capHits = metricOffers.filter(
        (offer) =>
          offer.bonusCoins === offer.maxBonusCoins ||
          offer.bonusCoins === offer.rolling24hRemainingBeforeClaim,
      ).length;
      const reasons = {};
      for (const offer of metricOffers) {
        for (const item of offer.items) {
          reasons[item.sourceReason] = (reasons[item.sourceReason] || 0) + 1;
        }
      }
      const ssvCount = await db.adRewardGrant.count({
        where: {
          rewardKind: RACE_PAYOUT_DOUBLE_REWARD_KIND,
          createdAt: { gt: cutoff, lte: now },
        },
      });
      const healthy = failures.length === 0;
      const event = {
        event: healthy ? "race_payout_double_reconcile" : "race_payout_double_alert",
        healthy,
        claims: metricOffers.length,
        bonus,
        distinctHashedIdentities: identityCount,
        batchesPerIdentity24h: batchesPerIdentity,
        capHits,
        eligibleReasons: reasons,
        ssvToClaimConversion: ssvCount > 0 ? metricOffers.length / ssvCount : 0,
        failureCodes: [...new Set(failures)],
      };
      safeStructuredEvent(logger, event);
      if (healthy && typeof jobRun.markRan === "function") {
        await jobRun.markRan(HEALTHY_JOB_NAME, bucket);
      }

      // Economy audit rows live at least 48h. Pruning is deliberately after
      // validation so rows in the reconciliation/deletion window cannot vanish
      // before their equations are checked.
      await Promise.all([
        db.racePayoutDoubleVelocityGrant.deleteMany({
          where: { claimedAt: { lte: retentionCutoff } },
        }),
        db.racePayoutDoubleClaimReceipt.deleteMany({
          where: { claimedAt: { lte: retentionCutoff } },
        }),
      ]);
      return { claimed: true, healthy, metrics: event };
    } catch (error) {
      safeStructuredEvent(logger, {
        event: "race_payout_double_alert",
        healthy: false,
        failureCodes: ["reconcile_exception"],
      });
      throw error;
    }
  };
}

function scheduleRacePayoutDoubleReconcile(dependencies = {}) {
  const logger = dependencies.logger || console;
  const run = dependencies.run || buildRacePayoutDoubleReconcile(dependencies);
  const tick = () => Promise.resolve(run()).catch((error) => {
    try { logger.error("[CRON] race payout double reconciliation failed:", error); } catch {}
  });
  tick();
  const interval = setInterval(tick, FIVE_MINUTES_MS);
  interval.unref?.();
  try { logger.log("[CRON] Race payout double reconciliation scheduled (5m)"); } catch {}
  return interval;
}

module.exports = {
  JOB_NAME,
  HEALTHY_JOB_NAME,
  fiveMinuteBucket,
  sourceIsExact,
  buildRacePayoutDoubleReconcile,
  scheduleRacePayoutDoubleReconcile,
};
