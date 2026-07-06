const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Global step-multiplier event — PURE scheduler decision.
//
// The daily event fires at a randomized ET wall-clock time drawn from ONE
// window used every day of the week: [08:00–22:00) ET.
// The pick is deterministic per ET day (hash-seeded, like the old jitter) so
// it is stable across 5-minute ticks and process restarts without persistence,
// and `shouldStartGlobalEvent` stays idempotent via todaysEvents.
//
// Written from the spec, not by mirroring implementation.
// ---------------------------------------------------------------------------

const {
  shouldStartGlobalEvent,
  chooseEventStartForEtDay,
  GLOBAL_EVENT_DURATION_MS,
  GLOBAL_EVENT_MULTIPLIER,
  GLOBAL_EVENT_CATCH_WINDOW_MS,
  GLOBAL_EVENT_WINDOWS_ET_MIN,
} = require("../../src/utils/globalStepEvent");
const { getTimeZoneParts, zonedDateTimeToUtc } = require("../../src/utils/week");

const ET = "America/New_York";

// Minutes-after-ET-midnight of `date`'s ET wall-clock time.
function etMinutes(date) {
  const parts = getTimeZoneParts(date, ET);
  return parts.hour * 60 + parts.minute;
}

function inWindows(min, windows) {
  return windows.some(([a, b]) => min >= a && min < b);
}

// An instant inside a specific ET calendar day (noon ET, DST-safe).
function etNoonOf(year, month, day) {
  return zonedDateTimeToUtc({ year, month, day, hour: 12, minute: 0 }, ET);
}

const TOTAL_MIN = GLOBAL_EVENT_WINDOWS_ET_MIN.reduce(
  (sum, [a, b]) => sum + (b - a),
  0
);

test("tuning constants: 30-min window, 2x, and 8AM-10PM ET every day", () => {
  assert.equal(GLOBAL_EVENT_DURATION_MS, 30 * 60 * 1000, "30-minute window");
  assert.equal(GLOBAL_EVENT_MULTIPLIER, 2, "2x multiplier");
  // Every day of the week: 8AM–10PM ET, one window, no weekday/weekend split.
  assert.deepEqual(GLOBAL_EVENT_WINDOWS_ET_MIN, [[8 * 60, 22 * 60]]);
});

test("every day of the week uses the same 8AM-10PM window for EVERY possible draw", () => {
  // Mon 2026-06-08 .. Sun 2026-06-14 — one full week.
  for (let d = 8; d <= 14; d++) {
    const day = etNoonOf(2026, 6, d);
    const weekday = getTimeZoneParts(day, ET).weekday;
    // Bounds: first draw = 08:00 sharp, last draw = 21:59.
    assert.equal(
      etMinutes(chooseEventStartForEtDay(day, () => 0)),
      8 * 60,
      `${weekday}: first draw must be 8AM ET`
    );
    assert.equal(
      etMinutes(chooseEventStartForEtDay(day, () => TOTAL_MIN - 1)),
      22 * 60 - 1,
      `${weekday}: last draw must be 9:59PM ET`
    );
    // Midday draw (13:00 ET = offset 300) is allowed EVERY day — weekdays no
    // longer exclude work hours.
    assert.equal(
      etMinutes(chooseEventStartForEtDay(day, () => 300)),
      13 * 60,
      `${weekday}: midday draw must be allowed`
    );
  }
});

test("weekday draws sweep the full 8AM-10PM range contiguously (no gaps)", () => {
  const monday = etNoonOf(2026, 6, 8); // Mon 2026-06-08
  for (let draw = 0; draw < TOTAL_MIN; draw++) {
    const start = chooseEventStartForEtDay(monday, () => draw);
    const min = etMinutes(start);
    assert.equal(
      min,
      8 * 60 + draw,
      `draw ${draw} must map to ET minute ${8 * 60 + draw} (contiguous window)`
    );
    assert.ok(inWindows(min, GLOBAL_EVENT_WINDOWS_ET_MIN));
  }
});

test("real hash: 120 consecutive days all land inside 8AM-10PM ET", () => {
  for (let i = 0; i < 120; i++) {
    const day = new Date(etNoonOf(2026, 1, 1).getTime() + i * 24 * 60 * 60 * 1000);
    const start = chooseEventStartForEtDay(day);
    const min = etMinutes(start);
    assert.ok(
      inWindows(min, GLOBAL_EVENT_WINDOWS_ET_MIN),
      `${start.toISOString()} (ET minute ${min}) outside 8AM-10PM ET`
    );
    // The chosen start is on the same ET day it was derived from.
    assert.equal(
      getTimeZoneParts(start, ET).day,
      getTimeZoneParts(day, ET).day
    );
  }
});

