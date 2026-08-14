const { prisma } = require("../../db");
const {
  buildRaceRecordLeaderboard,
} = require("./recordLeaderboardRankings");
const { getMondayOfWeek, getTimeZoneParts } = require("../../shared/time/week");
const { characterPresentation } = require("../cosmetics");
const { Friendship } = require("../social");
const { appSettings: defaultAppSettings } = require("../../shared/config/appSettings");
const { buildLeaderboardEligibilityEpoch } = require("../../shared/config/leaderboardEligibilityEpoch");
const cacheKeys = require("../../shared/cache/cacheKeys");
const stepLeaderboardCache = require("./services/stepLeaderboardCache");
const friendsTopologyCache = require("../social/services/friendsTopologyCache");
const userPresentationCache = require("../social/services/userPresentationCache");

// Resolve the userId filter for a "friends"-scoped leaderboard: the viewer's
// accepted friends PLUS the viewer themself (so they always see their own rank).
// Returns null for the default "global" scope so callers skip the id filter and
// behave byte-for-byte as before the scope param existed.
async function resolveFriendsIdSet(scope, currentUserId, db = prisma) {
  if (scope !== "friends") return null;
  const friendIds = await Friendship.findAcceptedFriendIds(db, currentUserId);
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
          remoteOnly: true,
          assetVersion: true,
        },
      },
    },
  },
};

