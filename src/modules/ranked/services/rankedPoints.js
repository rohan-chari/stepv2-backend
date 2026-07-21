// Pure Ranked Points (RP) computation from a user's daily Step rows. No DB
// access — the caller fetches Step rows for the season window and passes them
// in, which keeps this deterministic and unit-testable. The formula mirrors
// scripts/ranked-calibration.sql exactly so live tiers match the calibration.

const {
  RP_ACTIVE_FLOOR,
  RP_STEPS_PER_POINT,
  RP_STREAK_PER_DAY,
  RP_STREAK_CAP,
  RP_MILESTONES,
} = require("../constants/rankedTiers");

// Whole UTC-day index for a Step.date (stored as a date at UTC midnight), used
// to detect consecutive calendar days for streaks.
function dayIndex(date) {
  const time = date instanceof Date ? date.getTime() : new Date(date).getTime();
  return Math.floor(time / 86400000);
}

function milestonePoints(steps) {
  let total = 0;
  for (const m of RP_MILESTONES) {
    if (steps >= m.steps) total += m.points;
  }
  return total;
}

// Compute a user's earned RP over a set of daily step rows.
// @param {Array<{date: Date|string, steps: number}>} rows
// @returns {{ earnedPoints: number, activeDays: number }}
function computeSeasonRp(rows) {
  const sorted = [...(rows || [])]
    .map((r) => ({ day: dayIndex(r.date), steps: Math.max(0, r.steps || 0) }))
    .sort((a, b) => a.day - b.day);

  let earnedPoints = 0;
  let activeDays = 0;
  let streak = 0; // consecutive active-day count ending at prevActiveDay
  let prevActiveDay = null;

  for (const { day, steps } of sorted) {
    const active = steps >= RP_ACTIVE_FLOOR;
    let bonus = 0;

    if (active) {
      activeDays += 1;
      streak = prevActiveDay !== null && day - prevActiveDay === 1 ? streak + 1 : 1;
      prevActiveDay = day;
      bonus = Math.min(RP_STREAK_CAP, RP_STREAK_PER_DAY * (streak - 1));
    }

    const volume = Math.floor(steps / RP_STEPS_PER_POINT);
    earnedPoints += milestonePoints(steps) + volume + bonus;
  }

  return { earnedPoints, activeDays };
}

module.exports = { computeSeasonRp, milestonePoints, dayIndex };
