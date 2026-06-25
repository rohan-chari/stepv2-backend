const assert = require("node:assert/strict");
const test = require("node:test");

const {
  startOfDayNewYork,
  nextMidnightNewYork,
  startOfWeekNewYork,
  nextWeekStartNewYork,
} = require("../../src/utils/week");

const iso = (d) => d.toISOString();

// --- daily, standard time (EST = UTC-5) ---
test("startOfDayNewYork: winter day -> 05:00Z (EST)", () => {
  // 2026-01-15T15:00Z is ET 10:00 EST on Jan 15.
  assert.equal(
    iso(startOfDayNewYork(new Date("2026-01-15T15:00:00Z"))),
    "2026-01-15T05:00:00.000Z"
  );
});

test("nextMidnightNewYork: winter day -> next 05:00Z, 24h span", () => {
  const start = startOfDayNewYork(new Date("2026-01-15T15:00:00Z"));
  const end = nextMidnightNewYork(new Date("2026-01-15T15:00:00Z"));
  assert.equal(iso(end), "2026-01-16T05:00:00.000Z");
  assert.equal((end - start) / 3600000, 24);
});

// --- daily, daylight time (EDT = UTC-4) ---
test("startOfDayNewYork: summer day -> 04:00Z (EDT)", () => {
  assert.equal(
    iso(startOfDayNewYork(new Date("2026-06-25T15:00:00Z"))),
    "2026-06-25T04:00:00.000Z"
  );
});

// --- DST spring-forward: 2026-03-08 is a 23h ET day ---
test("daily race on spring-forward day is exactly 23 hours", () => {
  const d = new Date("2026-03-08T12:00:00Z"); // ET 2026-03-08
  const start = startOfDayNewYork(d);
  const end = nextMidnightNewYork(d);
  assert.equal(iso(start), "2026-03-08T05:00:00.000Z"); // 00:00 EST
  assert.equal(iso(end), "2026-03-09T04:00:00.000Z"); // 00:00 EDT
  assert.equal((end - start) / 3600000, 23);
});

// --- DST fall-back: 2026-11-01 is a 25h ET day ---
test("daily race on fall-back day is exactly 25 hours", () => {
  const d = new Date("2026-11-01T12:00:00Z"); // ET 2026-11-01
  const start = startOfDayNewYork(d);
  const end = nextMidnightNewYork(d);
  assert.equal(iso(start), "2026-11-01T04:00:00.000Z"); // 00:00 EDT
  assert.equal(iso(end), "2026-11-02T05:00:00.000Z"); // 00:00 EST
  assert.equal((end - start) / 3600000, 25);
});

// --- midnight is well-defined across month/year rollover ---
test("nextMidnightNewYork rolls over month/year boundaries", () => {
  assert.equal(
    iso(nextMidnightNewYork(new Date("2026-12-31T18:00:00Z"))),
    "2027-01-01T05:00:00.000Z"
  );
});

// --- weekly (Monday 00:00 ET) ---
test("startOfWeekNewYork: Monday 00:00 ET for a mid-week summer date", () => {
  // 2026-06-22 is a Monday; the week runs Mon 22 .. Sun 28.
  assert.equal(
    iso(startOfWeekNewYork(new Date("2026-06-25T15:00:00Z"))), // Thursday
    "2026-06-22T04:00:00.000Z"
  );
});

test("nextWeekStartNewYork: following Monday 00:00 ET, 7 local days later", () => {
  assert.equal(
    iso(nextWeekStartNewYork(new Date("2026-06-25T15:00:00Z"))),
    "2026-06-29T04:00:00.000Z"
  );
});

test("startOfWeekNewYork: winter week uses EST offset", () => {
  // 2026-01-12 is a Monday; 2026-01-15 is that week's Thursday.
  assert.equal(
    iso(startOfWeekNewYork(new Date("2026-01-15T15:00:00Z"))),
    "2026-01-12T05:00:00.000Z"
  );
});
