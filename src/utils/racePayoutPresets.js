const RACE_PAYOUT_PRESETS = {
  WINNER_TAKES_ALL: "WINNER_TAKES_ALL",
  TOP3_70_20_10: "TOP3_70_20_10",
  TOP3_80_15_5: "TOP3_80_15_5",
  TOP_HALF: "TOP_HALF",
  ALL_BUT_LAST: "ALL_BUT_LAST",
};

// Fixed-percentage presets: a static split over a fixed number of places. The
// array length is how many places get paid; index 0 is 1st. WINNER_TAKES_ALL is
// a one-entry split so its payout array is just [pot].
const PAYOUT_PERCENTAGES = {
  [RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL]: [100],
  [RACE_PAYOUT_PRESETS.TOP3_70_20_10]: [70, 20, 10],
  [RACE_PAYOUT_PRESETS.TOP3_80_15_5]: [80, 15, 5],
};

// Field-scaled presets: the number of paid places grows with the field size, so
// in a 20-person race many more than three people get paid. Coins still descend
// by place (higher finish = more coins). These only ever come from new app
// builds, whose races send targetSteps=0 and therefore settle at the deadline
// with the WHOLE field ranked (raceExpiry) — which is what paying "the top half"
// or "everyone but last" requires.
const GRADED_PRESETS = new Set([
  RACE_PAYOUT_PRESETS.TOP_HALF,
  RACE_PAYOUT_PRESETS.ALL_BUT_LAST,
]);

// Every preset except winner-takes-all needs at least this many accepted runners
// before a race can start, so a "top half of 2" can't trivially degenerate.
const MIN_MULTI_PAYOUT_PARTICIPANTS = 4;

// Geometric decay across the paid places of a field-scaled preset: each place
// gets ~RATIO of the place above it. At 0.7, 1st lands near ~30% of the pot
// regardless of field size, giving a top-heavy curve where winning stays worth
// chasing while the long tail still gets something.
const GRADED_PAYOUT_RATIO = 0.7;

// Floor under every paid place, so "everyone but last" really does hand everyone
// a few coins even in a big field where the geometric tail would round to 0.
const GRADED_MIN_PAYOUT = 1;

function isRacePayoutPreset(value) {
  return Object.values(RACE_PAYOUT_PRESETS).includes(value);
}

function getRacePayoutPercentages(preset) {
  return (
    PAYOUT_PERCENTAGES[preset] ||
    PAYOUT_PERCENTAGES[RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL]
  );
}

// How many places a field-scaled preset pays for a given field size. Returns 0
// for a field of 0 or 1 (nobody to spread across yet) so projections on a
// just-created race read as "no payouts" until more runners join.
function gradedSlotCount(preset, participantCount) {
  const field = Math.max(0, Math.floor(participantCount || 0));
  if (field <= 1) return 0;
  if (preset === RACE_PAYOUT_PRESETS.TOP_HALF) {
    return Math.ceil(field / 2);
  }
  if (preset === RACE_PAYOUT_PRESETS.ALL_BUT_LAST) {
    return field - 1;
  }
  return 0;
}

// Distribute `pot` across `percentages` (index 0 = 1st). Lower places are floored
// and 1st takes the rounding remainder, so the split always sums to the pot.
function distributeByPercentages(percentages, pot) {
  const amounts = percentages.map((percent, index) =>
    index === 0 ? 0 : Math.floor((pot * percent) / 100)
  );
  const lowerTotal = amounts.reduce((sum, amount) => sum + amount, 0);
  amounts[0] = pot - lowerTotal;
  return amounts;
}

// Split `pot` across `slots` places with geometric decay on top of a flat
// GRADED_MIN_PAYOUT floor: every place clears the floor, higher places always
// get more, and 1st takes the rounding remainder so the split sums to the pot.
function distributeGeometric(pot, slots) {
  if (pot <= 0 || slots <= 0) return [];

  // Can't reserve more floor than the pot holds; the Math.min keeps a degenerate
  // pot-smaller-than-field case (not reachable with the ≥10-coin buy-in minimum)
  // from going negative and just falls back to a pure geometric split.
  const floor = Math.min(GRADED_MIN_PAYOUT, Math.floor(pot / slots));
  const curvePot = pot - floor * slots;

  const weights = [];
  let totalWeight = 0;
  for (let index = 0; index < slots; index++) {
    const weight = Math.pow(GRADED_PAYOUT_RATIO, index);
    weights.push(weight);
    totalWeight += weight;
  }

  const amounts = weights.map(
    (weight) => floor + Math.floor((curvePot * weight) / totalWeight)
  );
  const distributed = amounts.reduce((sum, amount) => sum + amount, 0);
  amounts[0] += pot - distributed;
  return amounts;
}

// Coins won by place, as an array indexed by finishing position (index 0 = 1st).
// Its length is the number of paid places — fixed for the percentage presets,
// field-dependent for the graded ones (hence `participantCount`). Returns [] for
// an empty pot. Callers map the first three entries onto the legacy
// {first,second,third} shape for older app builds and expose the full array as
// payoutTiers for newer ones.
function computeRacePayouts({ preset, potCoins, participantCount }) {
  const safePot = Math.max(0, potCoins || 0);
  if (safePot === 0) return [];

  if (GRADED_PRESETS.has(preset)) {
    return distributeGeometric(
      safePot,
      gradedSlotCount(preset, participantCount)
    );
  }

  return distributeByPercentages(getRacePayoutPercentages(preset), safePot);
}

function isRacePayoutPresetCompatible({ preset, acceptedCount }) {
  if (preset === RACE_PAYOUT_PRESETS.WINNER_TAKES_ALL) {
    return true;
  }

  return (acceptedCount || 0) >= MIN_MULTI_PAYOUT_PARTICIPANTS;
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
  MIN_MULTI_PAYOUT_PARTICIPANTS,
  computeRacePayouts,
  computeGradedPayouts,
  getRacePayoutPercentages,
  isRacePayoutPreset,
  isRacePayoutPresetCompatible,
};
