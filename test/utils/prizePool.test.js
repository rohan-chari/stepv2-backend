const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  PRIZE_COIN_UNIT,
  PRIZE_POOL_MAX,
  durationPoints,
  computePrizePool,
} = require("../../src/shared/economy/prizePool");

// The one place a unit test is the right tool (spec §9): a pure duration/points
// table with many cases. The end-to-end proof that races and tournaments
// actually PAY these numbers lives in test/integration/funded-prize-pools*.

test("the duration bands double at 1/3/7/14 days", () => {
  assert.equal(durationPoints(1), 1);
  assert.equal(durationPoints(2), 2);
  assert.equal(durationPoints(3), 2);
  assert.equal(durationPoints(4), 4);
  assert.equal(durationPoints(7), 4);
  assert.equal(durationPoints(8), 8);
  assert.equal(durationPoints(14), 8);
});

test("durationPoints is monotonic non-decreasing over the whole legal 1..30 range", () => {
  // validateDuration allows up to 30 and frozen clients still send 5, so a
  // shorter race must never be able to pay more than a longer one.
  let previous = 0;
  for (let days = 1; days <= 30; days++) {
    const points = durationPoints(days);
    assert.ok(points >= previous, `days=${days} dropped from ${previous} to ${points}`);
    assert.ok([1, 2, 4, 8].includes(points), `days=${days} -> ${points}`);
    previous = points;
  }
});

test("a frozen client's off-band 5-day race falls to the lower band, never higher", () => {
  assert.equal(durationPoints(5), 4);
  assert.ok(durationPoints(5) <= durationPoints(7));
  assert.ok(durationPoints(5) >= durationPoints(3));
});

test("junk/zero/negative durations degrade to the smallest band", () => {
  assert.equal(durationPoints(0), 1);
  assert.equal(durationPoints(-4), 1);
  assert.equal(durationPoints(null), 1);
  assert.equal(durationPoints(undefined), 1);
  assert.equal(durationPoints(3.9), 2); // floored to 3
});

test("the owner fixtures", () => {
  assert.equal(computePrizePool({ playerCount: 4, durationDays: 3 }), 160);
  assert.equal(computePrizePool({ playerCount: 20, durationDays: 14 }), 3200);
  assert.equal(computePrizePool({ playerCount: 2, durationDays: 1 }), 40);
  assert.equal(computePrizePool({ playerCount: 10, durationDays: 7 }), 800);
});

test("a solo field mints nothing", () => {
  assert.equal(computePrizePool({ playerCount: 1, durationDays: 14 }), 0);
  assert.equal(computePrizePool({ playerCount: 0, durationDays: 14 }), 0);
  assert.equal(computePrizePool({ playerCount: null, durationDays: 7 }), 0);
});

test("the race cap allows the legal 100-player maximum and clamps oversized fields", () => {
  assert.equal(PRIZE_COIN_UNIT, 20);
  assert.equal(PRIZE_POOL_MAX, 16000);
  // 100 players x 14 days reaches the configured legal-field maximum.
  assert.equal(computePrizePool({ playerCount: 100, durationDays: 14 }), 16000);
  // A hypothetical oversized field is still clamped.
  assert.equal(computePrizePool({ playerCount: 300, durationDays: 14 }), 16000);
});

test("tournaments pass their own tighter ceiling", () => {
  // 16-bracket x 3-day rounds = 12 days -> 8 points -> 2,560, clamped to 1,000.
  assert.equal(
    computePrizePool({ playerCount: 16, durationDays: 12, max: 1000 }),
    1000
  );
  // 4-bracket x 2-day rounds = 4 days -> 4 points -> 320, under the ceiling.
  assert.equal(
    computePrizePool({ playerCount: 4, durationDays: 4, max: 1000 }),
    320
  );
  // 8-bracket x 2-day rounds = 6 days -> 4 points -> 640.
  assert.equal(
    computePrizePool({ playerCount: 8, durationDays: 6, max: 1000 }),
    640
  );
});