test("day anchoring is computed in ET, not UTC", () => {
  // Fri 2026-06-05 02:00 UTC is still Thursday 22:00 ET — the pick must be
  // anchored to the Thursday ET date.
  const lateThursdayEt = new Date("2026-06-05T02:00:00Z");
  const start = chooseEventStartForEtDay(lateThursdayEt, () => 0);
  const parts = getTimeZoneParts(start, ET);
  assert.equal(parts.weekday, "Thu");
  assert.equal(parts.day, 4, "anchored to Thu 2026-06-04 ET");
  assert.equal(parts.hour, 8);
});

test("DST correctness: the same ET wall-clock pick maps to different UTC instants in EST vs EDT", () => {
  // Draw 480 => 16:00 ET (8h past the 8AM window start).
  const edtDay = etNoonOf(2026, 6, 9); // Tue in June (EDT, UTC-4)
  const estDay = etNoonOf(2026, 1, 15); // Thu in January (EST, UTC-5)

  const edtStart = chooseEventStartForEtDay(edtDay, () => 480);
  const estStart = chooseEventStartForEtDay(estDay, () => 480);

  // Round-trips to 4PM ET on both sides of DST...
  assert.equal(getTimeZoneParts(edtStart, ET).hour, 16);
  assert.equal(getTimeZoneParts(estStart, ET).hour, 16);
  // ...which means DIFFERENT UTC hours (this is the old 22:00-UTC drift bug).
  assert.equal(edtStart.getUTCHours(), 20, "4PM EDT = 20:00 UTC");
  assert.equal(estStart.getUTCHours(), 21, "4PM EST = 21:00 UTC");
});

test("deterministic per ET day: every tick of the day agrees on the start time", () => {
  const day = etNoonOf(2026, 6, 8);
  const first = chooseEventStartForEtDay(day);
  for (const offsetH of [-11, -6, 0, 5, 11]) {
    const tick = new Date(day.getTime() + offsetH * 60 * 60 * 1000);
    // Stay within the same ET day (noon ± 11h) — every tick must agree.
    assert.equal(
      chooseEventStartForEtDay(tick).getTime(),
      first.getTime(),
      `tick at noon${offsetH >= 0 ? "+" : ""}${offsetH}h disagreed`
    );
  }
});

test("fires at the chosen time, self-heals within the catch window, and skips after it", () => {
  const day = etNoonOf(2026, 6, 8);
  const start = chooseEventStartForEtDay(day);

  // Exactly at the chosen instant.
  const atStart = shouldStartGlobalEvent({ now: start, todaysEvents: [] });
  assert.ok(atStart, "fires at the chosen instant");
  assert.equal(atStart.startsAt.getTime(), start.getTime());
  assert.equal(
    atStart.endsAt.getTime(),
    start.getTime() + GLOBAL_EVENT_DURATION_MS
  );
  assert.equal(atStart.multiplier, GLOBAL_EVENT_MULTIPLIER);

  // 8 minutes late (restart / missed boundary) — still inside the catch window.
  const late = shouldStartGlobalEvent({
    now: new Date(start.getTime() + 8 * 60 * 1000),
    todaysEvents: [],
  });
  assert.ok(late, "self-heals within the catch window");

  // Before the chosen time: nothing.
  assert.equal(
    shouldStartGlobalEvent({
      now: new Date(start.getTime() - 60 * 1000),
      todaysEvents: [],
    }),
    null
  );

  // Way past the catch window: the day's event is SKIPPED, not fired late.
  assert.equal(
    shouldStartGlobalEvent({
      now: new Date(start.getTime() + GLOBAL_EVENT_CATCH_WINDOW_MS + 60 * 1000),
      todaysEvents: [],
    }),
    null,
    "a missed catch window skips the day (no surprise late-night event)"
  );
});

test("idempotent: an event already created for the chosen time blocks re-creation across ticks", () => {
  const day = etNoonOf(2026, 6, 8);
  const start = chooseEventStartForEtDay(day);
  const todaysEvents = [
    {
      startsAt: new Date(start.getTime()),
      endsAt: new Date(start.getTime() + GLOBAL_EVENT_DURATION_MS),
      multiplier: GLOBAL_EVENT_MULTIPLIER,
    },
  ];

  const decision = shouldStartGlobalEvent({
    now: new Date(start.getTime() + 4 * 60 * 1000),
    todaysEvents,
  });
  assert.equal(decision, null, "no duplicate for an already-started day");
});
