const { prisma } = require("../db");
const { Season, SeasonScore } = require("../models/season");
const { Steps } = require("../models/steps");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { recomputeStandings } = require("../services/rankedStandings");
const { TIER_REWARDS, SEASON_DURATION_DAYS } = require("../constants/rankedTiers");

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}

function buildSettleRankedSeason(dependencies = {}) {
  const seasonModel = dependencies.Season || Season;
  const seasonScoreModel = dependencies.SeasonScore || SeasonScore;
  const stepsModel = dependencies.Steps || Steps;
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
  const events = dependencies.eventBus || eventBus;
  const recompute = dependencies.recomputeStandings || recomputeStandings;
  const setUserTier =
    dependencies.setUserTier ||
    ((userId, tier, division) =>
      prisma.user.update({
        where: { id: userId },
        data: { currentTier: tier, currentDivision: division },
      }));
  const now = dependencies.now || (() => new Date());
  const seasonDurationDays =
    dependencies.seasonDurationDays || SEASON_DURATION_DAYS;
  const logger = dependencies.logger || console;

  return async function settleRankedSeason({ seasonId }) {
    // At-most-once: advisory lock + ACTIVE -> SETTLING compare-and-swap.
    const claimed = await seasonModel.claimForSettlement(seasonId);
    if (!claimed) {
      return null; // another runner already settled / is settling this season
    }

    const season = await seasonModel.getById(seasonId);
    const standings = await recompute({
      season,
      Steps: stepsModel,
      SeasonScore: seasonScoreModel,
    });

    for (const entry of standings) {
      await seasonScoreModel.writeFinal({
        userId: entry.userId,
        seasonId,
        points: entry.points,
        earnedPoints: entry.earnedPoints,
        carryOverSeed: entry.carryOverSeed,
        rank: entry.rank,
        tier: entry.tier,
        division: entry.division,
      });

      // Mint the tier reward. Idempotent on (reason, refId) so a re-run after a
      // crash never double-pays.
      const reward = TIER_REWARDS[entry.tier];
      if (reward && reward.coins > 0) {
        await awardCoinsFn({
          userId: entry.userId,
          amount: reward.coins,
          reason: "ranked_season_reward",
          refId: `season:${seasonId}:user:${entry.userId}`,
        });
      }

      // Denormalize the final tier onto the user for cross-surface badges.
      await setUserTier(entry.userId, entry.tier, entry.division);

      events.emit("SEASON_REWARD_GRANTED", {
        userId: entry.userId,
        seasonId,
        tier: entry.tier,
        division: entry.division,
        rank: entry.rank,
        coins: reward ? reward.coins : 0,
      });
    }

    await seasonModel.markClosed(seasonId, now());

    // Open the next season, starting where this one ended.
    const next = await seasonModel.create({
      index: season.index + 1,
      startsAt: season.endsAt,
      endsAt: addDays(season.endsAt, seasonDurationDays),
    });

    logger.log(
      `[CRON] Settled ranked season ${season.index} (${standings.length} ranked); opened season ${next.index}`
    );

    return { settledIndex: season.index, ranked: standings.length, nextSeasonId: next.id };
  };
}

const settleRankedSeason = buildSettleRankedSeason();

module.exports = { buildSettleRankedSeason, settleRankedSeason, addDays };
