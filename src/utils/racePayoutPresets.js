const RACE_PAYOUT_PRESETS = {
  WINNER_TAKES_ALL: "WINNER_TAKES_ALL",
  TOP3_70_20_10: "TOP3_70_20_10",
  TOP3_80_15_5: "TOP3_80_15_5",
};

const PAYOUT_PERCENTAGES = {
  [RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL]: [100, 0, 0],
  [RACE_PAYOUT_PRESETS.TOP3_70_20_10]: [70, 20, 10],
  [RACE_PAYOUT_PRESETS.TOP3_80_15_5]: [80, 15, 5],
};

function isRacePayoutPreset(value) {
  return Object.values(RACE_PAYOUT_PRESETS).includes(value);
}

function getRacePayoutPercentages(preset) {
  return PAYOUT_PERCENTAGES[preset] || PAYOUT_PERCENTAGES[RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL];
}

function computeRacePayouts({ preset, potCoins }) {
  const safePot = Math.max(0, potCoins || 0);
  const [firstPercent, secondPercent, thirdPercent] =
    getRacePayoutPercentages(preset);

  const second = Math.floor((safePot * secondPercent) / 100);
  const third = Math.floor((safePot * thirdPercent) / 100);
  const first = safePot - second - third;

  return [
    Math.floor((safePot * firstPercent) / 100) + (first - Math.floor((safePot * firstPercent) / 100)),
    second,
    third,
  ];
}

function isRacePayoutPresetCompatible({ preset, acceptedCount }) {
  if (preset === RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL) {
    return true;
  }

  return (acceptedCount || 0) >= 4;
}

module.exports = {
  RACE_PAYOUT_PRESETS,
  computeRacePayouts,
  getRacePayoutPercentages,
  isRacePayoutPreset,
  isRacePayoutPresetCompatible,
};
