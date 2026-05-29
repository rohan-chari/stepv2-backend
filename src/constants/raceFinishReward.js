// System-funded coin rewards for the seeded recurring races.
//
// Unlike buy-in races — where the prize pool is funded by joiners' coins held
// into race.potCoins — these pools are MINTED on completion, the same pattern
// as daily rewards (src/constants/dailyReward.js) and step milestones
// (src/constants/stepMilestones.js). On completion the pool is split across the
// top FINISH_REWARD_TOP_FRACTION of finishers by a descending weight, so higher
// placers earn more (see computeGradedPayouts in src/utils/racePayoutPresets.js).
//
// Keyed by RaceSeed.id. Only the seeds listed here pay a finish reward; every
// other race (user-created, legacy) is unaffected and keeps the buy-in pot
// behavior.
const RACE_FINISH_REWARD_POOLS = {
  "seed-daily-10k": 100,
  "seed-weekly-50k": 500,
};

// Fraction of eligible finishers (rounded up) who share the pool.
const FINISH_REWARD_TOP_FRACTION = 0.5;

function getFinishRewardPool(seedId) {
  if (!seedId) return 0;
  return RACE_FINISH_REWARD_POOLS[seedId] || 0;
}

module.exports = {
  RACE_FINISH_REWARD_POOLS,
  FINISH_REWARD_TOP_FRACTION,
  getFinishRewardPool,
};
