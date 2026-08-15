const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDateTimeFormat,
  getTimeZoneParts,
  zonedDateTimeToUtc,
  startOfDayNewYork,
  nextMidnightNewYork,
} = require("../../src/shared/time/week");

const iso = (d) => d.toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// The cache itself.
// ─────────────────────────────────────────────────────────────────────────────

test("getDateTimeFormat returns the SAME instance for identical args", () => {
  const first = getDateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const second = getDateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  });
  assert.equal(first, second, "identical (locale, options) must be memoized");
});

test("getDateTimeFormat key is order-insensitive over option entries", () => {
  // Same pairs, different literal order. A JSON.stringify key over an
  // unsorted object would miss this and construct a second formatter.
  const a = getDateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  });
  const b = getDateTimeFormat("en-US", {
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
  assert.equal(a, b);
});

test("getDateTimeFormat does NOT share across different zones", () => {
  const ny = getDateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit" });
  const la = getDateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit" });
  assert.notEqual(ny, la);
});

test("getDateTimeFormat does NOT share across different option sets", () => {
  const withSeconds = getDateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    second: "2-digit",
  });
  const withoutSeconds = getDateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
  });
  assert.notEqual(withSeconds, withoutSeconds);
});

test("getDateTimeFormat does NOT share across different locales", () => {
  const us = getDateTimeFormat("en-US", { timeZone: "America/New_York", month: "long" });
  const ca = getDateTimeFormat("en-CA", { timeZone: "America/New_York", month: "long" });
  assert.notEqual(us, ca);
});

// ─────────────────────────────────────────────────────────────────────────────
// DST correctness THROUGH a shared instance.
//
// These are the regression tests that matter: a DateTimeFormat is a function of
// the ZONE, not of the instant, so one cached instance must format instants on
// BOTH sides of a DST transition correctly. If someone ever "optimizes" the key
// (e.g. by dropping the zone, or by caching a computed offset alongside the
// formatter), these fail.
// ─────────────────────────────────────────────────────────────────────────────

test("one memoized formatter is correct on BOTH sides of NY spring-forward", () => {
  // Spring forward 2026: 02:00 EST -> 03:00 EDT on Sun 2026-03-08.
  const before = getTimeZoneParts(new Date("2026-03-08T06:30:00Z"), "America/New_York");
  const after = getTimeZoneParts(new Date("2026-03-08T07:30:00Z"), "America/New_York");

  // Same formatter instance served both of the calls above.
  assert.equal(
    getDateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    getDateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
  );

  // 06:30Z is 01:30 EST (UTC-5) — still standard time.
  assert.equal(before.hour, 1);
  assert.equal(before.minute, 30);
  assert.equal(before.day, 8);
  // 07:30Z is 03:30 EDT (UTC-4) — the 02:00 hour does not exist.
  assert.equal(after.hour, 3);
  assert.equal(after.minute, 30);
  assert.equal(after.day, 8);
});

test("one memoized formatter is correct on BOTH sides of NY fall-back", () => {
  // Fall back 2026: 02:00 EDT -> 01:00 EST on Sun 2026-11-01.
  // 05:30Z is 01:30 EDT (UTC-4); 06:30Z is 01:30 EST (UTC-5) — the repeated hour.
  const firstOne = getTimeZoneParts(new Date("2026-11-01T05:30:00Z"), "America/New_York");
  const secondOne = getTimeZoneParts(new Date("2026-11-01T06:30:00Z"), "America/New_York");

  assert.equal(firstOne.hour, 1);
  assert.equal(firstOne.minute, 30);
  assert.equal(secondOne.hour, 1);
  assert.equal(secondOne.minute, 30);
  assert.equal(firstOne.day, 1);
  assert.equal(secondOne.day, 1);
});

