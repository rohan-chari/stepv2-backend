// Global step-multiplier event ("BeReal-style" 2x event).
//
// This module holds the PURE, testable pieces of the feature:
//   1. computeGlobalEventBoost  — the step math (how many EXTRA steps a
//      participant earns because their samples overlapped an active event
//      window), stacking MULTIPLICATIVELY with the per-participant timed
//      multipliers the resolution already understands.
//   2. shouldStartGlobalEvent / chooseEventStartForEtDay — the scheduler
//      decision (whether a 5-minute tick should create a new event now):
//      one event per ET day at a deterministically-random wall-clock time
//      drawn from a day-of-week window, plus idempotency.
//
// Everything is dependency-injected (no DB calls inside the math) so both
// getRaceProgress (display) and raceExpiry (settlement) can compute identical
// totals by passing in the same active events.

const { getTimeZoneParts, zonedDateTimeToUtc } = require("./week");
const { etDayKey, ET } = require("./etSchedule");

// ---------------------------------------------------------------------------
// Tuning constants — change these to tune frequency/shape of events.
// ---------------------------------------------------------------------------

// One event per ET day, at a random wall-clock minute drawn from these windows
// (minutes after ET midnight, [start, end) half-open). ET-anchored — the same
// instant globally (fair), and DST-safe because conversion goes through
// zonedDateTimeToUtc, unlike the old fixed 22:00-UTC anchor which silently
// drifted from 6PM ET (EDT) to 5PM ET (EST) every winter.
//
// Mon–Thu: off-work hours only — mornings 8-10AM and evenings 4-9PM ET.
const GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN = [
  [8 * 60, 10 * 60],
  [16 * 60, 21 * 60],
];
// Fri/Sat/Sun: any time 8AM-10PM ET.
const GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN = [[8 * 60, 22 * 60]];

// ET weekdays that use the wide weekend windows.
const GLOBAL_EVENT_WEEKEND_DAYS = new Set(["Fri", "Sat", "Sun"]);

// Each event lasts 30 minutes.
const GLOBAL_EVENT_DURATION_MS = 30 * 60 * 1000;

// 2x steps during the window.
const GLOBAL_EVENT_MULTIPLIER = 2;

// Catch window: the scheduler runs every 5 minutes, so a tick may land a few
// minutes after the anchor. Start the event if `now` is within this many ms
// AFTER the anchor (and not before it). Kept >= the tick interval so an anchor
// is never missed between ticks.
const GLOBAL_EVENT_CATCH_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Step math
// ---------------------------------------------------------------------------

// Positive per-participant multiplier active at `timeMs`, mirroring the
// positive component of raceStateResolution.js's multiplierForTime:
//   * frozen (LEG_CRAMP, or campfire freeze phase) => 0
//   * else max(RUNNERS_HIGH ? 2 : 1, campfire boost multiplier, 1)
// Wrong Turn's sign is intentionally ignored here: the global event is a
// fair positive boost; it never amplifies the reversal penalty.
function positiveMultiplierForTime(timeMs, effectGroups) {
  const {
    legCramps = [],
    runnersHighs = [],
    campfires = [],
  } = effectGroups || {};

  const isActive = (effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const endMs = effect.expiresAt
      ? new Date(effect.expiresAt).getTime()
      : Infinity;
    return startMs <= timeMs && timeMs < endMs;
  };

  if (legCramps.some(isActive)) return 0;

  const campfireFrozen = campfires.some((effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const freezeMs = (effect.metadata || {}).freezeMs || 0;
    return startMs <= timeMs && timeMs < startMs + freezeMs;
  });
  if (campfireFrozen) return 0;

  const buffed = runnersHighs.some(isActive);

  const campfire = campfires.find((effect) => {
    const startMs = new Date(effect.startsAt).getTime();
    const freezeMs = (effect.metadata || {}).freezeMs || 0;
    const endMs = effect.expiresAt
      ? new Date(effect.expiresAt).getTime()
      : Infinity;
    return startMs <= timeMs && timeMs < endMs && timeMs >= startMs + freezeMs;
  });
  const campfireMultiplier = campfire
    ? (campfire.metadata || {}).multiplier || 1
    : 1;

  return Math.max(buffed ? 2 : 1, campfireMultiplier, 1);
}

// Collect the distinct multiplier-boundary timestamps inside [windowStart,
// windowEnd] so we can slice the window into sub-intervals of constant
// effective multiplier — the same boundary technique determineFinishSnapshot
// uses. Boundaries that fall outside the window are clamped to its edges.
function multiplierBoundaries(windowStart, windowEnd, effectGroups) {
  const bounds = new Set([windowStart, windowEnd]);
  const add = (ms) => {
    if (ms > windowStart && ms < windowEnd) bounds.add(ms);
  };
  const {
    legCramps = [],
    runnersHighs = [],
    campfires = [],
  } = effectGroups || {};

  for (const e of [...legCramps, ...runnersHighs]) {
    add(new Date(e.startsAt).getTime());
    if (e.expiresAt) add(new Date(e.expiresAt).getTime());
  }
  for (const e of campfires) {
    const startMs = new Date(e.startsAt).getTime();
    const freezeMs = (e.metadata || {}).freezeMs || 0;
    add(startMs);
    add(startMs + freezeMs); // freeze -> boost transition
    if (e.expiresAt) add(new Date(e.expiresAt).getTime());
  }

  return [...bounds].sort((a, b) => a - b);
}

