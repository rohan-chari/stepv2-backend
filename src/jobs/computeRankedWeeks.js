// Ranked v2 cron: keeps the weekly-cohort ladder live. Every tick (5 min,
// matching computeRanks):
//   1. Ensure the current week exists — on Monday rollover, open it and enroll
//      everyone active last week into step-matched, tier-homogeneous cohorts.
//   2. Refresh standings for the current week (totals, provisional ranks,
//      mid-week joiner placement).
//   3. Keep refreshing any past-boundary unsettled week during the grace
//      window (late timezone syncs), then settle it once the grace elapses.

const {
  RankedWeek,
  mondayOnOrBefore,
  addDaysUtc,
} = require("../models/rankedWeek");
const {
  enrollWeek,
  recomputeWeekStandings,
} = require("../services/rankedCohorts");
const { settleRankedWeek: defaultSettle } = require("../commands/settleRankedWeek");
const { SETTLE_GRACE_HOURS } = require("../constants/rankedCohorts");

const COMPUTE_INTERVAL_MS = 5 * 60 * 1000;

function buildComputeRankedWeeks(dependencies = {}) {
  const weekModel = dependencies.RankedWeek || RankedWeek;
  const enroll = dependencies.enrollWeek || enrollWeek;
  const recompute = dependencies.recomputeWeekStandings || recomputeWeekStandings;
  const settleRankedWeek = dependencies.settleRankedWeek || defaultSettle;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const graceMs =
    (dependencies.settleGraceHours ?? SETTLE_GRACE_HOURS) * 60 * 60 * 1000;

  return async function computeRankedWeeks() {
    const at = now();

    // 1. Ensure the current week exists (Monday rollover / first run).
    let week = await weekModel.getCurrent(at);
    if (!week) {
      const startsOn = mondayOnOrBefore(at);
      const endsOn = addDaysUtc(startsOn, 7);
      const latestIndex = await weekModel.getLatestIndex();
      week = await weekModel.create({
        index: latestIndex + 1,
        startsOn,
        endsOn,
      });
      const enrolled = await enroll({
        week,
        previousWindow: { startsOn: addDaysUtc(startsOn, -7), endsOn: startsOn },
      });
      logger.log(
        `[CRON] Opened ranked week ${week.index}: ${enrolled.members} members in ${enrolled.cohorts} cohorts`
      );
    }

    // 2. Live standings for the current week.
    const standings = await recompute({ week });

    // 3. Past-boundary weeks: refresh during grace, settle after it.
    const unsettled = await weekModel.findUnsettled(at);
    for (const past of unsettled) {
      if (past.id === week.id) continue;
      if (new Date(past.endsOn).getTime() + graceMs <= at.getTime()) {
        await settleRankedWeek({ weekId: past.id });
      } else {
        await recompute({ week: past });
      }
    }

    return { weekIndex: week.index, members: standings.members };
  };
}

const computeRankedWeeks = buildComputeRankedWeeks();

function scheduleComputeRankedWeeks(dependencies = {}) {
  const interval = dependencies.intervalMs || COMPUTE_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const computeFn = dependencies.computeRankedWeeks || computeRankedWeeks;

  async function run() {
    try {
      await computeFn();
    } catch (error) {
      logger.error("[CRON] Ranked weekly computation error:", error);
    }
  }

  run();
  setInterval(run, interval);
  logger.log(
    `[CRON] Ranked weekly computation scheduled (every ${interval / 1000}s)`
  );
}

module.exports = {
  buildComputeRankedWeeks,
  computeRankedWeeks,
  scheduleComputeRankedWeeks,
  COMPUTE_INTERVAL_MS,
};
