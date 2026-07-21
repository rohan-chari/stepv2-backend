// Ranked v2 weekly settlement: lock the week, rank each cohort on final step
// totals, promote/demote, mint placement + promotion coins, update home tiers,
// and grant the Legend cosmetic. At-most-once via the advisory-lock claim;
// every mint is idempotent on (reason, refId) so a re-run after a crash never
// double-pays — the same guarantees as settleRankedSeason.

const { prisma } = require("../../../db");
const { Steps } = require("../../steps/models/steps");
const {
  RankedWeek,
  RankedCohortMember,
} = require("../models/rankedWeek");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  summarizeWeekRows,
  rankCohortMembers,
} = require("../services/rankedCohorts");
const {
  zoneSizes,
  placementReward,
  nextTierUp,
  nextTierDown,
  tierConfig,
  MIN_ACTIVE_DAYS_FOR_REWARD,
} = require("../constants/rankedCohorts");
const { grantLegendCosmetic: defaultGrantLegend } = require("../../cosmetics");
const {
  RANKED_NOTIFICATIONS_ENABLED,
} = require("../constants/rankedNotifications");

// Outcome for one ranked member. Promotion (and any payout) requires at least
// one active day in the week — an idle account can hold or sink, never climb
// or earn.
function resolveOutcome({ rank, size, tier, activeDays }) {
  const { promote, demote } = zoneSizes(size, tier);
  const active = activeDays >= MIN_ACTIVE_DAYS_FOR_REWARD;

  let outcome = "HOLD";
  if (rank > size - demote) outcome = "DEMOTE";
  else if (active && rank <= promote) outcome = "PROMOTE";

  const resultTier =
    outcome === "PROMOTE"
      ? nextTierUp(tier)
      : outcome === "DEMOTE"
        ? nextTierDown(tier)
        : tier;

  const rewardCoins = active ? placementReward(rank, size, tier) : 0;
  const promotionCoins =
    outcome === "PROMOTE" ? tierConfig(resultTier).promotionBonus : 0;

  return { outcome, resultTier, rewardCoins, promotionCoins };
}

function buildSettleRankedWeek(dependencies = {}) {
  const weekModel = dependencies.RankedWeek || RankedWeek;
  const memberModel = dependencies.RankedCohortMember || RankedCohortMember;
  const stepsModel = dependencies.Steps || Steps;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const grantLegendCosmetic =
    dependencies.grantLegendCosmetic || defaultGrantLegend;
  const events = dependencies.eventBus || eventBus;
  const setUserTier =
    dependencies.setUserTier ||
    (async (userId, tier, since) => {
      // Only touch rankedTierV2Since when the tier actually changes; legacy
      // currentTier stays owned by the legacy season settlement so old
      // clients' badges match the ladder they see. The explicit null arm
      // matters: NOT:{field: x} won't match NULL rows (SQL three-valued
      // logic), which would strand never-placed users on null forever.
      await prisma.user.updateMany({
        where: {
          id: userId,
          OR: [{ rankedTierV2: null }, { NOT: { rankedTierV2: tier } }],
        },
        data: { rankedTierV2: tier, rankedTierV2Since: since },
      });
    });
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  // Ranked notifications are paused (see constants/rankedNotifications.js).
  // Injectable so tests can exercise the enabled path; defaults to the flag.
  const rankedNotificationsEnabled =
    dependencies.rankedNotificationsEnabled ?? RANKED_NOTIFICATIONS_ENABLED;

  return async function settleRankedWeek({ weekId }) {
    const claimed = await weekModel.claimForSettlement(weekId);
    if (!claimed) {
      return null; // another runner already settled / is settling this week
    }

    const week = await weekModel.getById(weekId);
    const rows = await stepsModel.findRowsInRange(week.startsOn, week.endsOn);
    const totalsByUser = summarizeWeekRows(rows);
    const members = await memberModel.listForWeek(weekId);

    const byCohort = new Map();
    for (const m of members) {
      if (!byCohort.has(m.cohortId)) byCohort.set(m.cohortId, []);
      byCohort.get(m.cohortId).push(m);
    }

    let settled = 0;
    let coinsMinted = 0;
    for (const cohortMembers of byCohort.values()) {
      const ranked = rankCohortMembers(cohortMembers, totalsByUser);
      const size = ranked.length;

      for (const m of ranked) {
        const result = resolveOutcome({
          rank: m.rank,
          size,
          tier: m.tier,
          activeDays: m.activeDays,
        });

        await memberModel.writeFinal({
          id: m.id,
          weeklySteps: m.weeklySteps,
          finalRank: m.rank,
          outcome: result.outcome,
          resultTier: result.resultTier,
          rewardCoins: result.rewardCoins,
          promotionCoins: result.promotionCoins,
        });

        if (result.rewardCoins > 0) {
          await awardCoinsFn({
            userId: m.userId,
            amount: result.rewardCoins,
            reason: "ranked_week_reward",
            refId: `week:${weekId}:user:${m.userId}`,
          });
          coinsMinted += result.rewardCoins;
        }

        // First entry into a tier ever — the refId is tier-scoped (not
        // week-scoped) so re-promotion after a demotion never re-pays.
        if (result.promotionCoins > 0) {
          const { awarded } = await awardCoinsFn({
            userId: m.userId,
            amount: result.promotionCoins,
            reason: "ranked_promotion_bonus",
            refId: `tier:${result.resultTier}:user:${m.userId}`,
          });
          if (awarded) coinsMinted += result.promotionCoins;
        }

        await setUserTier(m.userId, result.resultTier, now());

        if (result.resultTier === "LEGEND") {
          await grantLegendCosmetic({ userId: m.userId });
        }

        // Gated by the ranked-notifications pause. Settlement, coin awards, and
        // tier writes above always run; only this (unconsumed) emit is paused.
        if (rankedNotificationsEnabled) {
          events.emit("RANKED_WEEK_SETTLED_FOR_USER", {
            userId: m.userId,
            weekId,
            weekIndex: week.index,
            cohortId: m.cohortId,
            finalRank: m.rank,
            outcome: result.outcome,
            tier: m.tier,
            resultTier: result.resultTier,
            rewardCoins: result.rewardCoins,
            promotionCoins: result.promotionCoins,
          });
        }
        settled += 1;
      }
    }

    await weekModel.markClosed(weekId, now());
    logger.log(
      `[CRON] Settled ranked week ${week.index} (${settled} members, ${coinsMinted} coins minted)`
    );
    return { settledIndex: week.index, members: settled, coinsMinted };
  };
}

const settleRankedWeek = buildSettleRankedWeek();

module.exports = { buildSettleRankedWeek, settleRankedWeek, resolveOutcome };
