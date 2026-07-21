// Daily login reward configuration.
// Cycle is 6 days. Day 6 is a random unowned accessory; if user owns all,
// they receive DAY_6_FALLBACK_COINS instead.
const DAILY_COIN_LADDER = [10, 20, 30, 40, 50];
const CYCLE_LENGTH = 6;
const DAY_6_FALLBACK_COINS = 100;

const REWARD_TYPE = {
  COINS: "COINS",
  ACCESSORY: "ACCESSORY",
  COINS_FALLBACK: "COINS_FALLBACK",
  // A shop powerup (IMPOSTER/RAINSTORM/SIGNAL_JAMMER/…) won from the daily box.
  // Only ever rolled/returned for clients that advertise the `spinpowerups`
  // capability — old binaries can't render this reward type and would show it
  // as "+0 coins", so the backend keeps them on the legacy coins/accessory-only
  // behavior (see routes/dailyReward.js gating).
  POWERUP: "POWERUP",
};

function getRewardPreviewForDay(cycleDay) {
  if (cycleDay >= 1 && cycleDay <= 5) {
    return { type: REWARD_TYPE.COINS, coinAmount: DAILY_COIN_LADDER[cycleDay - 1] };
  }
  if (cycleDay === 6) {
    return { type: REWARD_TYPE.ACCESSORY };
  }
  return null;
}

module.exports = {
  DAILY_COIN_LADDER,
  CYCLE_LENGTH,
  DAY_6_FALLBACK_COINS,
  REWARD_TYPE,
  getRewardPreviewForDay,
};
