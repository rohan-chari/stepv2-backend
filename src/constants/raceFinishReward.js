// System-funded coin rewards for the seeded recurring races (the daily/weekly
// challenges).
//
// Unlike buy-in races — where the prize pool is funded by joiners' coins held
// into race.potCoins — these pools are MINTED on completion, the same pattern
// as daily rewards (src/constants/dailyReward.js) and step milestones
// (src/constants/stepMilestones.js). On completion the pool is split across the
// top `paidPlaces` finishers by a descending weight, so higher placers earn
// more (see computeGradedPayouts in src/utils/racePayoutPresets.js).
//
// Both knobs scale with the field, which is what keeps the reward sensible as a
// challenge grows from 6 to 600 racers:
//   * the POOL grows per finisher (`perHead`), clamped between `minPool` (a floor
//     so a tiny field still feels worth it) and `maxPool` (a cap that bounds how
//     many coins we mint per race), and
//   * the number of PAID PLACES is CONCENTRATED — `paidFraction` of the field,
//     clamped between `minPlaces` and `maxPlaces` and never exceeding the field —
//     so a 100-person daily pays a handful of meaningful prizes instead of
//     splitting a pot across 50 nominal "winners" who mostly round to 0 coins.
//
// Keyed by RaceSeed.id. Only the seeds listed here pay a finish reward; every
// other race (user-created, legacy) is unaffected and keeps the buy-in pot
// behavior.
const RACE_FINISH_REWARD_CONFIG = {
  "seed-daily-10k": {
    perHead: 15,
    minPool: 100,
    maxPool: 1500,
    paidFraction: 0.5,
    minPlaces: 3,
    maxPlaces: 15,
    // Optional tail floor: the LAST paid place must clear this many coins.
    // Enforced by shrinking the paid-place count (never below minPlaces), so a
    // wide field doesn't dilute the pool into sub-10-coin nominal prizes. Absent
    // on a seed ⇒ no floor (legacy behavior).
    minTailPayout: 10,
  },
  "seed-weekly-50k": {
    perHead: 40,
    minPool: 500,
    maxPool: 5000,
    paidFraction: 0.2,
    minPlaces: 3,
    maxPlaces: 20,
  },
};

function getFinishRewardConfig(seedId) {
  if (!seedId) return null;
  return RACE_FINISH_REWARD_CONFIG[seedId] || null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Floor the field count defensively — callers pass either an accepted-count
// projection (queries) or the eligible-walker count (settlement); both can be
// sloppy, and a negative/NaN field must mint nothing.
function safeFieldCount(participantCount) {
  const n = Math.floor(participantCount || 0);
  return n > 0 ? n : 0;
}

// The minted pool for a seeded race given how many finishers are in the field.
// Returns 0 for non-seeded races or an empty field.
function computeFinishRewardPool(seedId, participantCount) {
  const config = getFinishRewardConfig(seedId);
  if (!config) return 0;
  const n = safeFieldCount(participantCount);
  if (n === 0) return 0;
  return clamp(Math.round(config.perHead * n), config.minPool, config.maxPool);
}

// The coins the last of `count` linearly-weighted places receives from `pool`.
// Mirrors the last element of computeGradedPayouts (the rounding remainder only
// ever lifts 1st place, so the tail is exactly floor(pool / totalWeight)); kept
// as a tiny local helper so this module stays dependency-free and the tail-floor
// check below matches settlement's split exactly.
function lastPlaceShare(pool, count) {
  if (pool <= 0 || count <= 0) return 0;
  const totalWeight = (count * (count + 1)) / 2;
  return Math.floor(pool / totalWeight);
}

// How many top places share the pool. Concentrated (a small fraction of the
// field, capped), and never more places than there are finishers. Returns 0 for
// non-seeded races or an empty field.
//
// `pool` is the already-computed minted pool (see computeFinishRewardPool) and
// only matters when the seed sets `minTailPayout`: with the descending linear
// weights, the last paid place earns floor(pool / (N(N+1)/2)) coins, which
// shrinks as N grows. To keep that tail meaningful we REDUCE the paid-place
// count (never below minPlaces) until the last place clears minTailPayout. A
// seed without minTailPayout keeps the legacy behavior (no floor). `pool` is
// optional — when omitted it's derived from the same computeFinishRewardPool, so
// a plain 2-arg call still returns the floored count; passing the pool the
// caller already computed just avoids recomputing it. Either way the places a
// projection shows match what settlement pays for the same field.
function computeFinishRewardPlaces(seedId, participantCount, pool) {
  const config = getFinishRewardConfig(seedId);
  if (!config) return 0;
  const n = safeFieldCount(participantCount);
  if (n === 0) return 0;
  const scaled = Math.ceil(config.paidFraction * n);
  let places = Math.min(n, clamp(scaled, config.minPlaces, config.maxPlaces));

  const floor = config.minTailPayout;
  if (floor && floor > 0) {
    const effectivePool =
      pool != null ? pool : computeFinishRewardPool(seedId, n);
    while (
      places > config.minPlaces &&
      lastPlaceShare(effectivePool, places) < floor
    ) {
      places -= 1;
    }
  }
  return places;
}

module.exports = {
  RACE_FINISH_REWARD_CONFIG,
  getFinishRewardConfig,
  computeFinishRewardPool,
  computeFinishRewardPlaces,
};
