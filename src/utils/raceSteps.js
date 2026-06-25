const {
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("./week");

// Normalize a daily `steps` row's `date` to a YYYY-MM-DD local date string.
// Prod stores `date` as a Date (midnight UTC of the local date); test fakes use
// a plain "YYYY-MM-DD" string. Both reduce to the same key here.
function dailyRowDateKey(date) {
  if (!date) return null;
  if (typeof date === "string") return date.slice(0, 10);
  return new Date(date).toISOString().slice(0, 10);
}

// SHARED across the display path (getRaceProgress) and the settlement path
// (raceStateResolution) so the two stay logically identical — there is a
// display-vs-settlement parity test that depends on this.
//
// BUG 1 FIX: the race must NEVER count fewer steps than the user's
// authoritative daily total for the covered period. For each local day from
// `dayAfterStartDate` through `today` (in the participant's time zone) we take
//   max(that day's step_sample sum, that day's daily `steps` row)
// and sum those per-day maxes. Incomplete HealthKit samples can no longer
// suppress a larger daily total, and a stale daily row can no longer suppress
// larger samples. The START DAY is handled separately by the caller (samples
// only) so pre-race steps already baked into the daily total stay excluded.
async function calculateSubsequentSteps({
  userId,
  dayAfterStartDate,
  today,
  timeZone,
  stepsModel,
  stepSampleModel,
  now,
}) {
  if (dayAfterStartDate > today) {
    return 0;
  }

  const laterSteps = await stepsModel.findByUserIdAndDateRange(
    userId,
    dayAfterStartDate,
    today
  );
  const dailyByDate = new Map();
  for (const row of laterSteps) {
    const key = dailyRowDateKey(row.date);
    if (key) dailyByDate.set(key, (dailyByDate.get(key) || 0) + (row.steps || 0));
  }

  const nowMs = new Date(now).getTime();
  let total = 0;

  for (
    let date = dayAfterStartDate;
    date <= today;
    date = addDaysToDateString(date, 1)
  ) {
    const parsed = parseDateString(date);
    const dayStart = zonedDateTimeToUtc(
      {
        year: parsed.year,
        month: parsed.month,
        day: parsed.day,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone
    );
    // A day whose local midnight is at or after `now` contributes no steps. This
    // matters at settlement of a midnight-aligned race, where `now` (= endsAt)
    // lands exactly on the day boundary: without this guard, `today` resolves to
    // the day AFTER the race and its full daily total would leak into the score.
    // Days are ascending, so once one starts at/after `now`, all later ones do.
    if (dayStart.getTime() >= nowMs) break;
    const nextDate = addDaysToDateString(date, 1);
    const nextParsed = parseDateString(nextDate);
    let dayEnd = zonedDateTimeToUtc(
      {
        year: nextParsed.year,
        month: nextParsed.month,
        day: nextParsed.day,
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone
    );
    // Cap the final (today) day's window at `now` so we never count beyond it.
    if (dayEnd.getTime() > nowMs) {
      dayEnd = new Date(nowMs);
    }

    const daySamples = await stepSampleModel.sumStepsInWindow(
      userId,
      dayStart,
      dayEnd
    );
    const dailySteps = dailyByDate.get(date) || 0;
    total += Math.max(daySamples, dailySteps);
  }

  return total;
}

module.exports = { calculateSubsequentSteps, dailyRowDateKey };
