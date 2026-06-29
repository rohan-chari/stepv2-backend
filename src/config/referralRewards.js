// Coin rewards + timing for the referral program. Calibrated against the
// existing reason taxonomy: the one-time tutorial grant is 100 coins, so the
// referrer (rarer, higher-effort, yields a retained racer) earns ~3x and the
// referee gets a tutorial-sized welcome. BOTH are gated on a first *qualifying*
// race (never install/signup) per Apple 3.2.2. These are plain, env-overridable
// constants — tune freely without a migration. Final numbers are a product call
// (REFERRAL_FEATURE_RESEARCH.md §9 / open question 11.2).
const REFERRER_REWARD_COINS = Number(
  process.env.REFERRAL_REFERRER_COINS || 300
);
const REFEREE_REWARD_COINS = Number(process.env.REFERRAL_REFEREE_COINS || 100);

// Signup → first-qualifying-race window. A still-PENDING attribution older than
// this is marked EXPIRED and never pays out, so stale links don't credit
// indefinitely (§5C.5 / §11.12).
const QUALIFY_WINDOW_DAYS = Number(
  process.env.REFERRAL_QUALIFY_WINDOW_DAYS || 30
);

module.exports = {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
  QUALIFY_WINDOW_DAYS,
};
