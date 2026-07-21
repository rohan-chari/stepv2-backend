const { prisma } = require("../../db");
const {
  buildRaceRecordLeaderboard,
} = require("./recordLeaderboardRankings");
const { getMondayOfWeek, getTimeZoneParts } = require("../../shared/time/week");
const { characterPresentation } = require("../cosmetics");
const { Friendship } = require("../social");

// Resolve the userId filter for a "friends"-scoped leaderboard: the viewer's
// accepted friends PLUS the viewer themself (so they always see their own rank).
// Returns null for the default "global" scope so callers skip the id filter and
// behave byte-for-byte as before the scope param existed.
async function resolveFriendsIdSet(scope, currentUserId) {
  if (scope !== "friends") return null;
  const friendIds = await Friendship.findAcceptedFriendIds(prisma, currentUserId);
  return [...new Set([...friendIds, currentUserId])];
}

// Identity + equipped capybara gear for rendering a leaderboard row.
const leaderboardUserSelect = {
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
        },
      },
    },
  },
};

function getDateBoundary(period, timeZone) {
  const now = new Date();
  const parts = getTimeZoneParts(now, timeZone);

  switch (period) {
    case "today": {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }
    case "week": {
      return getMondayOfWeek(now, timeZone);
    }
    case "month": {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
    }
    case "allTime": {
      return null;
    }
    default: {
      return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    }
  }
}

async function getUserProfiles(userIds, supportsCharacters = false) {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: leaderboardUserSelect,
  });

  return new Map(
    users.map((user) => [
      user.id,
      (() => {
        // {animal, accessories} — naked capy for viewers without `characters`.
        const { animal, accessories } = characterPresentation(
          user,
          supportsCharacters
        );
        return {
          displayName: user.displayName || "Anonymous",
          profilePhotoUrl: user.profilePhotoUrl || null,
          equippedAccessories: accessories,
          animal,
        };
      })(),
    ])
  );
}

async function getCurrentUserProfile(currentUserId) {
  const currentUserData = await prisma.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true, profilePhotoUrl: true },
  });

  return {
    displayName: currentUserData?.displayName || "Anonymous",
    profilePhotoUrl: currentUserData?.profilePhotoUrl || null,
  };
}

async function getStepLeaderboard(period, currentUserId, timeZone, scope = "global", supportsCharacters = false) {
  const dateBoundary = getDateBoundary(period, timeZone);
  const dateClause = dateBoundary
    ? { date: { gte: new Date(dateBoundary) } }
    : {};
  // friends scope: restrict to the viewer + accepted friends. global (default)
  // leaves this null so the query is unfiltered, exactly as before.
  const friendsIdSet = await resolveFriendsIdSet(scope, currentUserId);
  const friendClause = friendsIdSet ? { userId: { in: friendsIdSet } } : {};
  // friendsIdSet is null only for the default GLOBAL scope.
  const isGlobalScope = friendsIdSet === null;
  // Hide review/demo accounts from real users' public leaderboards. On the
  // GLOBAL board additionally hide users who opted out via
  // hiddenFromLeaderboard. The FRIENDS board intentionally keeps hidden users
  // visible ("hidden only from strangers"), and the self-rank fallback below is
  // left unfiltered so a hidden user still sees their OWN global rank.
  const whereClause = {
    ...dateClause,
    ...friendClause,
    user: isGlobalScope
      ? { isReviewAccount: false, hiddenFromLeaderboard: false }
      : { isReviewAccount: false },
  };

  const top100Groups = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    orderBy: { _sum: { steps: "desc" } },
    take: 100,
  });

  const userMap = await getUserProfiles(
    top100Groups.map((group) => group.userId),
    supportsCharacters
  );

  let prevRank = 0;
  let prevSteps = null;
  const top100 = top100Groups.map((group, index) => {
    const totalSteps = group._sum.steps || 0;
    const rank = totalSteps === prevSteps ? prevRank : index + 1;
    prevRank = rank;
    prevSteps = totalSteps;

    return {
      rank,
      userId: group.userId,
      displayName: userMap.get(group.userId)?.displayName || "Anonymous",
      profilePhotoUrl: userMap.get(group.userId)?.profilePhotoUrl || null,
      equippedAccessories: userMap.get(group.userId)?.equippedAccessories || [],
      totalSteps,
    };
  });

  // Backward-compat: ship both top10/inTop10 (consumed by 1.1.4 FE) and
  // top100/inTop100 (1.1.5 FE) so prod backend can be deployed before the
  // new FE rolls out. Drop the aliases once 1.1.4 is out of the wild.
  const top10 = top100.slice(0, 10);
  const currentUserInTop100 = top100.find((entry) => entry.userId === currentUserId);
  const currentUserInTop10 = top10.find((entry) => entry.userId === currentUserId);
  if (currentUserInTop100) {
    return {
      top10,
      top100,
      currentUser: {
        rank: currentUserInTop100.rank,
        displayName: currentUserInTop100.displayName,
        totalSteps: currentUserInTop100.totalSteps,
        inTop10: Boolean(currentUserInTop10),
        inTop100: true,
      },
    };
  }

  const currentUserAgg = await prisma.step.aggregate({
    _sum: { steps: true },
    where: { userId: currentUserId, ...dateClause },
  });
  const currentUserSteps = currentUserAgg._sum.steps || 0;

  const usersAbove = await prisma.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    having: { steps: { _sum: { gt: currentUserSteps } } },
  });

  const currentUserProfile = await getCurrentUserProfile(currentUserId);

  return {
    top10,
    top100,
    currentUser: {
      rank: usersAbove.length + 1,
      displayName: currentUserProfile.displayName,
      profilePhotoUrl: currentUserProfile.profilePhotoUrl,
      totalSteps: currentUserSteps,
      inTop10: false,
      inTop100: false,
    },
  };
}

