const test = require("node:test");
const assert = require("node:assert/strict");

const { prorateSamplesIntoWindow } = require("../../src/models/stepSample");

// Guards the sumStepsInWindow -> sumStepsInWindows refactor: summing each
// window against a SUPERSET fetch (all samples spanning every window) must
// equal summing against a per-window fetch, because the overlap check drops
// samples outside the window. If this ever breaks, batched day sums in
// calculateSubsequentSteps would diverge from the legacy per-day queries.

function sample(startIso, endIso, steps) {
  return { start: new Date(startIso), end: new Date(endIso), steps };
}

const SAMPLES = [
  sample("2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z", 500),
  sample("2026-07-01T23:30:00Z", "2026-07-02T00:30:00Z", 600), // straddles midnight
  sample("2026-07-02T12:00:00Z", "2026-07-02T13:00:00Z", 1200),
  sample("2026-07-03T05:00:00Z", "2026-07-03T05:00:00Z", 999), // zero-duration, ignored
  sample("2026-07-04T10:00:00Z", "2026-07-04T11:00:00Z", 800), // outside all windows below
];

const WINDOWS = [
  ["2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"],
  ["2026-07-02T00:00:00Z", "2026-07-03T00:00:00Z"],
  ["2026-07-03T00:00:00Z", "2026-07-04T00:00:00Z"],
];

test("prorating a superset fetch per window matches per-window fetches", () => {
  for (const [start, end] of WINDOWS) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();

    // Per-window fetch: only samples overlapping this window (periodEnd > start,
    // periodStart < end), mirroring the SQL predicate.
    const perWindowFetch = SAMPLES.filter(
      (s) => s.end.getTime() > startMs && s.start.getTime() < endMs
    );

    assert.equal(
      prorateSamplesIntoWindow(SAMPLES, startMs, endMs),
      prorateSamplesIntoWindow(perWindowFetch, startMs, endMs)
    );
  }
});

test("straddling sample splits proportionally across adjacent windows", () => {
  const day1 = prorateSamplesIntoWindow(
    SAMPLES,
    Date.parse("2026-07-01T00:00:00Z"),
    Date.parse("2026-07-02T00:00:00Z")
  );
  const day2 = prorateSamplesIntoWindow(
    SAMPLES,
    Date.parse("2026-07-02T00:00:00Z"),
    Date.parse("2026-07-03T00:00:00Z")
  );

  // Day 1: full 500 + half of the straddling 600.
  assert.equal(day1, 500 + 300);
  // Day 2: other half of the straddler + full 1200.
  assert.equal(day2, 300 + 1200);
});
