const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  resolveRaceEndsAt,
} = require("../../src/modules/races/services/resolveRaceEndsAt");
const {
  durationDaysFromWindow,
  MIN_RACE_WINDOW_MS,
} = require("../../src/modules/races/services/validateRaceConfig");

// Custom race windows — the two pure functions
// (docs/race-timeline-options-requirements.md §9 tests 11 and 12).
//
// UNIT, not integration, on purpose: both are exhaustive truth/boundary tables
// over injected instants. Branch 3 of resolveRaceEndsAt in particular needs a
// start that is DAYS after a stored end, which an integration test can only
// reach by fabricating the row it is supposed to be proving. The behavior these
// pin is separately proved end-to-end through real HTTP in
// test/integration/race-timeline-options.test.js (tests 2, 9b, 10b).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const silentLogger = { warn() {} };

describe("resolveRaceEndsAt — truth table (§5.4, test 11)", () => {
  const startedAt = new Date("2026-08-16T12:00:00.000Z");
  const fallbackEndsAt = new Date(startedAt.getTime() + 7 * DAY);

  it("branch 1: no scheduledEndAt -> the duration-derived end (today's behavior)", () => {
    for (const scheduledEndAt of [null, undefined]) {
      const result = resolveRaceEndsAt({
        race: { id: "r1", scheduledEndAt },
        startedAt,
        fallbackEndsAt,
        logger: silentLogger,
      });
      assert.equal(result.endsAt, fallbackEndsAt);
      assert.equal(
        result.honoredCustomEnd,
        false,
        "a legacy race must NEVER trip the re-derivation"
      );
    }
  });

  it("branch 1: an unparseable stored value also falls back, never throws", () => {
    const result = resolveRaceEndsAt({
      race: { id: "r1", scheduledEndAt: "not a date" },
      startedAt,
      fallbackEndsAt,
      logger: silentLogger,
    });
    assert.equal(result.endsAt, fallbackEndsAt);
    assert.equal(result.honoredCustomEnd, false);
  });

  it("branch 2: at least MIN_RACE_WINDOW_MS left -> the custom end", () => {
    const custom = new Date(startedAt.getTime() + 4 * DAY + 9 * HOUR);
    const result = resolveRaceEndsAt({
      race: { id: "r2", scheduledEndAt: custom },
      startedAt,
      fallbackEndsAt,
      logger: silentLogger,
    });
    assert.equal(result.endsAt.getTime(), custom.getTime());
    assert.equal(result.honoredCustomEnd, true);
  });

  it("honoredCustomEnd is reported EXPLICITLY, not inferable from Date identity", () => {
    // The caller must not have to compare the returned Date against the
    // fallback reference: branch 3 returns a Date that is EQUAL to the
    // fallback, and a future refactor that cloned it would silently switch the
    // §5.3a re-derivation on for every legacy race.
    const cloneFallback = new Date(fallbackEndsAt.getTime());
    const result = resolveRaceEndsAt({
      race: { id: "r3", scheduledEndAt: new Date(startedAt.getTime() + HOUR) },
      startedAt,
      fallbackEndsAt: cloneFallback,
      logger: silentLogger,
    });
    assert.equal(result.endsAt.getTime(), fallbackEndsAt.getTime());
    assert.equal(result.honoredCustomEnd, false);
  });

  it("branch 2 boundary: EXACTLY MIN_RACE_WINDOW_MS left is honored", () => {
    const custom = new Date(startedAt.getTime() + MIN_RACE_WINDOW_MS);
    const result = resolveRaceEndsAt({
      race: { id: "r2", scheduledEndAt: custom },
      startedAt,
      fallbackEndsAt,
      logger: silentLogger,
    });
    assert.equal(result.endsAt.getTime(), custom.getTime());
    assert.equal(result.honoredCustomEnd, true);
  });

  it("branch 3: one millisecond under the minimum -> fallback", () => {
    const custom = new Date(startedAt.getTime() + MIN_RACE_WINDOW_MS - 1);
    const result = resolveRaceEndsAt({
      race: { id: "r3", scheduledEndAt: custom },
      startedAt,
      fallbackEndsAt,
      logger: silentLogger,
    });
    assert.equal(result.endsAt, fallbackEndsAt);
    assert.equal(result.honoredCustomEnd, false);
  });

  it("branch 3: a custom end already in the PAST at start -> fallback, never a race that ends before it begins", () => {
    const custom = new Date(startedAt.getTime() - 3 * DAY);
    const result = resolveRaceEndsAt({
      race: { id: "r3", scheduledEndAt: custom },
      startedAt,
      fallbackEndsAt,
      logger: silentLogger,
    });
    assert.equal(result.endsAt, fallbackEndsAt);
    assert.equal(result.honoredCustomEnd, false);
    assert.ok(result.endsAt.getTime() > startedAt.getTime());
  });

  it("branch 3 logs at WARN with the race id and both instants", () => {
    const lines = [];
    const custom = new Date(startedAt.getTime() + 2 * HOUR);
    resolveRaceEndsAt({
      race: { id: "race-late", scheduledEndAt: custom },
      startedAt,
      fallbackEndsAt,
      logger: { warn: (...args) => lines.push(args) },
    });
    assert.equal(lines.length, 1);
    const [, context] = lines[0];
    assert.equal(context.raceId, "race-late");
    assert.equal(context.startedAt, startedAt.toISOString());
    assert.equal(context.scheduledEndAt, custom.toISOString());
    assert.equal(context.fallbackEndsAt, fallbackEndsAt.toISOString());
  });

  it("branches 1 and 2 are silent — only the fallback case is worth a WARN", () => {
    const lines = [];
    const logger = { warn: (...args) => lines.push(args) };
    resolveRaceEndsAt({
      race: { id: "quiet-1", scheduledEndAt: null },
      startedAt,
      fallbackEndsAt,
      logger,
    });
    resolveRaceEndsAt({
      race: { id: "quiet-2", scheduledEndAt: new Date(startedAt.getTime() + 5 * DAY) },
      startedAt,
      fallbackEndsAt,
      logger,
    });
    assert.equal(lines.length, 0);
  });
});