// EXTRA steps earned from active global events. For each event window, clipped
// to [startsAt, min(endsAt, now)], we slice it at per-participant multiplier
// boundaries; within each constant-multiplier sub-interval we read the
// participant's steps (sliced by overlap by the step model) and add
//   inWindowSteps * m_p * (multiplier - 1)
// which makes the combined effect m_p * multiplier (multiplicative stacking).
//
// Boundary slicing is handled by stepSampleModel.sumStepsInWindow, which
// prorates a sample by the fraction of its duration inside the sub-interval —
// identical to how per-participant timed effects already slice, so no steps are
// double-counted or dropped at boundaries.
async function computeGlobalEventBoost({
  globalEvents = [],
  effectGroups = {},
  userId,
  stepSampleModel,
  now,
}) {
  if (!globalEvents || globalEvents.length === 0) return 0;
  const nowMs = (now ? new Date(now) : new Date()).getTime();

  let boost = 0;

  for (const event of globalEvents) {
    const multiplier = Number(event.multiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 1) continue;

    const eventStart = new Date(event.startsAt).getTime();
    // Never credit beyond "now": steps after now don't exist yet, and the
    // settlement clock (race end) bounds the window the same way.
    const eventEnd = Math.min(new Date(event.endsAt).getTime(), nowMs);
    if (eventEnd <= eventStart) continue;

    const boundaries = multiplierBoundaries(eventStart, eventEnd, effectGroups);

    for (let i = 0; i < boundaries.length - 1; i++) {
      const segStart = boundaries[i];
      const segEnd = boundaries[i + 1];
      if (segEnd <= segStart) continue;

      const mp = positiveMultiplierForTime(segStart, effectGroups);
      if (mp <= 0) continue; // frozen steps get no boost

      const segSteps = await stepSampleModel.sumStepsInWindow(
        userId,
        new Date(segStart),
        new Date(segEnd)
      );
      if (segSteps > 0) {
        boost += segSteps * mp * (multiplier - 1);
      }
    }
  }

  return boost;
}

// ---------------------------------------------------------------------------
// Scheduler decision
// ---------------------------------------------------------------------------

// Deterministic small integer in [0, mod) from a string seed (FNV-1a). Seeds
// the per-day time draw so every tick (and restart) in a day agrees on the
// chosen start time without persisting anything.
function hashToInt(seed, mod) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % mod;
}

// The event start instant (UTC Date) for the ET calendar day that `date` falls
// in: a wall-clock ET minute drawn uniformly from the day-of-week windows,
// deterministic per ET day. `pickInt(seed, mod)` is injectable so tests can
// force exact draws; production uses the FNV-1a hash.
function chooseEventStartForEtDay(date, pickInt = hashToInt) {
  const parts = getTimeZoneParts(date, ET);
  const windows = GLOBAL_EVENT_WEEKEND_DAYS.has(parts.weekday)
    ? GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN
    : GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN;

  const totalMin = windows.reduce((sum, [a, b]) => sum + (b - a), 0);
  let offset = pickInt(`${etDayKey(date)}:start`, totalMin);

  for (const [a, b] of windows) {
    const len = b - a;
    if (offset < len) {
      const minutes = a + offset;
      return zonedDateTimeToUtc(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: Math.floor(minutes / 60),
          minute: minutes % 60,
        },
        ET
      );
    }
    offset -= len;
  }
  // Unreachable: offset < totalMin by construction.
  throw new Error("global event window draw out of range");
}

// Decide whether a scheduler tick at `now` should start a new event. Returns a
// descriptor { anchorAt, startsAt, endsAt, multiplier } when it should, else
// null. Fires only within the catch window after the day's chosen time (a tick
// that misses the whole window skips the day — never a surprise late event).
// Idempotent: if `todaysEvents` already contains an event whose startsAt
// matches the chosen time (within the catch window), returns null so the same
// day never double-creates across ticks.
function shouldStartGlobalEvent({ now, todaysEvents = [], pickInt }) {
  const nowMs = new Date(now).getTime();
  const start = chooseEventStartForEtDay(now, pickInt);
  const startMs = start.getTime();

  // Fire only AT/AFTER the chosen time, within the catch window.
  if (nowMs < startMs) return null;
  if (nowMs - startMs > GLOBAL_EVENT_CATCH_WINDOW_MS) return null;

  const alreadyStarted = (todaysEvents || []).some((ev) => {
    const evStartMs = new Date(ev.startsAt).getTime();
    return Math.abs(evStartMs - startMs) <= GLOBAL_EVENT_CATCH_WINDOW_MS;
  });
  if (alreadyStarted) return null;

  return {
    anchorAt: new Date(startMs),
    startsAt: new Date(startMs),
    endsAt: new Date(startMs + GLOBAL_EVENT_DURATION_MS),
    multiplier: GLOBAL_EVENT_MULTIPLIER,
  };
}

module.exports = {
  // step math
  computeGlobalEventBoost,
  positiveMultiplierForTime,
  // scheduler
  shouldStartGlobalEvent,
  chooseEventStartForEtDay,
  // constants
  GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN,
  GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
  GLOBAL_EVENT_CATCH_WINDOW_MS,
};
