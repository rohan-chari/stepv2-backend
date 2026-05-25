const { prisma: defaultPrisma } = require("../db");
const { buildAccessoriesList } = require("../utils/shopCosmetics");

const USER_SELECT = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  equippedAccessories: {
    select: {
      slot: true,
      shopItem: { select: { id: true, sku: true, slot: true, renderMetadata: true } },
    },
  },
};

const FRIEND_FINISHED_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

function serializeUser(user) {
  if (!user) return null;
  return {
    userId: user.id,
    displayName: user.displayName || "Anonymous",
    profilePhotoUrl: user.profilePhotoUrl || null,
    accessories: buildAccessoriesList(user),
  };
}

async function getAcceptedFriendIds(prisma, userId) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: "ACCEPTED",
      OR: [{ requesterId: userId }, { addresseeId: userId }],
    },
    select: { requesterId: true, addresseeId: true },
  });
  const ids = new Set();
  for (const f of friendships) {
    ids.add(f.requesterId === userId ? f.addresseeId : f.requesterId);
  }
  return [...ids];
}

async function checkPendingInvite(prisma, userId, now) {
  const invites = await prisma.raceParticipant.findMany({
    where: {
      userId,
      status: "INVITED",
      race: { status: "PENDING" },
      OR: [
        { inviteExpiresAt: null },
        { inviteExpiresAt: { gt: now } },
      ],
    },
    include: {
      race: {
        include: {
          creator: { select: USER_SELECT },
          participants: {
            select: { id: true, status: true },
          },
        },
      },
    },
    // Nulls last so explicitly-expiring invites surface before legacy ones.
    orderBy: [{ inviteExpiresAt: "asc" }, { joinedAt: "asc" }],
  });

  if (invites.length === 0) return null;

  const primary = invites[0];
  const race = primary.race;

  return {
    state: "PENDING_INVITE",
    pendingInviteCount: invites.length,
    data: {
      raceId: race.id,
      name: race.name,
      durationHours: race.maxDurationDays ? race.maxDurationDays * 24 : null,
      participantCount: race.participants.length,
      inviter: serializeUser(race.creator),
      expiresAt: primary.inviteExpiresAt,
    },
  };
}

async function checkActiveRace(prisma, userId) {
  const myActive = await prisma.raceParticipant.findFirst({
    where: {
      userId,
      status: "ACCEPTED",
      race: { status: "ACTIVE" },
    },
    include: {
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            include: { user: { select: USER_SELECT } },
            orderBy: { totalSteps: "desc" },
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
  });

  if (!myActive) return null;

  const race = myActive.race;
  const sorted = race.participants;
  const me = sorted.find((p) => p.userId === userId);
  const leader = sorted[0];
  const others = sorted
    .filter((p) => p.userId !== userId && p.userId !== leader?.userId)
    .slice(0, 2);

  let gapText = null;
  if (me && leader && leader.userId !== userId) {
    const gap = leader.totalSteps - me.totalSteps;
    gapText = `${gap.toLocaleString()} steps behind ${leader.user.displayName || "the leader"}`;
  } else if (me && sorted.length > 1) {
    const next = sorted[1];
    const gap = me.totalSteps - (next?.totalSteps || 0);
    gapText = gap > 0 ? `${gap.toLocaleString()} steps ahead — keep going` : "Tied for the lead";
  } else if (me) {
    gapText = "Leading the race";
  }

  function buildEntry(p) {
    return {
      rank: sorted.indexOf(p) + 1,
      totalSteps: p.totalSteps,
      ...serializeUser(p.user),
    };
  }

  return {
    state: "ACTIVE_RACE",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      me: me ? buildEntry(me) : null,
      leader: leader ? buildEntry(leader) : null,
      others: others.map(buildEntry),
    },
  };
}