async function getRaceLeaderboard(currentUserId, scope = "global", supportsCharacters = false) {
  // friends scope: restrict to the viewer + accepted friends. global (default)
  // leaves this null so the query is unfiltered, exactly as before.
  const friendsIdSet = await resolveFriendsIdSet(scope, currentUserId);
  const friendClause = friendsIdSet ? { userId: { in: friendsIdSet } } : {};

  const completedParticipants = await prisma.raceParticipant.findMany({
    where: {
      ...friendClause,
      status: "ACCEPTED",
      race: { status: "COMPLETED" },
      // Hide review/demo accounts from real users' public records board.
      user: { isReviewAccount: false },
    },
    select: {
      userId: true,
      placement: true,
    },
  });

  const statsByUserId = new Map();

  function ensureRecord(userId) {
    if (!statsByUserId.has(userId)) {
      statsByUserId.set(userId, { firsts: 0, seconds: 0, thirds: 0 });
    }
    return statsByUserId.get(userId);
  }

  for (const participant of completedParticipants) {
    const record = ensureRecord(participant.userId);
    if (participant.placement === 1) {
      record.firsts += 1;
    } else if (participant.placement === 2) {
      record.seconds += 1;
    } else if (participant.placement === 3) {
      record.thirds += 1;
    }
  }

  const userIds = [...statsByUserId.keys(), currentUserId];
  const userMap = await getUserProfiles(userIds, supportsCharacters);
  const currentUserDisplayName =
    userMap.get(currentUserId)?.displayName || "Anonymous";

  const entries = [...statsByUserId.entries()].map(([userId, record]) => ({
    userId,
    displayName: userMap.get(userId)?.displayName || "Anonymous",
    profilePhotoUrl: userMap.get(userId)?.profilePhotoUrl || null,
    firsts: record.firsts,
    seconds: record.seconds,
    thirds: record.thirds,
  }));

  return buildRaceRecordLeaderboard(entries, currentUserId, currentUserDisplayName);
}

async function getLeaderboard({ type = "steps", period = "today", scope = "global", currentUserId, timeZone, supportsCharacters = false }) {
  if (type === "races") {
    return getRaceLeaderboard(currentUserId, scope, supportsCharacters);
  }

  return getStepLeaderboard(period, currentUserId, timeZone, scope, supportsCharacters);
}

module.exports = { getLeaderboard };
