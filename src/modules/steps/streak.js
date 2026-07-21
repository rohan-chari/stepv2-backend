const { addDaysToDateString } = require("../../shared/time/week");

/**
 * Calculate the consecutive-day step streak.
 *
 * Step goals were removed from the product, so the streak rule is now simply
 * "consecutive days with any recorded step activity (> 0)". Today only adds
 * to the streak if today's record itself has > 0 steps; if today has 0 (or no
 * record), the streak shows the run of prior days.
 *
 * @param {string} todayStr  Today's date as "YYYY-MM-DD".
 * @param {Map<string, { steps: number }>} dateMap
 *   Maps date strings to the day's step count.
 * @returns {number}
 */
function calculateStreak(todayStr, dateMap) {
  let streak = 0;

  const todayEntry = dateMap.get(todayStr);
  const todayHit = (todayEntry?.steps || 0) > 0;

  // Count consecutive days backward from yesterday.
  for (let i = 1; ; i++) {
    const dStr = addDaysToDateString(todayStr, -i);
    const entry = dateMap.get(dStr);
    if (entry === undefined) break;
    if ((entry.steps || 0) <= 0) break;
    streak++;
  }

  if (todayHit) streak++;

  return streak;
}

module.exports = { calculateStreak };
