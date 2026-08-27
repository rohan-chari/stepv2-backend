const STABILITY_MS = 48 * 60 * 60 * 1000;

function isValidIanaTimeZone(timeZone) {
  return canonicalIanaTimeZone(timeZone) !== null;
}

function canonicalIanaTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// Returns the smallest write needed for the stable event-timezone state, or
// null for the steady-state hot path. This never mutates users.timezone.
function globalEventTimezoneMutation({ user, observedTimezone, now = new Date() }) {
  const observed = canonicalIanaTimeZone(observedTimezone);
  if (!user || !observed) return null;
  const stable = canonicalIanaTimeZone(user.globalEventTimezone);
  const candidate = canonicalIanaTimeZone(user.globalEventTimezoneCandidate);
  const at = new Date(now);

  if (observed === stable) {
    if (user.globalEventTimezone !== observed) {
      return {
        globalEventTimezone: observed,
        globalEventTimezoneCandidate: null,
        globalEventTimezoneCandidateSince: null,
      };
    }
    if (!candidate && !user.globalEventTimezoneCandidateSince) return null;
    return {
      globalEventTimezoneCandidate: null,
      globalEventTimezoneCandidateSince: null,
    };
  }

  if (candidate !== observed) {
    return {
      globalEventTimezoneCandidate: observed,
      globalEventTimezoneCandidateSince: at,
    };
  }

  const since = user.globalEventTimezoneCandidateSince
    ? new Date(user.globalEventTimezoneCandidateSince)
    : null;
  if (!since || Number.isNaN(since.getTime())) {
    return { globalEventTimezoneCandidateSince: at };
  }
  if (at.getTime() - since.getTime() < STABILITY_MS) return null;
  return {
    globalEventTimezone: observed,
    globalEventTimezoneCandidate: null,
    globalEventTimezoneCandidateSince: null,
  };
}

module.exports = {
  STABILITY_MS,
  canonicalIanaTimeZone,
  isValidIanaTimeZone,
  globalEventTimezoneMutation,
};
