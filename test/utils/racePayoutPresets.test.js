const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RACE_PAYOUT_PRESETS,
  computeRacePayouts,
  isRacePayoutPresetCompatible,
} = require("../../src/utils/racePayoutPresets");

test("computeRacePayouts gives the full pot to first for winner takes all", () => {
  assert.deepEqual(
    computeRacePayouts({
      preset: RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL,
      potCoins: 375,
    }),
    [375]
  );
});

test("computeRacePayouts rounds down lower places and gives the remainder to first", () => {
  assert.deepEqual(
    computeRacePayouts({
      preset: RACE_PAYOUT_PRESETS.TOP3_70_20_10,
      potCoins: 375,
    }),
    [263, 75, 37]
  );

  assert.deepEqual(
    computeRacePayouts({
      preset: RACE_PAYOUT_PRESETS.TOP3_80_15_5,
      potCoins: 401,
    }),
    [321, 60, 20]
  );
});

test("computeRacePayouts returns an empty split for an empty pot", () => {
  assert.deepEqual(
    computeRacePayouts({
      preset: RACE_PAYOUT_PRESETS.TOP3_70_20_10,
      potCoins: 0,
    }),
    []
  );
});

test("TOP_HALF pays the top half of the field, descending, summing to the pot", () => {
  const payouts = computeRacePayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    potCoins: 2000,
    participantCount: 20,
  });

  // 20 runners -> top half -> 10 paid places.
  assert.equal(payouts.length, 10);
  // Strictly descending (higher place never earns less than a lower one).
  for (let i = 1; i < payouts.length; i++) {
    assert.ok(payouts[i - 1] >= payouts[i]);
  }
  // Top-heavy: 1st lands near ~30% of the pot.
  assert.ok(payouts[0] >= 550 && payouts[0] <= 650);
  // Splits the whole pot, no coins lost or minted.
  assert.equal(
    payouts.reduce((sum, amount) => sum + amount, 0),
    2000
  );
});

test("TOP_HALF rounds the paid-place count up for odd fields", () => {
  const payouts = computeRacePayouts({
    preset: RACE_PAYOUT_PRESETS.TOP_HALF,
    potCoins: 900,
    participantCount: 9,
  });
  // ceil(9 / 2) -> 5 paid places.
  assert.equal(payouts.length, 5);
});

test("ALL_BUT_LAST pays everyone except last, each at least one coin", () => {
  const payouts = computeRacePayouts({
    preset: RACE_PAYOUT_PRESETS.ALL_BUT_LAST,
    potCoins: 2000,
    participantCount: 20,
  });

  // 20 runners -> everyone but last -> 19 paid places.
  assert.equal(payouts.length, 19);
  for (let i = 1; i < payouts.length; i++) {
    assert.ok(payouts[i - 1] >= payouts[i]);
  }
  // Even the deep tail clears the floor — nobody but last walks away empty.
  assert.ok(payouts[payouts.length - 1] >= 1);
  assert.equal(
    payouts.reduce((sum, amount) => sum + amount, 0),
    2000
  );
});

test("field-scaled presets project nothing until the field has more than one runner", () => {
  assert.deepEqual(
    computeRacePayouts({
      preset: RACE_PAYOUT_PRESETS.TOP_HALF,
      potCoins: 100,
      participantCount: 1,
    }),
    []
  );
});

test("isRacePayoutPresetCompatible allows multi-place presets only with at least 4 runners", () => {
  assert.equal(
    isRacePayoutPresetCompatible({
      preset: RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL,
      acceptedCount: 2,
    }),
    true
  );

  assert.equal(
    isRacePayoutPresetCompatible({
      preset: RACE_PAYOUT_PRESETS.TOP3_70_20_10,
      acceptedCount: 3,
    }),
    false
  );

  assert.equal(
    isRacePayoutPresetCompatible({
      preset: RACE_PAYOUT_PRESETS.TOP3_80_15_5,
      acceptedCount: 4,
    }),
    true
  );

  assert.equal(
    isRacePayoutPresetCompatible({
      preset: RACE_PAYOUT_PRESETS.TOP_HALF,
      acceptedCount: 3,
    }),
    false
  );

  assert.equal(
    isRacePayoutPresetCompatible({
      preset: RACE_PAYOUT_PRESETS.ALL_BUT_LAST,
      acceptedCount: 4,
    }),
    true
  );
});
