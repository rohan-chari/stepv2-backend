const {
  MIN_RACE_WINDOW_MS,
} = require("./validateRaceConfig");

// The end instant a race gets stamped with when it flips PENDING -> ACTIVE
// (docs/race-timeline-options-requirements.md §5.4). Extracted as a service so
// it is unit- and integration-testable and reusable by any future start path
// (today: manual start and the autoStartScheduledRaces cron, which share
// commands/startRace.js).
//
// Three branches, in order:
//
//   1. No scheduledEndAt -> fallbackEndsAt. EVERY existing race and every race
//      a frozen client can create takes this branch, so its behavior is
//      byte-for-byte today's `startedAt + maxDurationDays * 24h`.
//
//   2. At least MIN_RACE_WINDOW_MS of the custom window is left -> the custom
//      end. This is the feature.
//
//   3. Otherwise — the race is starting so late that under a day of its custom
//      window remains (or it has already passed) -> fallbackEndsAt. The race
//      runs its full maxDurationDays from the ACTUAL start (Q3). Both paths
//      reach this: the cron re-anchoring startedAt to now past
//      LATE_START_GRACE_MS, and a creator manually tapping START days after the
//      window they picked. scheduledEndAt stays on the row as a record of
//      intent; `endsAt` is the sole authority once stamped, and nothing reads
//      scheduledEndAt after start.
//
// Branch 3 is logged at WARN with the race id and both instants so it is
// visible in prod rather than inferred from a surprising endsAt.
//
// Returns `{ endsAt, honoredCustomEnd }`. The boolean is EXPLICIT rather than
// something the caller re-derives: `endsAt !== fallbackEndsAt` happens to be
// correct today only because branches 1 and 3 return the identical Date
// reference, so any future refactor that cloned the Date would silently switch
// the §5.3a re-derivation on for every legacy race. The caller must never have
// to know that.
function resolveRaceEndsAt({ race, startedAt, fallbackEndsAt, logger = console }) {
  const fallback = { endsAt: fallbackEndsAt, honoredCustomEnd: false };
  const raw = race?.scheduledEndAt;
  if (!raw) return fallback;

  const scheduledEnd = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(scheduledEnd.getTime())) return fallback;

  const remainingMs = scheduledEnd.getTime() - new Date(startedAt).getTime();
  if (remainingMs >= MIN_RACE_WINDOW_MS) {
    return { endsAt: scheduledEnd, honoredCustomEnd: true };
  }

  if (logger && typeof logger.warn === "function") {
    logger.warn(
      "[race-window] custom end too close at start; falling back to duration",
      {
        raceId: race?.id ?? null,
        startedAt: new Date(startedAt).toISOString(),
        scheduledEndAt: scheduledEnd.toISOString(),
        fallbackEndsAt: new Date(fallbackEndsAt).toISOString(),
        remainingMs,
      }
    );
  }
  return fallback;
}

module.exports = { resolveRaceEndsAt };
