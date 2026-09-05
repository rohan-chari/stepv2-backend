const {
  addDaysToDateString,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../shared/time/week");

// Normalize a daily `steps` row's `date` to a YYYY-MM-DD local date string.
// Prod stores `date` as a Date (midnight UTC of the local date); test fakes use
// a plain "YYYY-MM-DD" string. Both reduce to the same key here.
function dailyRowDateKey(date) {
  if (!date) return null;
  if (typeof date === "string") return date.slice(0, 10);
  return new Date(date).toISOString().slice(0, 10);
}

// A single resumable day of the canonical base-step walk. Keep the ordinary
// scorer's bulk query below: capture workers use this descriptor one day at a
// time, while HTTP display/resolution still batches all descriptors.
function subsequentDayWindow({ date, timeZone, now }) {
  const midnight = (key) => {
    const parsed = parseDateString(key);
    return zonedDateTimeToUtc({ ...parsed, hour: 0, minute: 0, second: 0 }, timeZone);
  };
  const start = midnight(date);
  const nowMs = new Date(now).getTime();
  if (start.getTime() >= nowMs) return null;
  const end = midnight(addDaysToDateString(date, 1));
  return { date, start, end: new Date(Math.min(end.getTime(), nowMs)),
    isCompleteDay: end.getTime() <= nowMs };
}

function subsequentDayContribution(window, sampleSteps, dailySteps, allowPartialDayDaily) {
  return Math.max(sampleSteps || 0,
    window.isCompleteDay || allowPartialDayDaily ? dailySteps || 0 : 0);
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
  allowPartialDayDaily = true,
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

  // First pass: compute each day's window (identical boundaries and guards to
  // the original one-query-per-day loop), THEN sum all windows in one batched
  // query. Per-day results are unchanged; only the number of round-trips is.
  const dayWindows = [];

  for (
    let date = dayAfterStartDate;
    date <= today;
    date = addDaysToDateString(date, 1)
  ) {
    // A day whose local midnight is at or after `now` contributes no steps. This
    // matters at settlement of a midnight-aligned race, where `now` (= endsAt)
    // lands exactly on the day boundary: without this guard, `today` resolves to
    // the day AFTER the race and its full daily total would leak into the score.
    // Days are ascending, so once one starts at/after `now`, all later ones do.
    const window = subsequentDayWindow({ date, timeZone, now });
    if (!window) break;
    dayWindows.push(window);
  }

  // Batched path when the model supports it (the real StepSample does); fall
  // back to per-window sums for injected fakes that only implement
  // sumStepsInWindow. Both paths produce identical numbers.
  const daySampleSums =
    typeof stepSampleModel.sumStepsInWindows === "function"
      ? await stepSampleModel.sumStepsInWindows(userId, dayWindows)
      : await Promise.all(
          dayWindows.map((w) =>
            stepSampleModel.sumStepsInWindow(userId, w.start, w.end)
          )
        );

  let total = 0;
  for (let i = 0; i < dayWindows.length; i++) {
    // A daily row is authoritative for a completed local day and for the
    // genuinely-live current day (where it cannot contain future walking). At
    // a historical race deadline inside a day, however, that row may have been
    // updated after the race ended; use only time-sliced samples there.
    total += subsequentDayContribution(dayWindows[i], daySampleSums[i],
      dailyByDate.get(dayWindows[i].date), allowPartialDayDaily);
  }

  return total;
}

module.exports = { calculateSubsequentSteps, dailyRowDateKey,
  subsequentDayWindow, subsequentDayContribution };
