// Quiet-hours (sleep window) math for Drill Sergeant (§3.1). Pure + DST-safe: the
// target's wall-clock minute-of-day is read via Intl in their IANA zone, so a
// spring-forward / fall-back day is judged by the clock the target actually sees.
//
// The Drill Sergeant dare (hit 3,000 steps or lose 1,500) is blocked when the
// TARGET's local time is inside their sleep window — they can't respond asleep.

const { getTimeZoneParts } = require("../../../shared/time/week");

// [22:00, 07:00) target-local (owner-confirmed 2026-07-24). Minutes after
// local midnight; the window WRAPS midnight (start > end).
const DRILL_SERGEANT_QUIET_START_MIN = 22 * 60; // 1320
const DRILL_SERGEANT_QUIET_END_MIN = 7 * 60; //    420

// True when `date`'s wall-clock minute-of-day in `timeZone` is inside the
// half-open window [startMin, endMin). When startMin > endMin the window WRAPS
// midnight (in-window when min >= start OR min < end). Returns null when the
// zone is missing/invalid so the caller can fall through its fallback chain
// (target tz -> race tz -> fail-open); an empty window (start === end) is false.
function isInQuietHours(date, timeZone, startMin, endMin) {
  if (!timeZone || typeof timeZone !== "string") return null;
  let parts;
  try {
    parts = getTimeZoneParts(date, timeZone);
  } catch {
    return null; // invalid IANA zone
  }
  if (!Number.isFinite(parts.hour) || !Number.isFinite(parts.minute)) return null;
  if (startMin === endMin) return false;
  const min = parts.hour * 60 + parts.minute;
  if (startMin < endMin) return min >= startMin && min < endMin;
  return min >= startMin || min < endMin; // wraps midnight
}

// Convenience wrapper pinned to the Drill Sergeant window. Returns true/false/null
// exactly as isInQuietHours (null = zone unknown/invalid).
function isDrillSergeantQuietHours(date, timeZone) {
  return isInQuietHours(
    date,
    timeZone,
    DRILL_SERGEANT_QUIET_START_MIN,
    DRILL_SERGEANT_QUIET_END_MIN
  );
}

module.exports = {
  DRILL_SERGEANT_QUIET_START_MIN,
  DRILL_SERGEANT_QUIET_END_MIN,
  isInQuietHours,
  isDrillSergeantQuietHours,
};
