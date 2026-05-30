// Ranked tier ladder + Ranked Points (RP) formula constants. See RANKED.md.
//
// Tiers Bronze→Gold are FIXED behavioral thresholds (your tier reflects your
// real monthly activity, stable as the user base grows). Diamond is the elite
// tier: it requires BOTH crossing the Diamond floor AND landing in the top
// DIAMOND_TOP_FRACTION — so it self-adjusts and never over-promotes on a small
// field. Thresholds calibrated 2026-05-29 against the real step distribution.

// ── RP formula ───────────────────────────────────────────────────────────────
// daily RP = milestone_pts + floor(steps / RP_STEPS_PER_POINT) + streak_bonus
const RP_ACTIVE_FLOOR = 5000; // a day counts as "active" (and toward streaks) at >= this
const RP_STEPS_PER_POINT = 1000; // volume tilt: +1 RP per 1000 steps
const RP_STREAK_PER_DAY = 5; // +5 RP per consecutive active day...
const RP_STREAK_CAP = 50; // ...capped at +50/day

// Cumulative daily-milestone points (independently earned as the day's step
// total crosses each threshold; matches the home StepMilestone thresholds).
const RP_MILESTONES = [
  { steps: 5000, points: 20 },
  { steps: 10000, points: 30 },
  { steps: 15000, points: 30 },
  { steps: 20000, points: 20 },
];

// ── Tiers ────────────────────────────────────────────────────────────────────
// `floor` is the minimum season RP for the tier. Divisions are sub-bands within
// a tier (III lowest → I highest); Diamond has no divisions.
const TIERS = [
  {
    key: "BRONZE",
    label: "Bronze",
    floor: 0,
    divisions: [
      { division: 3, floor: 0 },
      { division: 2, floor: 67 },
      { division: 1, floor: 133 },
    ],
  },
  {
    key: "SILVER",
    label: "Silver",
    floor: 200,
    divisions: [
      { division: 3, floor: 200 },
      { division: 2, floor: 317 },
      { division: 1, floor: 433 },
    ],
  },
  {
    key: "GOLD",
    label: "Gold",
    floor: 550,
    divisions: [
      { division: 3, floor: 550 },
      { division: 2, floor: 833 },
      { division: 1, floor: 1116 },
    ],
  },
  {
    key: "DIAMOND",
    label: "Diamond",
    floor: 1400,
    divisions: null,
    percentileCapped: true,
  },
];

const DIAMOND_TOP_FRACTION = 0.1; // top ~10% of ranked users (and >= Diamond floor)

// Season cadence: ~monthly fixed windows. (Tunable; production may align to
// calendar months — see RANKED.md.)
const SEASON_DURATION_DAYS = 30;

// A user is eligible for the ladder once they have >= 1 active day in the season.
const ELIGIBILITY_MIN_ACTIVE_DAYS = 1;

// ── Rewards (placeholder amounts, tunable; cosmetics arrive in Phase 3) ───────
const TIER_REWARDS = {
  BRONZE: { coins: 100 },
  SILVER: { coins: 250 },
  GOLD: { coins: 600 },
  DIAMOND: { coins: 1500 },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

// Highest tier whose floor <= points (ignores the Diamond percentile gate).
function baseTierForPoints(points) {
  const p = Math.max(0, Math.floor(points || 0));
  let match = TIERS[0];
  for (const tier of TIERS) {
    if (p >= tier.floor) match = tier;
  }
  return match;
}

// Highest division within a tier whose floor <= points (null for Diamond).
function divisionForPoints(tier, points) {
  if (!tier.divisions) return null;
  const p = Math.max(0, Math.floor(points || 0));
  let division = tier.divisions[0].division;
  for (const d of tier.divisions) {
    if (p >= d.floor) division = d.division;
  }
  return division;
}

// Resolve the final tier + division for a user given their points, ladder rank
// (1-based), and the total number of ranked users. Diamond requires BOTH points
// >= Diamond floor AND rank within the top fraction; otherwise the user caps at
// Gold I even with Diamond-level points (rare — Diamond points ≈ top ~10%).
function resolveTier(points, rank, totalRanked) {
  const base = baseTierForPoints(points);
  if (base.key === "DIAMOND") {
    const cutoff = Math.max(1, Math.ceil((totalRanked || 0) * DIAMOND_TOP_FRACTION));
    if (rank != null && rank <= cutoff) {
      return { tier: "DIAMOND", division: null };
    }
    return { tier: "GOLD", division: 1 };
  }
  return { tier: base.key, division: divisionForPoints(base, points) };
}

// Soft reset: next season a user starts seeded at the floor of one tier below
// their final tier, so returning strong players get a head start but still climb.
function carryOverSeedForTier(tierKey) {
  switch (tierKey) {
    case "DIAMOND":
      return 550; // Gold floor
    case "GOLD":
      return 200; // Silver floor
    case "SILVER":
      return 0; // Bronze floor
    default:
      return 0;
  }
}

module.exports = {
  RP_ACTIVE_FLOOR,
  RP_STEPS_PER_POINT,
  RP_STREAK_PER_DAY,
  RP_STREAK_CAP,
  RP_MILESTONES,
  TIERS,
  DIAMOND_TOP_FRACTION,
  SEASON_DURATION_DAYS,
  ELIGIBILITY_MIN_ACTIVE_DAYS,
  TIER_REWARDS,
  baseTierForPoints,
  divisionForPoints,
  resolveTier,
  carryOverSeedForTier,
};
