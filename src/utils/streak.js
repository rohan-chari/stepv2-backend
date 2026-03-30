const { addDaysToDateString } = require("./week");

/**
 * Calculate the consecutive-day step streak using each day's locked-in goal.
 *
 * @param {string} todayStr  Today's date as "YYYY-MM-DD".
 * @param {Map<string, { steps: number, stepGoal: number | null }>} dateMap
 *   Maps date strings to the day's step count and locked-in goal.
 * @param {number} defaultStepGoal  Fallback goal for records with null stepGoal.
 * @returns {number}
 */
function calculateStreak(todayStr, dateMap, defaultStepGoal) {
  let streak = 0;

  const todayEntry = dateMap.get(todayStr);
  const todayGoal = todayEntry?.stepGoal ?? defaultStepGoal;
  const todayHit = (todayEntry?.steps || 0) >= todayGoal;

  // Count consecutive days backward from yesterday
  for (let i = 1; ; i++) {
    const dStr = addDaysToDateString(todayStr, -i);
    const entry = dateMap.get(dStr);
    if (entry === undefined) break;
    const dayGoal = entry.stepGoal ?? defaultStepGoal;
    if (entry.steps < dayGoal) break;
    streak++;
  }

  // Only add today if the goal is already met
  if (todayHit) streak++;

  return streak;
}

module.exports = { calculateStreak };