function getDateBoundary(period, timeZone, anchoredNow = new Date()) {
  const now = anchoredNow;
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

async function getUserProfiles(
  userIds,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  db = prisma
) {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await db.user.findMany({
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
          supportsCharacters,
          releaseChannel,
          supportsRemoteAssets
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

async function getCurrentUserProfile(currentUserId, db = prisma) {
  const currentUserData = await db.user.findUnique({
    where: { id: currentUserId },
    select: { displayName: true, profilePhotoUrl: true },
  });

  return {
    displayName: currentUserData?.displayName || "Anonymous",
    profilePhotoUrl: currentUserData?.profilePhotoUrl || null,
  };
}

async function getStepLeaderboard(
  period,
  currentUserId,
  timeZone,
  scope = "global",
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  db = prisma
) {
  const dateBoundary = getDateBoundary(period, timeZone);
  const dateClause = dateBoundary
    ? { date: { gte: new Date(dateBoundary) } }
    : {};
  // friends scope: restrict to the viewer + accepted friends. global (default)
  // leaves this null so the query is unfiltered, exactly as before.
  const friendsIdSet = await resolveFriendsIdSet(scope, currentUserId, db);
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

  const top100Groups = await db.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    orderBy: { _sum: { steps: "desc" } },
    take: 100,
  });

  const userMap = await getUserProfiles(
    top100Groups.map((group) => group.userId),
    supportsCharacters,
    releaseChannel,
    supportsRemoteAssets,
    db
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

  const currentUserAgg = await db.step.aggregate({
    _sum: { steps: true },
    where: { userId: currentUserId, ...dateClause },
  });
  const currentUserSteps = currentUserAgg._sum.steps || 0;

  const usersAbove = await db.step.groupBy({
    by: ["userId"],
    _sum: { steps: true },
    where: whereClause,
    having: { steps: { _sum: { gt: currentUserSteps } } },
  });

  const currentUserProfile = await getCurrentUserProfile(currentUserId, db);

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

async function getRaceLeaderboard(
  currentUserId,
  scope = "global",
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  db = prisma
) {
  // friends scope: restrict to the viewer + accepted friends. global (default)
  // leaves this null so the query is unfiltered, exactly as before.
  const friendsIdSet = await resolveFriendsIdSet(scope, currentUserId, db);
  const friendClause = friendsIdSet ? { userId: { in: friendsIdSet } } : {};

  const completedParticipants = await db.raceParticipant.findMany({
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
  const userMap = await getUserProfiles(
    userIds,
    supportsCharacters,
    releaseChannel,
    supportsRemoteAssets,
    db
  );
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

function rankGroups(groups) {
  let previousRank = 0;
  let previousSteps = null;
  return groups.map((group, index) => {
    const totalSteps = group._sum.steps || 0;
    const rank = totalSteps === previousSteps ? previousRank : index + 1;
    previousRank = rank;
    previousSteps = totalSteps;
    return { userId: group.userId, totalSteps, rank };
  });
}

function buildGetLeaderboard(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const settings = dependencies.appSettings || defaultAppSettings;
  const epoch = dependencies.leaderboardEligibilityEpoch ||
    buildLeaderboardEligibilityEpoch({ prisma: db });
  const rankingCache = dependencies.stepLeaderboardCache || stepLeaderboardCache;
  const topologyCache = dependencies.friendsTopologyCache || friendsTopologyCache;
  const presentationCache = dependencies.userPresentationCache || userPresentationCache;
  const clock = dependencies.now || (() => new Date());

  async function cacheEnabled() {
    try {
      const [guard, surface] = await Promise.all([
        settings.getFlag("redisPresentationGenerationGuardEnabled"),
        settings.getFlag("redisCacheLeaderboardEnabled"),
      ]);
      return guard === true && surface === true;
    } catch { return false; }
  }

  async function assemble(core, params) {
    const presentations = await presentationCache.getMany(
      core.rows.map((row) => row.userId), true
    );
    for (const row of core.rows) {
      const user = presentations.get(row.userId);
      if (!user || user.isReviewAccount ||
          (core.scope === "global" && user.hiddenFromLeaderboard)) {
        return { outcome: "invalid" };
      }
    }
    const top100 = core.rows.map((row) => {
      const user = presentations.get(row.userId);
      const { accessories } = characterPresentation(
        user,
        params.supportsCharacters,
        params.releaseChannel,
        params.supportsRemoteAssets
      );
      return {
        rank: row.rank,
        userId: row.userId,
        displayName: user.displayName || "Anonymous",
        profilePhotoUrl: user.profilePhotoUrl || null,
        equippedAccessories: accessories,
        totalSteps: row.totalSteps,
      };
    });
    const top10 = top100.slice(0, 10);
    const found = top100.find((row) => row.userId === params.currentUserId);
    if (found) {
      return { outcome: "assembled", value: {
        top10,
        top100,
        currentUser: {
          rank: found.rank,
          displayName: found.displayName,
          totalSteps: found.totalSteps,
          inTop10: top10.some((row) => row.userId === params.currentUserId),
          inTop100: true,
        },
      } };
    }
    // A global raw core deliberately has no viewer-specific scalar. Viewers
    // outside its top 100 take the complete legacy path, but the shared core is
    // valid and must not be rebuilt on every such request.
    if (core.scope === "global") return { outcome: "outside-global" };
    const currentProfile = await presentationCache.getMany([params.currentUserId], true);
    const user = currentProfile.get(params.currentUserId);
    if (!user) return { outcome: "invalid" };
    return { outcome: "assembled", value: {
      top10,
      top100,
      currentUser: {
        rank: core.currentUser.rank,
        displayName: user.displayName || "Anonymous",
        profilePhotoUrl: user.profilePhotoUrl || null,
        totalSteps: core.currentUser.totalSteps,
        inTop10: false,
        inTop100: false,
      },
    } };
  }

  async function cachedSteps(params) {
    if (!(await cacheEnabled())) return null;
    let eligibilityEpoch;
    try { eligibilityEpoch = await epoch.get(); } catch { return null; }
    const anchoredNow = clock();
    const resolved = getDateBoundary(params.period, params.timeZone, anchoredNow);
    const boundary = resolved || "all";
    const dateClause = resolved ? { date: { gte: new Date(resolved) } } : {};
    let key;
    let friendIds = null;
    if (params.scope === "friends") {
      const topology = await topologyCache.get(params.currentUserId);
      friendIds = topology.accepted.map((item) => item.userId);
      key = cacheKeys.leaderboardFriends({
        viewerId: params.currentUserId,
        eligibilityEpoch,
        acceptedSetHash: cacheKeys.acceptedFriendSetHash(friendIds),
        period: params.period,
        boundary,
      });
    } else {
      key = cacheKeys.leaderboardGlobal({ eligibilityEpoch, period: params.period, boundary });
    }

    const load = async () => {
      const buildStartedAt = clock();
      const asOf = buildStartedAt;
      if (params.scope === "global") {
        const groups = await db.step.groupBy({
          by: ["userId"], _sum: { steps: true },
          where: { ...dateClause, user: { isReviewAccount: false, hiddenFromLeaderboard: false } },
          orderBy: { _sum: { steps: "desc" } }, take: 100,
        });
        return {
          version: 1, scope: "global", period: params.period, boundary,
          asOf: asOf.toISOString(), buildStartedAt: buildStartedAt.toISOString(),
          rows: rankGroups(groups),
        };
      }
      const participantIds = [...new Set([...friendIds, params.currentUserId])];
      return db.$transaction(async (tx) => {
        const [groups, viewerAggregate] = await Promise.all([
          tx.step.groupBy({
            by: ["userId"], _sum: { steps: true },
            where: {
              ...dateClause,
              userId: { in: participantIds },
              user: { isReviewAccount: false },
            },
            orderBy: { _sum: { steps: "desc" } },
          }),
          // Legacy parity: review accounts are excluded from ranked rows, but
          // the viewer's own scalar is always their unfiltered step total.
          tx.step.aggregate({
            _sum: { steps: true },
            where: { userId: params.currentUserId, ...dateClause },
          }),
        ]);
        const ranked = rankGroups(groups);
        const current = ranked.find((row) => row.userId === params.currentUserId);
        const totalSteps = current?.totalSteps ?? (viewerAggregate._sum.steps || 0);
        const rank = current?.rank ?? (ranked.filter((row) => row.totalSteps > totalSteps).length + 1);
        return {
          version: 1, scope: "friends", period: params.period, boundary,
          asOf: asOf.toISOString(), buildStartedAt: buildStartedAt.toISOString(),
          rows: ranked.slice(0, 100),
          currentUser: { rank, totalSteps },
        };
      }, { isolationLevel: "RepeatableRead" });
    };

    const request = { key, scope: params.scope, period: params.period, boundary, load };
    const core = await rankingCache.getOrLoad(request);
    if (!core) return null;
    const assembly = await assemble(core, params);
    if (assembly.outcome === "invalid") rankingCache.rebuildSafe?.(request);
    return assembly.outcome === "assembled" ? assembly.value : null;
  }

  return async function getLeaderboard(params) {
    const { type = "steps", period = "today", scope = "global", currentUserId,
      timeZone, supportsCharacters = false, releaseChannel = "prod",
      supportsRemoteAssets = false } = params;
    if (type === "races") {
      return getRaceLeaderboard(currentUserId, scope, supportsCharacters, releaseChannel, supportsRemoteAssets, db);
    }
    const cached = await cachedSteps({ period, scope, currentUserId, timeZone,
      supportsCharacters, releaseChannel, supportsRemoteAssets });
    if (cached) return cached;
    return getStepLeaderboard(period, currentUserId, timeZone, scope,
      supportsCharacters, releaseChannel, supportsRemoteAssets, db);
  };
}

const getLeaderboard = buildGetLeaderboard();

/* legacy public behavior remains the fallback for every cache doubt */
async function legacyGetLeaderboard({ type = "steps", period = "today", scope = "global", currentUserId, timeZone, supportsCharacters = false, releaseChannel = "prod", supportsRemoteAssets = false }) {
  if (type === "races") {
    return getRaceLeaderboard(
      currentUserId,
      scope,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
  }

  return getStepLeaderboard(
    period,
    currentUserId,
    timeZone,
    scope,
    supportsCharacters,
    releaseChannel,
    supportsRemoteAssets
  );
}

module.exports = { getLeaderboard, buildGetLeaderboard, legacyGetLeaderboard };
