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
const { RANKED_SETTLEMENT_ENABLED } = require("../constants/rankedSettlement");

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
  const settlementEnabled =
    dependencies.rankedSettlementEnabled ?? RANKED_SETTLEMENT_ENABLED;

  return async function computeRankedWeeks() {
    // Ranked is paused: skip the whole pipeline (open/enroll/standings/settle)
    // so no ranked coins are minted. See constants/rankedSettlement.js.
    if (!settlementEnabled) {
      return { disabled: true, weekIndex: null, members: 0 };
    }

    const at = now();

    // 1. Settle (or, within the grace window, just refresh) every past-boundary
    //    week BEFORE opening the next one. Enrollment tiers each player from
    //    User.rankedTierV2, so the previous week's promotions/demotions must be
    //    applied first — otherwise everyone promoted at settlement gets enrolled
    //    into their *old* tier's cohort for the entire new week. A week still
    //    inside its grace window blocks the next open (handled in step 2).
    const unsettled = await weekModel.findUnsettled(at);
    let graceBlocking = false;
    for (const past of unsettled) {
      if (new Date(past.endsOn).getTime() + graceMs <= at.getTime()) {
        await settleRankedWeek({ weekId: past.id });
      } else {
        await recompute({ week: past });
        graceBlocking = true;
      }
    }

    // 2. Open the current week — but only once every past week has settled.
    //    During the prior week's grace window we deliberately hold off, so the
    //    new week starts up to SETTLE_GRACE_HOURS late and enrollment reads the
    //    settled tiers. Settlement and this open land in the same tick, so there
    //    is no closed-and-no-open gap; getRankedV2 surfaces the still-settling
    //    prior week meanwhile (getLatestUnclosed), keeping the ranked tab live.
    let week = await weekModel.getCurrent(at);
    if (!week && !graceBlocking) {
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

    // 3. Live standings for the open week (none exists during the grace gap).
    let standings = { members: 0 };
    if (week) {
      standings = await recompute({ week });
    }

    return { weekIndex: week ? week.index : null, members: standings.members };
  };
}

const computeRankedWeeks = buildComputeRankedWeeks();

function scheduleComputeRankedWeeks(dependencies = {}) {
  const interval = dependencies.intervalMs || COMPUTE_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const computeFn = dependencies.computeRankedWeeks || computeRankedWeeks;
  const settlementEnabled =
    dependencies.rankedSettlementEnabled ?? RANKED_SETTLEMENT_ENABLED;

  if (!settlementEnabled) {
    logger.log(
      "[CRON] Ranked weekly computation DISABLED (RANKED_SETTLEMENT_ENABLED=false)"
    );
    return;
  }

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
