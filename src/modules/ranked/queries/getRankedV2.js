// GET /ranked/v2 — the weekly-cohort ladder. Returns the caller's cohort (the
// ~30 people at their level this week), live placement with promotion/demotion
// zones, the full per-rank reward table for that cohort (server-driven so the
// client never hardcodes thresholds — the 1.2.0 checkpoint table taught us
// that), the 6-tier reference, and last week's settled result for the
// "you got promoted" moment.

const { prisma } = require("../../../db");
const {
  RankedWeek: defaultRankedWeek,
  RankedCohortMember: defaultRankedCohortMember,
} = require("../models/rankedWeek");
const { characterPresentation } = require("../../cosmetics");
const {
  V2_TIERS,
  DEFAULT_TIER,
  SETTLE_GRACE_HOURS,
  zoneSizes,
  placementReward,
} = require("../constants/rankedCohorts");
const { normalizeTier } = require("../services/rankedCohorts");

const TIER_SUMMARY = V2_TIERS.map((t) => ({
  key: t.key,
  label: t.label,
  promotionBonus: t.promotionBonus,
}));

const memberUserSelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  equippedAccessories: {
    include: {
      shopItem: {
        select: {
          id: true,
          sku: true,
          name: true,
          slot: true,
          assetKey: true,
          renderMetadata: true,
          bobble: true,
          testOnly: true,
          remoteOnly: true,
          assetVersion: true,
        },
      },
    },
  },
};

const compactMemberUserSelect = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
};

function settlesAt(week) {
  return new Date(
    new Date(week.endsOn).getTime() + SETTLE_GRACE_HOURS * 60 * 60 * 1000
  );
}

function zoneForRank(rank, size, tier) {
  if (!rank) return null;
  const { promote, demote } = zoneSizes(size, tier);
  if (rank <= promote) return "PROMOTION";
  if (rank > size - demote) return "DEMOTION";
  return "HOLD";
}

async function getUserProfiles(
  userIds,
  supportsCharacters = false,
  supportsRemoteAssets = false,
  compact = false
) {
  if (userIds.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: compact ? compactMemberUserSelect : memberUserSelect,
  });
  return new Map(
    users.map((u) => [
      u.id,
      (() => {
        // {animal, accessories} — naked capy for viewers without `characters`.
        const { animal, accessories } = compact
          ? { animal: undefined, accessories: undefined }
          : characterPresentation(
              u,
              supportsCharacters,
              "prod",
              supportsRemoteAssets
            );
        return {
          displayName: u.displayName || "Anonymous",
          profilePhotoUrl: u.profilePhotoUrl || null,
          equippedAccessories: accessories,
          animal,
        };
      })(),
    ])
  );
}

// The caller's most recently settled week, for the post-settlement banner.
async function getLastSettledResult(userId) {
  const last = await prisma.rankedCohortMember.findFirst({
    where: { userId, outcome: { not: null }, week: { status: "CLOSED" } },
    orderBy: { week: { index: "desc" } },
    include: { week: { select: { index: true } } },
  });
  if (!last) return null;
  // Cohort size so the client can render "Nth of M" without a second request.
  const cohortSize = await prisma.rankedCohortMember.count({
    where: { cohortId: last.cohortId },
  });
  return {
    weekIndex: last.week.index,
    finalRank: last.finalRank,
    tier: last.tier,
    resultTier: last.resultTier,
    outcome: last.outcome,
    rewardCoins: last.rewardCoins || 0,
    promotionCoins: last.promotionCoins || 0,
    cohortSize,
    // Drives the post-settlement summary popup (app >= 1.3.7). NULL ack column
    // (old data / never acked) reads as unseen here; the backfill marked all
    // pre-existing settled weeks seen so only fresh settlements pop.
    resultsSeen: last.resultsSeenAt != null,
  };
}

async function getRankedV2({
  currentUserId,
  weekModel = defaultRankedWeek,
  memberModel = defaultRankedCohortMember,
  now = () => new Date(),
  supportsCharacters = false,
  supportsRemoteAssets = false,
  compact = false,
} = {}) {
  // During the Monday grace window the next week hasn't opened yet (it waits
  // for the prior week to settle — see computeRankedWeeks). getCurrent() is null
  // then, so fall back to the still-settling prior week to keep the tab live.
  const week =
    (await weekModel.getCurrent(now())) ||
    (await weekModel.getLatestUnclosed());
  const lastWeek = await getLastSettledResult(currentUserId);

  const user = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { rankedTierV2: true },
  });
  const homeTier = normalizeTier(user?.rankedTierV2 || DEFAULT_TIER);

  if (!week) {
    return {
      week: null,
      currentUser: { ranked: false, tier: homeTier, rank: null, weeklySteps: 0, zone: null },
      cohort: null,
      tiers: TIER_SUMMARY,
      lastWeek,
    };
  }

  const me = await memberModel.getForUser(week.id, currentUserId);
  const weekPayload = {
    index: week.index,
    startsOn: week.startsOn,
    endsOn: week.endsOn,
    settlesAt: settlesAt(week),
    status: week.status,
  };

  if (!me) {
    // Active week but the caller hasn't synced any steps yet — they'll be
    // placed by the next standings tick after their first sync.
    return {
      week: weekPayload,
      currentUser: { ranked: false, tier: homeTier, rank: null, weeklySteps: 0, zone: null },
      cohort: null,
      tiers: TIER_SUMMARY,
      lastWeek,
    };
  }

  const cohortMembers = await memberModel.listForCohort(me.cohortId);
  const size = cohortMembers.length;
  const tier = me.tier;
  const { promote, demote } = zoneSizes(size, tier);
  const profiles = await getUserProfiles(
    cohortMembers.map((m) => m.userId),
    supportsCharacters,
    supportsRemoteAssets,
    compact
  );

  const members = cohortMembers.map((m, index) => {
    const rank = m.provisionalRank ?? index + 1;
    const member = {
      rank,
      userId: m.userId,
      displayName: profiles.get(m.userId)?.displayName || "Anonymous",
      profilePhotoUrl: profiles.get(m.userId)?.profilePhotoUrl || null,
      weeklySteps: m.weeklySteps,
      zone: zoneForRank(rank, size, tier),
    };
    if (!compact) {
      member.equippedAccessories =
        profiles.get(m.userId)?.equippedAccessories || [];
    }
    return member;
  });

  const myRank = me.provisionalRank;
  const rewards = Array.from({ length: size }, (_, i) => ({
    rank: i + 1,
    coins: placementReward(i + 1, size, tier),
  }));

  return {
    week: weekPayload,
    currentUser: {
      ranked: true,
      tier,
      rank: myRank,
      weeklySteps: me.weeklySteps,
      zone: zoneForRank(myRank, size, tier),
      projectedCoins: myRank ? placementReward(myRank, size, tier) : 0,
    },
    cohort: {
      id: me.cohortId,
      tier,
      size,
      promoteCount: promote,
      demoteCount: demote,
      members,
      rewards,
    },
    tiers: TIER_SUMMARY,
    lastWeek,
  };
}

module.exports = { getRankedV2 };
