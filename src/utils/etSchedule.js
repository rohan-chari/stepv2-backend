const { getTimeZoneParts } = require("./week");

// Idempotency helper for ET-anchored daily cron jobs (notification cleanup @1am
// ET, daily-mover digest @4pm ET). Both jobs ride the shared 5-minute tick and
// must fire EXACTLY ONCE per ET calendar day — even though the process restarts
// often (so in-memory "did I run?" state is unreliable) and DST shifts the
// UTC offset twice a year.
//
// The trick: we never compute exact instants. We read `now`'s wall-clock ET
// hour and ET date, and compare the date against a persisted "last ran for"
// day-key (JobRun.lastRanFor). DST-proof because both sides are wall-clock ET.
//
// All functions here are pure; the persistence lives in the JobRun model.
const ET = "America/New_York";

// "YYYY-MM-DD" for `date` in ET. This is the per-day idempotency key.
function etDayKey(date, timeZone = ET) {
  const { year, month, day } = getTimeZoneParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Wall-clock ET hour (0–23) at `date`.
function etHour(date, timeZone = ET) {
  return getTimeZoneParts(date, timeZone).hour;
}

// Decide whether a tick should run a daily job anchored at `targetHour` (ET).
// Returns the day-key to persist if the job should run now, or null if not.
//
// Runs when: it's at/after the target hour on the current ET day AND we haven't
// already completed a run for this ET day. A tick that lands after the target
// hour still fires (e.g. first tick after a restart that skipped the exact
// boundary), so a missed boundary self-heals within the same ET day.
function dailyRunKey({ now, targetHour, lastRanFor }) {
  const dayKey = etDayKey(now);
  if (etHour(now) < targetHour) return null;
  if (lastRanFor === dayKey) return null;
  return dayKey;
}

module.exports = { etDayKey, etHour, dailyRunKey, ET };
