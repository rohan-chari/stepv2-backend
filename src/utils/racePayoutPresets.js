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

// Split a fixed reward pool across `count` ranked finishers using descending
// linear weights (rank 1 gets weight `count`, the last rank gets weight 1), so
// higher placers always earn at least as much as lower ones and the total never
// exceeds the pool. The rounding remainder goes to 1st place — same convention
// as computeRacePayouts. Used for the seeded daily/weekly finish rewards, which
// are minted rather than funded by a buy-in pot.
function computeGradedPayouts({ pool, count }) {
  const safePool = Math.max(0, Math.floor(pool || 0));
  const slots = Math.max(0, Math.floor(count || 0));
  if (safePool === 0 || slots === 0) {
    return [];
  }

  const totalWeight = (slots * (slots + 1)) / 2;
  const amounts = [];
  let distributed = 0;
  for (let rank = 1; rank <= slots; rank++) {
    const weight = slots - rank + 1;
    const amount = Math.floor((safePool * weight) / totalWeight);
    amounts.push(amount);
    distributed += amount;
  }
  amounts[0] += safePool - distributed;
  return amounts;
}

module.exports = {
  RACE_PAYOUT_PRESETS,
  computeRacePayouts,
  computeGradedPayouts,
  getRacePayoutPercentages,
  isRacePayoutPreset,
  isRacePayoutPresetCompatible,
};
