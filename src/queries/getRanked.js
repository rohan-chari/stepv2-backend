const { prisma } = require("../db");
const { Season, SeasonScore } = require("../models/season");
const { TIERS, TIER_REWARDS } = require("../constants/rankedTiers");

const LADDER_LIMIT = 100;

// Static tier ladder + per-tier reward, surfaced so the client can show "Finish
// Gold → 600 coins" without hardcoding (and never drifting from) the thresholds.
const TIER_SUMMARY = TIERS.map((t) => ({
  key: t.key,
  label: t.label,
  floor: t.floor,
  reward: TIER_REWARDS[t.key] ? TIER_REWARDS[t.key].coins : 0,
}));

async function getUserProfiles(userIds) {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, profilePhotoUrl: true },
  });
  return new Map(
    users.map((u) => [
      u.id,
      {
        displayName: u.displayName || "Anonymous",
        profilePhotoUrl: u.profilePhotoUrl || null,
      },
    ])
  );
}

// GET /ranked — the live ladder for the active season, plus the requesting
// user's own standing (pinned even when outside the visible window). Returns a
// clear unranked state when there is no active season or the user has no score
// yet, so the client never has to invent a fake number.
async function getRanked({ currentUserId, seasonModel = Season, seasonScoreModel = SeasonScore } = {}) {
  const season = await seasonModel.getActive();
  if (!season) {
    return { season: null, currentUser: null, ladder: [], tiers: TIER_SUMMARY };
  }

  const scores = await seasonScoreModel.listForSeason(season.id);
  const profiles = await getUserProfiles(scores.map((s) => s.userId));

  const ladder = scores.slice(0, LADDER_LIMIT).map((s, index) => ({
    rank: s.provisionalRank ?? index + 1,
    userId: s.userId,
    displayName: profiles.get(s.userId)?.displayName || "Anonymous",
    profilePhotoUrl: profiles.get(s.userId)?.profilePhotoUrl || null,
    points: s.points,
    tier: s.provisionalTier,
    division: s.provisionalDivision,
  }));

  const mine = scores.find((s) => s.userId === currentUserId);
  const currentUser = mine
    ? {
        rank: mine.provisionalRank,
        points: mine.points,
        tier: mine.provisionalTier,
        division: mine.provisionalDivision,
        ranked: true,
      }
    : { rank: null, points: 0, tier: null, division: null, ranked: false };

  return {
    season: { index: season.index, endsAt: season.endsAt, status: season.status },
    currentUser,
    ladder,
    tiers: TIER_SUMMARY,
  };
}

module.exports = { getRanked };
