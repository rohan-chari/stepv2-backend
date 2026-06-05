// Global step-multiplier event ("BeReal-style" 2x event).
//
// This module holds the PURE, testable pieces of the feature:
//   1. computeGlobalEventBoost  — the step math (how many EXTRA steps a
//      participant earns because their samples overlapped an active event
//      window), stacking MULTIPLICATIVELY with the per-participant timed
//      multipliers the resolution already understands.
//   2. shouldStartGlobalEvent / computeAnchorTimesForDay — the scheduler
//      decision (whether a 5-minute tick should create a new event now),
//      with UTC-anchored, deterministically-jittered anchors and idempotency.
//
// Everything is dependency-injected (no DB calls inside the math) so both
// getRaceProgress (display) and raceExpiry (settlement) can compute identical
// totals by passing in the same active events.

// ---------------------------------------------------------------------------
// Tuning constants — change these to tune frequency/shape of events.
// ---------------------------------------------------------------------------

// 1 event per day. Each value is "minutes after UTC midnight" for the
// nominal (pre-jitter) anchor.
const GLOBAL_EVENT_ANCHORS_UTC_MIN = [
  22 * 60, // 22:00 UTC (6 PM ET)
];

// Each event lasts 30 minutes.
const GLOBAL_EVENT_DURATION_MS = 30 * 60 * 1000;

// 2x steps during the window.
const GLOBAL_EVENT_MULTIPLIER = 2;

// Jitter: each anchor is nudged by up to ±JITTER minutes, deterministically
// derived from the UTC date + anchor index so EVERY race worldwide sees the
// event at the exact same instant (fair) and the value is stable across the
// many 5-minute ticks within a day (so idempotency works).
const GLOBAL_EVENT_JITTER_MIN = 7;

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

// Deterministic small integer in [0, mod) from a string seed (FNV-1a). Used to
// derive a stable per-day jitter so anchors don't move between ticks.
function hashToInt(seed, mod) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % mod;
}

function utcDayKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

// The jittered anchor Date objects for the UTC day that `date` falls in. Stable
// for a given UTC day (jitter seeded by the date + anchor index, not random()).
function computeAnchorTimesForDay(date) {
  const d = new Date(date);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayKey = utcDayKey(date);
  const jitterSpan = GLOBAL_EVENT_JITTER_MIN * 2 + 1; // [-J, +J]

  return GLOBAL_EVENT_ANCHORS_UTC_MIN.map((anchorMin, index) => {
    const jitter =
      hashToInt(`${dayKey}:${index}`, jitterSpan) - GLOBAL_EVENT_JITTER_MIN;
    const minutes = anchorMin + jitter;
    return new Date(dayStart + minutes * 60 * 1000);
  });
}

// Decide whether a scheduler tick at `now` should start a new event. Returns a
// descriptor { anchorAt, startsAt, endsAt, multiplier } when it should, else
// null. Idempotent: if `todaysEvents` already contains an event whose startsAt
// matches the current anchor (within the catch window), returns null so the
// same anchor never double-creates across ticks.
function shouldStartGlobalEvent({ now, todaysEvents = [] }) {
  const nowMs = new Date(now).getTime();
  const anchors = computeAnchorTimesForDay(now);

  for (const anchor of anchors) {
    const anchorMs = anchor.getTime();
    // Fire only AT/AFTER the anchor, within the catch window.
    if (nowMs < anchorMs) continue;
    if (nowMs - anchorMs > GLOBAL_EVENT_CATCH_WINDOW_MS) continue;

    // Idempotency: skip if an event for this anchor already exists today. We
    // match on startsAt being within the catch window of the anchor.
    const alreadyStarted = (todaysEvents || []).some((ev) => {
      const startMs = new Date(ev.startsAt).getTime();
      return Math.abs(startMs - anchorMs) <= GLOBAL_EVENT_CATCH_WINDOW_MS;
    });
    if (alreadyStarted) continue;

    const startsAt = new Date(anchorMs);
    return {
      anchorAt: new Date(anchorMs),
      startsAt,
      endsAt: new Date(anchorMs + GLOBAL_EVENT_DURATION_MS),
      multiplier: GLOBAL_EVENT_MULTIPLIER,
    };
  }

  return null;
}

module.exports = {
  // step math
  computeGlobalEventBoost,
  positiveMultiplierForTime,
  // scheduler
  shouldStartGlobalEvent,
  computeAnchorTimesForDay,
  // constants
  GLOBAL_EVENT_ANCHORS_UTC_MIN,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
  GLOBAL_EVENT_JITTER_MIN,
  GLOBAL_EVENT_CATCH_WINDOW_MS,
};