async function checkFriendRacing(prisma, userId, friendIds) {
  if (friendIds.length === 0) return null;

  const friendParticipations = await prisma.raceParticipant.findMany({
    where: {
      userId: { in: friendIds },
      status: "ACCEPTED",
      // Hide friend-racing cards driven by review/demo accounts.
      user: { isReviewAccount: false },
      race: {
        status: "ACTIVE",
        isPublic: true,
        creator: { isReviewAccount: false },
        participants: { none: { userId, status: { in: ["ACCEPTED", "INVITED"] } } },
      },
    },
    include: {
      user: { select: USER_SELECT },
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            include: { user: { select: USER_SELECT } },
            orderBy: { totalSteps: "desc" },
            take: 4,
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
  });

  if (friendParticipations.length === 0) return null;

  // Pick the first valid one whose race still has room.
  const choice = friendParticipations.find(
    (fp) => fp.race.participants.length < fp.race.maxParticipants
  );
  if (!choice) return null;

  const race = choice.race;
  return {
    state: "FRIEND_RACING",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      isPublicJoinable: true,
      friend: serializeUser(choice.user),
      participants: race.participants.map((p, idx) => ({
        rank: idx + 1,
        totalSteps: p.totalSteps,
        ...serializeUser(p.user),
      })),
    },
  };
}

async function checkFriendFinished(prisma, userId, friendIds, now) {
  if (friendIds.length === 0) return null;

  const cutoff = new Date(now.getTime() - FRIEND_FINISHED_WINDOW_MS);

  const finishers = await prisma.raceParticipant.findMany({
    where: {
      userId: { in: friendIds },
      status: "ACCEPTED",
      placement: { in: [1, 2, 3] },
      race: { status: "COMPLETED", completedAt: { gte: cutoff } },
    },
    include: {
      user: { select: USER_SELECT },
      race: { select: { id: true, name: true, completedAt: true } },
    },
    orderBy: { race: { completedAt: "desc" } },
    take: 1,
  });

  if (finishers.length === 0) return null;
  const finisher = finishers[0];

  return {
    state: "FRIEND_FINISHED",
    data: {
      friend: serializeUser(finisher.user),
      raceName: finisher.race.name,
      placement: finisher.placement,
      finishedAt: finisher.race.completedAt,
    },
  };
}

async function checkPublicRace(prisma, userId) {
  // Active public races the user isn't already in. Prefer DAILY_10K, then WEEKLY_50K, then anything.
  const candidates = await prisma.race.findMany({
    where: {
      status: "ACTIVE",
      isPublic: true,
      // Hide demo-seeded races from real users' home suggestions.
      creator: { isReviewAccount: false },
      participants: { none: { userId, status: { in: ["ACCEPTED", "INVITED"] } } },
    },
    include: {
      seed: { select: { kind: true } },
      _count: { select: { participants: { where: { status: "ACCEPTED" } } } },
    },
    orderBy: { startedAt: "asc" },
    take: 25,
  });

  if (candidates.length === 0) return null;

  // Filter out full races, then rank by seed preference.
  const joinable = candidates.filter(
    (r) => r._count.participants < r.maxParticipants
  );
  if (joinable.length === 0) return null;

  const seedRank = { DAILY_10K: 0, WEEKLY_50K: 1 };
  joinable.sort((a, b) => {
    const aRank = a.seed ? (seedRank[a.seed.kind] ?? 2) : 3;
    const bRank = b.seed ? (seedRank[b.seed.kind] ?? 2) : 3;
    return aRank - bRank;
  });

  const race = joinable[0];

  return {
    state: "PUBLIC_RACE",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      participantCount: race._count.participants,
      seedKind: race.seed?.kind || null,
    },
  };
}

function buildGetHomeRaceCard(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const nowFn = dependencies.now || (() => new Date());

  return async function getHomeRaceCard({ userId }) {
    const now = nowFn();

    const pending = await checkPendingInvite(prisma, userId, now);
    if (pending) return pending;

    const active = await checkActiveRace(prisma, userId);
    if (active) return active;

    const friendIds = await getAcceptedFriendIds(prisma, userId);

    const friendRacing = await checkFriendRacing(prisma, userId, friendIds);
    if (friendRacing) return friendRacing;

    const friendFinished = await checkFriendFinished(prisma, userId, friendIds, now);
    if (friendFinished) return friendFinished;

    const publicRace = await checkPublicRace(prisma, userId);
    if (publicRace) return publicRace;

    return { state: "EMPTY", data: {} };
  };
}

const getHomeRaceCard = buildGetHomeRaceCard();

module.exports = { buildGetHomeRaceCard, getHomeRaceCard };
