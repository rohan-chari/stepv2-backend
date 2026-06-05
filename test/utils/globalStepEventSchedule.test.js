const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Global step-multiplier event — PURE scheduler decision.
//
// `shouldStartGlobalEvent({ now, todaysEvents })` decides whether the 5-minute
// scheduler tick should kick off a new event NOW. Events fire ~3x/day at
// UTC-anchored (jittered) wall-clock times, and the decision is idempotent: if
// an event for the *current anchor* was already created today, it returns
// null (no duplicate), even across many ticks inside the catch window.
//
// Returns the matched anchor descriptor when it SHOULD start, else null.
//
// Written from the spec + the seededRaceRenewal pure-function test pattern,
// NOT by mirroring implementation.
// ---------------------------------------------------------------------------

const {
  shouldStartGlobalEvent,
  GLOBAL_EVENT_ANCHORS_UTC_MIN,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
  computeAnchorTimesForDay,
} = require("../../src/utils/globalStepEvent");

// Helper: build a UTC Date for 2026-06-02 at h:m.
function at(h, m) {
  return new Date(Date.UTC(2026, 5, 2, h, m, 0, 0));
}

test("exposes named tuning constants (1 anchor/day, 30 min, 2x)", () => {
  assert.ok(Array.isArray(GLOBAL_EVENT_ANCHORS_UTC_MIN));
  assert.equal(GLOBAL_EVENT_ANCHORS_UTC_MIN.length, 1, "~1 event per day");
  assert.equal(GLOBAL_EVENT_ANCHORS_UTC_MIN[0], 22 * 60, "anchor at 22:00 UTC");
  assert.equal(GLOBAL_EVENT_DURATION_MS, 30 * 60 * 1000, "30-minute window");
  assert.equal(GLOBAL_EVENT_MULTIPLIER, 2, "2x multiplier");
});

test("computeAnchorTimesForDay returns one jittered Date per anchor on the given UTC day", () => {
  const day = at(0, 0);
  const anchors = computeAnchorTimesForDay(day);
  assert.equal(anchors.length, GLOBAL_EVENT_ANCHORS_UTC_MIN.length);
  for (const a of anchors) {
    assert.ok(a instanceof Date);
    assert.equal(a.getUTCFullYear(), 2026);
    assert.equal(a.getUTCMonth(), 5);
    assert.equal(a.getUTCDate(), 2);
  }
  // Deterministic for a given day (jitter is seeded by the date, not random()).
  const again = computeAnchorTimesForDay(at(12, 0));
  assert.deepEqual(
    anchors.map((d) => d.getTime()),
    again.map((d) => d.getTime()),
    "anchor times must be stable across calls within the same UTC day"
  );
});

test("returns an anchor to start when now is within the catch window of that anchor", () => {
  const anchors = computeAnchorTimesForDay(at(0, 0));
  // Tick exactly at the first anchor time.
  const decision = shouldStartGlobalEvent({
    now: new Date(anchors[0].getTime()),
    todaysEvents: [],
  });
  assert.ok(decision, "should start at the anchor instant");
  assert.equal(decision.anchorAt.getTime(), anchors[0].getTime());
  assert.equal(decision.startsAt.getTime(), new Date(anchors[0]).getTime());
  assert.equal(
    decision.endsAt.getTime(),
    anchors[0].getTime() + GLOBAL_EVENT_DURATION_MS
  );
  assert.equal(decision.multiplier, GLOBAL_EVENT_MULTIPLIER);
});

test("returns null when now is far from every anchor", () => {
  const anchors = computeAnchorTimesForDay(at(0, 0));
  // Pick a time guaranteed to be > catch window away from all anchors: anchor+3h.
  const decision = shouldStartGlobalEvent({
    now: new Date(anchors[0].getTime() + 3 * 60 * 60 * 1000 + 11 * 60 * 1000),
    todaysEvents: [],
  });
  // Only assert null if that instant isn't itself near another anchor; choose a
  // value far from all by testing each candidate. Use a robustly-empty instant:
  // 1 minute before the day's first anchor (anchors are well after 00:01).
  const before = shouldStartGlobalEvent({
    now: new Date(anchors[0].getTime() - 11 * 60 * 1000),
    todaysEvents: [],
  });
  assert.equal(before, null, "no anchor just before the first anchor");
  void decision;
});

test("idempotent: does not re-create for an anchor already started today (across ticks)", () => {
  const anchors = computeAnchorTimesForDay(at(0, 0));
  const anchor = anchors[0];

  // Simulate the event row already created for this anchor.
  const todaysEvents = [
    {
      startsAt: new Date(anchor.getTime()),
      endsAt: new Date(anchor.getTime() + GLOBAL_EVENT_DURATION_MS),
      multiplier: GLOBAL_EVENT_MULTIPLIER,
    },
  ];

  // A later tick still inside the catch window must NOT create a duplicate.
  const decision = shouldStartGlobalEvent({
    now: new Date(anchor.getTime() + 4 * 60 * 1000),
    todaysEvents,
  });
  assert.equal(decision, null, "no duplicate event for an already-started anchor");
});

test("single daily anchor sits near 22:00 UTC; ticks near 09:00/15:00 don't fire", () => {
  const anchors = computeAnchorTimesForDay(at(0, 0));
  assert.equal(anchors.length, 1, "exactly one anchor per day");

  // The lone anchor is 22:00 UTC plus/minus the deterministic jitter.
  const anchorMin = (anchors[0].getTime() - at(0, 0).getTime()) / (60 * 1000);
  assert.ok(
    Math.abs(anchorMin - 22 * 60) <= 7,
    "single anchor is within jitter of 22:00 UTC"
  );

  // Old anchor times (09:00, 15:00) no longer fire an event.
  assert.equal(
    shouldStartGlobalEvent({ now: at(9, 0), todaysEvents: [] }),
    null,
    "no event near the old 09:00 anchor"
  );
  assert.equal(
    shouldStartGlobalEvent({ now: at(15, 0), todaysEvents: [] }),
    null,
    "no event near the old 15:00 anchor"
  );
});
