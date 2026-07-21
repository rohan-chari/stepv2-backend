// Ranked v2 (weekly cohorts) constants + pure zone/reward math. See RANKED_V2.md.
//
// Six persistent tiers. Each week every participant competes inside a ~30
// person same-tier cohort on raw weekly steps; at settlement the top zone
// promotes, the bottom zone demotes, the middle holds. Zones scale
// proportionally so small cohorts don't churn absurdly (7/30 of a 12-person
// cohort is ~3, not 7).

const V2_TIER_KEYS = [
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "DIAMOND",
  "LEGEND",
];

// rewardMultiplier scales the base placement payout; promotionBonus is the
// one-time coin pop minted the first time a user ever enters the tier
// (idempotent forever on awardCoins refId, so re-promotion never re-pays).
const V2_TIERS = [
  { key: "BRONZE", label: "Bronze", rewardMultiplier: 1.0, promotionBonus: 0 },
  { key: "SILVER", label: "Silver", rewardMultiplier: 1.25, promotionBonus: 100 },
  { key: "GOLD", label: "Gold", rewardMultiplier: 1.5, promotionBonus: 200 },
  { key: "PLATINUM", label: "Platinum", rewardMultiplier: 2.0, promotionBonus: 350 },
  { key: "DIAMOND", label: "Diamond", rewardMultiplier: 2.5, promotionBonus: 500 },
  { key: "LEGEND", label: "Legend", rewardMultiplier: 3.0, promotionBonus: 1000 },
];

const DEFAULT_TIER = "BRONZE"; // users never placed compete as Bronze

const COHORT_TARGET_SIZE = 30;
// Soft ceiling for mid-week joins; beyond this a fresh cohort opens instead.
const COHORT_MAX_SIZE = 35;

// How long after a week opens we still rebalance a tier when newcomers arrive,
// rather than just backfilling. Early in the week nobody has a meaningful
// standing yet, so re-chunking a tier into even, step-matched cohorts is fair
// game and prevents the lopsided "fill one cohort to 35, spill 2 into a new
// one" split. Past this window we only place newcomers and never move members
// already competing in a cohort.
const COHORT_REBALANCE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h

// Promotion/demotion zone as a fraction of cohort size (7 of 30).
const ZONE_FRACTION = 7 / 30;

// A day counts as "active" at >= this many steps (matches the legacy RP floor).
// A member needs >= 1 active day in the week to be paid or promoted — blocks
// idle accounts from farming coins / drifting upward in dead cohorts.
const ACTIVE_DAY_FLOOR = 5000;
const MIN_ACTIVE_DAYS_FOR_REWARD = 1;

// Settlement waits this long past the week boundary so Sunday-evening steps
// from behind-UTC timezones (synced after Monday 00:00 UTC) still count. The
// next week opens on time; both weeks update during the grace window.
const SETTLE_GRACE_HOURS = 18;

// Base placement payout for a full-size cohort; tier multiplier applied on
// top, rounded to the nearest 5. Demotion zone pays 0.
const PLACEMENT_REWARDS = {
  first: 200,
  second: 150,
  third: 120,
  promotionZone: 80, // promotion zone below the podium
  holdUpper: 40, // upper half of the hold zone
  holdLower: 20, // lower half of the hold zone
  demotionZone: 0,
};

function tierIndex(tierKey) {
  const idx = V2_TIER_KEYS.indexOf(tierKey);
  return idx === -1 ? 0 : idx;
}

function tierConfig(tierKey) {
  return V2_TIERS[tierIndex(tierKey)];
}

function nextTierUp(tierKey) {
  const idx = tierIndex(tierKey);
  return idx < V2_TIER_KEYS.length - 1 ? V2_TIER_KEYS[idx + 1] : tierKey;
}

function nextTierDown(tierKey) {
  const idx = tierIndex(tierKey);
  return idx > 0 ? V2_TIER_KEYS[idx - 1] : tierKey;
}

// Zone sizes for a cohort of `size` members in `tierKey`. Proportional to
// size; Bronze never demotes, Legend never promotes; zones never overlap.
function zoneSizes(size, tierKey) {
  if (size <= 0) return { promote: 0, demote: 0 };
  const zone = Math.max(1, Math.round(size * ZONE_FRACTION));
  let promote = tierKey === "LEGEND" ? 0 : Math.min(zone, size);
  let demote = tierKey === "BRONZE" ? 0 : Math.min(zone, size - promote);
  return { promote, demote };
}

// Coin payout for a 1-based placement in a cohort of `size` in `tierKey`.
// Pure; the active-day guard is applied by the caller.
function placementReward(rank, size, tierKey) {
  if (!rank || rank < 1 || size < 1) return 0;
  const { promote, demote } = zoneSizes(size, tierKey);
  const demotionStart = size - demote + 1;

  let base;
  if (rank >= demotionStart) {
    base = PLACEMENT_REWARDS.demotionZone;
  } else if (rank === 1) {
    base = PLACEMENT_REWARDS.first;
  } else if (rank === 2) {
    base = PLACEMENT_REWARDS.second;
  } else if (rank === 3) {
    base = PLACEMENT_REWARDS.third;
  } else if (rank <= Math.max(promote, 3)) {
    base = PLACEMENT_REWARDS.promotionZone;
  } else {
    // Hold zone, split into upper/lower halves.
    const holdStart = Math.max(promote, 3) + 1;
    const holdEnd = demotionStart - 1;
    const holdMid = holdStart + Math.ceil((holdEnd - holdStart + 1) / 2) - 1;
    base = rank <= holdMid ? PLACEMENT_REWARDS.holdUpper : PLACEMENT_REWARDS.holdLower;
  }

  const scaled = base * tierConfig(tierKey).rewardMultiplier;
  return Math.round(scaled / 5) * 5;
}

module.exports = {
  V2_TIER_KEYS,
  V2_TIERS,
  DEFAULT_TIER,
  COHORT_TARGET_SIZE,
  COHORT_MAX_SIZE,
  COHORT_REBALANCE_WINDOW_MS,
  ZONE_FRACTION,
  ACTIVE_DAY_FLOOR,
  MIN_ACTIVE_DAYS_FOR_REWARD,
  SETTLE_GRACE_HOURS,
  PLACEMENT_REWARDS,
  tierIndex,
  tierConfig,
  nextTierUp,
  nextTierDown,
  zoneSizes,
  placementReward,
};
