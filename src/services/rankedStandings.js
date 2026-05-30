// Builds the ranked standings for a season: aggregate each eligible user's RP
// from their Step rows, apply the soft-reset carry-over seed, sort, and assign
// rank + tier. Used by the computeRanks job (provisional) and the
// settleRankedSeason command (final).

const { prisma } = require("../db");
const { Steps: defaultSteps } = require("../models/steps");
const { SeasonScore: defaultSeasonScore } = require("../models/season");
const { computeSeasonRp } = require("./rankedPoints");
const {
  resolveTier,
  carryOverSeedForTier,
  ELIGIBILITY_MIN_ACTIVE_DAYS,
} = require("../constants/rankedTiers");

// Pure: given [{ userId, points, earnedPoints, carryOverSeed }], sort by points
// (desc, userId tiebreak for determinism) and attach rank + tier + division.
function computeStandings(scored) {
  const sorted = [...scored].sort(
    (a, b) => b.points - a.points || a.userId.localeCompare(b.userId)
  );
  const total = sorted.length;
  return sorted.map((entry, index) => {
    const rank = index + 1;
    const { tier, division } = resolveTier(entry.points, rank, total);
    return { ...entry, rank, tier, division };
  });
}

async function defaultGetUserTiers(userIds) {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, currentTier: true },
  });
  return new Map(users.map((u) => [u.id, u.currentTier]));
}

// The UTC calendar day (midnight) of a timestamp. Step.date is stored at UTC
// midnight, so season-window comparisons must be on the date, not the time.
function utcDateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Reads step rows for the season window, computes each user's points, and
// returns the ranked standings array (no writes). The window is [start day,
// end day) on the date axis — the end day belongs to the next season.
async function recomputeStandings({
  season,
  Steps = defaultSteps,
  SeasonScore = defaultSeasonScore,
  getUserTiers = defaultGetUserTiers,
}) {
  const rows = await Steps.findRowsInRange(
    utcDateOnly(season.startsAt),
    utcDateOnly(season.endsAt)
  );

  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }

  // Carry-over seeds: reuse the stored seed for users already scored this
  // season; for first-time-this-season users, seed from their last settled tier.
  const existing = await SeasonScore.listForSeason(season.id);
  const seedByUser = new Map(existing.map((s) => [s.userId, s.carryOverSeed]));

  const eligible = [];
  const newUserIds = [];
  for (const [userId, userRows] of byUser) {
    const { earnedPoints, activeDays } = computeSeasonRp(userRows);
    if (activeDays < ELIGIBILITY_MIN_ACTIVE_DAYS) continue;
    eligible.push({ userId, earnedPoints });
    if (!seedByUser.has(userId)) newUserIds.push(userId);
  }

  if (newUserIds.length > 0) {
    const tierByUser = await getUserTiers(newUserIds);
    for (const userId of newUserIds) {
      seedByUser.set(userId, carryOverSeedForTier(tierByUser.get(userId)));
    }
  }

  const scored = eligible.map(({ userId, earnedPoints }) => {
    const carryOverSeed = seedByUser.get(userId) || 0;
    return { userId, earnedPoints, carryOverSeed, points: carryOverSeed + earnedPoints };
  });

  return computeStandings(scored);
}

module.exports = { computeStandings, recomputeStandings };
