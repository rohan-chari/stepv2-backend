const assert = require("node:assert/strict");
const test = require("node:test");

// ---------------------------------------------------------------------------
// Global step-multiplier event — PURE scheduler decision.
//
// The daily event fires at a randomized ET wall-clock time drawn from a
// day-of-week window:
//   * Mon–Thu: off-work hours only — [08:00–10:00) ∪ [16:00–21:00) ET
//   * Fri/Sat/Sun: [08:00–22:00) ET
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
  GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN,
  GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN,
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

const WEEKDAY_TOTAL_MIN = GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN.reduce(
  (sum, [a, b]) => sum + (b - a),
  0
);
const WEEKEND_TOTAL_MIN = GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN.reduce(
  (sum, [a, b]) => sum + (b - a),
  0
);

test("tuning constants: 30-min window, 2x, and the agreed ET windows", () => {
  assert.equal(GLOBAL_EVENT_DURATION_MS, 30 * 60 * 1000, "30-minute window");
  assert.equal(GLOBAL_EVENT_MULTIPLIER, 2, "2x multiplier");
  // Mon–Thu: 8–10AM and 4–9PM ET.
  assert.deepEqual(GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN, [
    [8 * 60, 10 * 60],
    [16 * 60, 21 * 60],
  ]);
  // Fri/Sat/Sun: 8AM–10PM ET.
  assert.deepEqual(GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN, [[8 * 60, 22 * 60]]);
});

test("weekday picks stay in off-work windows for EVERY possible draw", () => {
  const monday = etNoonOf(2026, 6, 8); // Mon 2026-06-08
  for (let draw = 0; draw < WEEKDAY_TOTAL_MIN; draw++) {
    const start = chooseEventStartForEtDay(monday, () => draw);
    const min = etMinutes(start);
    assert.ok(
      inWindows(min, GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN),
      `draw ${draw} landed at ET minute ${min} — outside 8-10AM/4-9PM`
    );
  }
});

test("weekday window boundaries are exact (no work-hours leakage)", () => {
  const tuesday = etNoonOf(2026, 6, 9); // Tue 2026-06-09
  // First draw of the day => 08:00 ET sharp.
  assert.equal(etMinutes(chooseEventStartForEtDay(tuesday, () => 0)), 8 * 60);
  // The first draw past the morning window jumps the 10AM-4PM gap to 16:00 ET.
  assert.equal(
    etMinutes(chooseEventStartForEtDay(tuesday, () => 120)),
    16 * 60,
    "draw after the 2h morning window must map to 4PM, not 10AM-4PM"
  );
  // The last draw stays strictly before 9PM ET.
  assert.equal(
    etMinutes(chooseEventStartForEtDay(tuesday, () => WEEKDAY_TOTAL_MIN - 1)),
    21 * 60 - 1
  );
});

test("Friday and the weekend use the wide 8AM-10PM window and CAN land midday", () => {
  for (const [y, m, d] of [
    [2026, 6, 5], // Fri
    [2026, 6, 6], // Sat
    [2026, 6, 7], // Sun
  ]) {
    const day = etNoonOf(y, m, d);
    // Midday draw (13:00 ET = offset 300) is allowed on Fri-Sun — this is what
    // distinguishes the weekend from the weekday work-hours exclusion.
    const midday = chooseEventStartForEtDay(day, () => 300);
    assert.equal(etMinutes(midday), 13 * 60, `${y}-${m}-${d} midday draw`);
    // Bounds.
    assert.equal(etMinutes(chooseEventStartForEtDay(day, () => 0)), 8 * 60);
    assert.equal(
      etMinutes(chooseEventStartForEtDay(day, () => WEEKEND_TOTAL_MIN - 1)),
      22 * 60 - 1
    );
  }
});

test("real hash: 120 consecutive days all land inside their day-of-week windows", () => {
  const WEEKEND_DAYS = new Set(["Fri", "Sat", "Sun"]);
  for (let i = 0; i < 120; i++) {
    const day = new Date(etNoonOf(2026, 1, 1).getTime() + i * 24 * 60 * 60 * 1000);
    const start = chooseEventStartForEtDay(day);
    const windows = WEEKEND_DAYS.has(getTimeZoneParts(start, ET).weekday)
      ? GLOBAL_EVENT_WEEKEND_WINDOWS_ET_MIN
      : GLOBAL_EVENT_WEEKDAY_WINDOWS_ET_MIN;
    const min = etMinutes(start);
    assert.ok(
      inWindows(min, windows),
      `${start.toISOString()} (ET minute ${min}) outside its windows`
    );
    // The chosen start is on the same ET day it was derived from.
    assert.equal(
      getTimeZoneParts(start, ET).day,
      getTimeZoneParts(day, ET).day
    );
  }
});

test("day-of-week is computed in ET, not UTC", () => {
  // Fri 2026-06-05 02:00 UTC is still Thursday 22:00 ET — the THURSDAY
  // (weekday) windows must apply, anchored to the Thursday ET date.
  const lateThursdayEt = new Date("2026-06-05T02:00:00Z");
  const start = chooseEventStartForEtDay(lateThursdayEt, () => 0);
  const parts = getTimeZoneParts(start, ET);
  assert.equal(parts.weekday, "Thu");
  assert.equal(parts.day, 4, "anchored to Thu 2026-06-04 ET");
  assert.equal(parts.hour, 8);
});

test("DST correctness: the same ET wall-clock pick maps to different UTC instants in EST vs EDT", () => {
  // Draw 120 => 16:00 ET on a weekday (first minute of the evening window).
  const edtDay = etNoonOf(2026, 6, 9); // Tue in June (EDT, UTC-4)
  const estDay = etNoonOf(2026, 1, 15); // Thu in January (EST, UTC-5)

  const edtStart = chooseEventStartForEtDay(edtDay, () => 120);
  const estStart = chooseEventStartForEtDay(estDay, () => 120);

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
