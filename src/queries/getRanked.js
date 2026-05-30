const { prisma } = require("../db");
const { Season, SeasonScore } = require("../models/season");

const LADDER_LIMIT = 100;

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
    return { season: null, currentUser: null, ladder: [] };
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
  };
}

module.exports = { getRanked };