test("shared offset formatter reports the correct offset on both DST sides", () => {
  // zonedDateTimeToUtc builds two offset lookups per call through the SAME
  // cached shortOffset formatter. EST midnight -> 05:00Z, EDT midnight -> 04:00Z.
  assert.equal(
    iso(zonedDateTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 0, minute: 0 },
      "America/New_York"
    )),
    "2026-01-15T05:00:00.000Z"
  );
  assert.equal(
    iso(zonedDateTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 0, minute: 0 },
      "America/New_York"
    )),
    "2026-07-15T04:00:00.000Z"
  );
});

test("a daily race spanning spring-forward is 23h through cached formatters", () => {
  const at = new Date("2026-03-08T12:00:00Z"); // ET 07:00 EDT on Mar 8
  const start = startOfDayNewYork(at);
  const end = nextMidnightNewYork(at);
  assert.equal(iso(start), "2026-03-08T05:00:00.000Z");
  // Mar 9 midnight is already EDT (UTC-4).
  assert.equal(iso(end), "2026-03-09T04:00:00.000Z");
  // Mar 8 is the 23-hour day: 00:00 EST -> 00:00 EDT.
  assert.equal((end - start) / 3_600_000, 24 - 1);
});

test("a daily race spanning fall-back is 25h through cached formatters", () => {
  const at = new Date("2026-11-01T12:00:00Z"); // ET 07:00 EST on Nov 1
  const start = startOfDayNewYork(at);
  const end = nextMidnightNewYork(at);
  assert.equal(iso(start), "2026-11-01T04:00:00.000Z");
  assert.equal(iso(end), "2026-11-02T05:00:00.000Z");
  assert.equal((end - start) / 3_600_000, 24 + 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Half-hour offset zone. India is UTC+5:30 with NO DST — the offset PARSER
// (parseOffsetMinutes) must survive "GMT+5:30" through a memoized formatter.
// ─────────────────────────────────────────────────────────────────────────────

test("Asia/Kolkata half-hour offset is correct through the cached formatter", () => {
  assert.equal(
    iso(zonedDateTimeToUtc(
      { year: 2026, month: 1, day: 15, hour: 0, minute: 0 },
      "Asia/Kolkata"
    )),
    "2026-01-14T18:30:00.000Z"
  );
  // No DST in India: July resolves to the SAME offset.
  assert.equal(
    iso(zonedDateTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 0, minute: 0 },
      "Asia/Kolkata"
    )),
    "2026-07-14T18:30:00.000Z"
  );
});

test("Asia/Kolkata wall-clock parts are correct through the cached formatter", () => {
  // 2026-01-15T18:45:00Z is 2026-01-16 00:15 IST — a DATE rollover that a
  // whole-hour-only offset would get wrong.
  const parts = getTimeZoneParts(new Date("2026-01-15T18:45:00Z"), "Asia/Kolkata");
  assert.equal(parts.year, 2026);
  assert.equal(parts.month, 1);
  assert.equal(parts.day, 16);
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 15);
});

test("Kolkata and New York do not contaminate each other's cached formatter", () => {
  const instant = new Date("2026-01-15T18:45:00Z");
  // Interleave, so a shared/overwritten cache entry would be caught.
  const kolkataFirst = getTimeZoneParts(instant, "Asia/Kolkata");
  const newYork = getTimeZoneParts(instant, "America/New_York");
  const kolkataAgain = getTimeZoneParts(instant, "Asia/Kolkata");

  assert.equal(newYork.day, 15);
  assert.equal(newYork.hour, 13); // 13:45 EST
  assert.deepEqual(kolkataAgain, kolkataFirst);
  assert.equal(kolkataAgain.day, 16);
  assert.equal(kolkataAgain.hour, 0);
});

test("repeated calls stay stable — memoized formatters are not consumed", () => {
  const instant = new Date("2026-06-01T16:20:00Z");
  const first = getTimeZoneParts(instant, "America/New_York");
  for (let i = 0; i < 50; i += 1) {
    assert.deepEqual(getTimeZoneParts(instant, "America/New_York"), first);
  }
});
