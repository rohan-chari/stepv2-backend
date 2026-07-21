// Coin rewards + timing for the referral program. The referrer (rarer, higher-
// effort, yields a retained racer) earns 2x the referee, who gets a sizable
// welcome. BOTH are gated on a first *qualifying* race (never install/signup)
// per Apple 3.2.2. These are plain, env-overridable constants — tune freely
// without a migration. Final numbers are a product call
// (REFERRAL_FEATURE_RESEARCH.md §9 / open question 11.2).
const REFERRER_REWARD_COINS = Number(
  process.env.REFERRAL_REFERRER_COINS || 1000
);
const REFEREE_REWARD_COINS = Number(process.env.REFERRAL_REFEREE_COINS || 500);

// Signup → first-qualifying-race window. A still-PENDING attribution older than
// this is marked EXPIRED and never pays out, so stale links don't credit
// indefinitely (§5C.5 / §11.12).
const QUALIFY_WINDOW_DAYS = Number(
  process.env.REFERRAL_QUALIFY_WINDOW_DAYS || 30
);

// Velocity caps (§8.7): the max number of REFERRER rewards a single referrer can
// be paid within a trailing window before further referrals are HELD for manual
// review instead of auto-paying. A genuine power-referrer rarely lands 20 first-
// race completions in a day; bursts past these caps are the signature of a
// referral ring. Held referrals stay queryable (status FLAGGED) and never
// auto-pay — a human flips them back to PENDING or grants manually.
const REFERRAL_DAILY_CAP = Number(process.env.REFERRAL_DAILY_CAP || 20);
const REFERRAL_MONTHLY_CAP = Number(process.env.REFERRAL_MONTHLY_CAP || 100);

module.exports = {
  REFERRER_REWARD_COINS,
  REFEREE_REWARD_COINS,
  QUALIFY_WINDOW_DAYS,
  REFERRAL_DAILY_CAP,
  REFERRAL_MONTHLY_CAP,
};
