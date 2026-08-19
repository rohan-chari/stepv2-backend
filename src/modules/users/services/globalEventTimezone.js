const STABILITY_MS = 48 * 60 * 60 * 1000;

function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

// Returns the smallest write needed for the stable event-timezone state, or
// null for the steady-state hot path. This never mutates users.timezone.
function globalEventTimezoneMutation({ user, observedTimezone, now = new Date() }) {
  if (!user || !isValidIanaTimeZone(observedTimezone)) return null;
  const stable = user.globalEventTimezone || null;
  const candidate = user.globalEventTimezoneCandidate || null;
  const at = new Date(now);

  if (observedTimezone === stable) {
    if (!candidate && !user.globalEventTimezoneCandidateSince) return null;
    return {
      globalEventTimezoneCandidate: null,
      globalEventTimezoneCandidateSince: null,
    };
  }

  if (candidate !== observedTimezone) {
    return {
      globalEventTimezoneCandidate: observedTimezone,
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
    globalEventTimezone: observedTimezone,
    globalEventTimezoneCandidate: null,
    globalEventTimezoneCandidateSince: null,
  };
}

module.exports = {
  STABILITY_MS,
  isValidIanaTimeZone,
  globalEventTimezoneMutation,
};
