const { Season, SeasonScore } = require("../models/season");
const { Steps } = require("../models/steps");
const { settleRankedSeason: defaultSettle, addDays } = require("../commands/settleRankedSeason");
const { recomputeStandings } = require("../services/rankedStandings");
const { SEASON_DURATION_DAYS } = require("../constants/rankedTiers");

const COMPUTE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes (matches race jobs)

function buildComputeRanks(dependencies = {}) {
  const seasonModel = dependencies.Season || Season;
  const seasonScoreModel = dependencies.SeasonScore || SeasonScore;
  const stepsModel = dependencies.Steps || Steps;
  const settleRankedSeason = dependencies.settleRankedSeason || defaultSettle;
  const recompute = dependencies.recomputeStandings || recomputeStandings;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const seasonDurationDays =
    dependencies.seasonDurationDays || SEASON_DURATION_DAYS;

  return async function computeRanks() {
    // Ensure there is a live season. Only the very first run has none — the
    // settlement command always opens the next season as it closes one.
    let season = await seasonModel.getActive();
    if (!season) {
      const startsAt = now();
      const latestIndex = await seasonModel.getLatestIndex();
      season = await seasonModel.create({
        index: latestIndex + 1,
        startsAt,
        endsAt: addDays(startsAt, seasonDurationDays),
      });
      logger.log(`[CRON] Opened first ranked season ${season.index}`);
    }

    // Refresh the live ladder.
    const standings = await recompute({
      season,
      Steps: stepsModel,
      SeasonScore: seasonScoreModel,
    });
    for (const entry of standings) {
      await seasonScoreModel.writeProvisional({
        userId: entry.userId,
        seasonId: season.id,
        points: entry.points,
        earnedPoints: entry.earnedPoints,
        carryOverSeed: entry.carryOverSeed,
        rank: entry.rank,
        tier: entry.tier,
        division: entry.division,
      });
    }

    // Settle once the season has run its course.
    if (season.endsAt && new Date(season.endsAt).getTime() <= now().getTime()) {
      await settleRankedSeason({ seasonId: season.id });
    }

    return { seasonIndex: season.index, ranked: standings.length };
  };
}

const computeRanks = buildComputeRanks();

function scheduleComputeRanks(dependencies = {}) {
  const interval = dependencies.intervalMs || COMPUTE_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const computeFn = dependencies.computeRanks || computeRanks;

  async function run() {
    try {
      await computeFn();
    } catch (error) {
      logger.error("[CRON] Ranked computation error:", error);
    }
  }

  run();
  setInterval(run, interval);
  logger.log(`[CRON] Ranked computation scheduled (every ${interval / 1000}s)`);
}

module.exports = {
  buildComputeRanks,
  computeRanks,
  scheduleComputeRanks,
  COMPUTE_INTERVAL_MS,
};