describe("durationDaysFromWindow — floor boundaries (§5.3, test 12)", () => {
  const start = new Date("2026-08-16T12:00:00.000Z");
  const at = (ms) => new Date(start.getTime() + ms);

  it("pins the floor boundary table", () => {
    const cases = [
      [24 * HOUR - 1000, 1, "24h-1s"],
      [24 * HOUR, 1, "24h"],
      [48 * HOUR - 1000, 1, "48h-1s"],
      [48 * HOUR, 2, "48h"],
      [30 * DAY, 30, "30d"],
      [30 * DAY + 1000, 30, "30d+1s (clamped)"],
      [365 * DAY, 30, "a year (clamped)"],
    ];
    for (const [offset, expected, label] of cases) {
      assert.equal(durationDaysFromWindow(start, at(offset)), expected, label);
    }
  });

  it("24h + 1 minute prices at ONE day — the band-boundary exploit the ceil draft would have shipped", () => {
    // With ceil this window priced at the 2-day band (durationPoints 2 vs 1),
    // doubling the coins minted per player-DAY on the most-used duration in
    // prod at zero behavioral cost, in a number the create screen shows the
    // creator. floor is the only rounding that holds the ceiling at today's
    // 20 coins/player-day.
    assert.equal(durationDaysFromWindow(start, at(24 * HOUR + 60 * 1000)), 1);
  });

  it("clamps sub-day and inverted windows to 1 rather than 0 or negative", () => {
    assert.equal(durationDaysFromWindow(start, at(HOUR)), 1);
    assert.equal(durationDaysFromWindow(start, at(0)), 1);
    assert.equal(durationDaysFromWindow(start, at(-5 * DAY)), 1);
  });

  it("is monotonic non-decreasing across the legal range", () => {
    let previous = 0;
    for (let hours = 0; hours <= 30 * 24 + 48; hours += 1) {
      const value = durationDaysFromWindow(start, at(hours * HOUR));
      assert.ok(
        value >= previous,
        `duration went DOWN at ${hours}h (${previous} -> ${value}); ` +
          "prizePool.js's invariant is that a shorter race can never pay more"
      );
      previous = value;
    }
  });

  it("returns null for unparseable input rather than NaN", () => {
    assert.equal(durationDaysFromWindow("nope", at(2 * DAY)), null);
    assert.equal(durationDaysFromWindow(start, "nope"), null);
  });
});
