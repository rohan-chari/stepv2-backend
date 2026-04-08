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
    [375, 0, 0]
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

test("isRacePayoutPresetCompatible allows top-3 presets only when at least 4 runners are accepted", () => {
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
});
