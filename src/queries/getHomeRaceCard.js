const { prisma: defaultPrisma } = require("../db");
const { buildAccessoriesList } = require("../utils/shopCosmetics");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../services/raceStateResolution");

// Max number of active races returned in the new ACTIVE_RACES (opt-in) state.
const MAX_ACTIVE_RACES = 5;

const USER_SELECT = {
  id: true,
  displayName: true,
  profilePhotoUrl: true,
  equippedAccessories: {
    select: {
      slot: true,
      // assetKey is what the client uses to resolve the cosmetic PNG; including
      // it lets capybara renders show real equipped cosmetics. Additive only —
      // existing fields are unchanged, so older clients are unaffected.
      shopItem: { select: { id: true, sku: true, slot: true, assetKey: true, renderMetadata: true } },
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

// Deterministic placement order, mirrors compareParticipantsForPlacement in
// getRaces.js: finished first (by placement/finish time), then by steps desc,
// then earliest join, then userId. Kept local so this query stays self-contained.
function compareParticipantsForPlacement(left, right) {
  if (left.finishedAt && right.finishedAt) {
    const leftPlacement = left.placement ?? Number.MAX_SAFE_INTEGER;
    const rightPlacement = right.placement ?? Number.MAX_SAFE_INTEGER;
    if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement;
    const lf = new Date(left.finishedAt).getTime();
    const rf = new Date(right.finishedAt).getTime();
    if (lf !== rf) return lf - rf;
  }
  if (left.finishedAt) return -1;
  if (right.finishedAt) return 1;
  const stepDiff = (right.totalSteps || 0) - (left.totalSteps || 0);
  if (stepDiff !== 0) return stepDiff;
  const lj = left.joinedAt ? new Date(left.joinedAt).getTime() : 0;
  const rj = right.joinedAt ? new Date(right.joinedAt).getTime() : 0;
  if (lj !== rj) return lj - rj;
  return String(left.userId || "").localeCompare(String(right.userId || ""));
}

// Opt-in (new app builds) only: return ALL of the user's active races as a list
// so the home page can render a horizontally-scrollable row of cards. Each race
// carries its top-3 participants (with equipped cosmetics) and the viewer's own
// placement. Stealth redaction matches getRaceProgress.js: a stealthed racer
// (not self, not finished) is shown as "???" with no cosmetics and null steps.
//
// BACKWARD COMPAT: this path is ONLY reached when the client opts in via the
// `homeActiveRaces` flag. Old app builds never send it, so they keep receiving
// the legacy single-state response (see buildGetHomeRaceCard). When an opted-in
// user has zero active races this returns null and we fall through to the
// existing single-state logic (invites / public / friend prompts).
async function checkActiveRaces(prisma, userId, options = {}) {
  const {
    timeZone = "UTC",
    now = new Date(),
    stepsModel = Steps,
    stepSampleModel = StepSample,
    raceActiveEffectModel = RaceActiveEffect,
  } = options;

  const myActive = await prisma.raceParticipant.findMany({
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
    take: MAX_ACTIVE_RACES,
  });

  if (!myActive || myActive.length === 0) return null;

  const races = [];
  for (const participation of myActive) {
    const race = participation.race;
    if (!race) continue;

    // Compute each ACCEPTED participant's LIVE race-relative total using the
    // same side-effect-free helpers the race-detail screen relies on
    // (calculateBaseAdjusted + calculateCurrentTotal from raceStateResolution).
    // This is a READ-ONLY path: we never write total_steps, mark finishers,
    // complete races, emit events, or trigger trail mines. We only compute
    // totals for display so home and detail can't diverge.
    //
    // Finished racers are NOT recomputed — we use their frozen finishTotalSteps
    // (falling back to the live total) exactly as getRaceProgress /
    // raceStateResolution treat finishers.
    const liveTotals = new Map(); // participant.id -> live total
    if (race.startedAt) {
      await Promise.all(
        race.participants.map(async (p) => {
          if (p.finishedAt) {
            liveTotals.set(p.id, p.finishTotalSteps ?? p.totalSteps ?? 0);
            return;
          }
          const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
            participant: p,
            raceStartedAt: race.startedAt,
            timeZone,
            stepsModel,
            stepSampleModel,
            now,
          });
          const { total } = await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant: p,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel,
            stepSampleModel,
          });
          liveTotals.set(p.id, total);
        })
      );
    } else {
      // No startedAt: cannot window steps; fall back to cached totals so we
      // still render a card rather than crash (defensive).
      for (const p of race.participants) {
        liveTotals.set(
          p.id,
          p.finishedAt ? p.finishTotalSteps ?? p.totalSteps ?? 0 : p.totalSteps ?? 0
        );
      }
    }

    // Project the live totals onto each participant so placement ranking and
    // top-3 step display both read from the same live source. finishedAt is
    // preserved so finishers still sort ahead of unfinished racers.
    const liveParticipants = race.participants.map((p) => ({
      ...p,
      totalSteps: liveTotals.get(p.id) ?? 0,
    }));

    // Sort participants for placement (deterministic, matches getRaces) using
    // the LIVE totals.
    const ranked = [...liveParticipants].sort(compareParticipantsForPlacement);

    // Determine stealthed user ids for this race (only when powerups enabled).
    const stealthedUserIds = new Set();
    if (race.powerupsEnabled) {
      const activeEffects = await raceActiveEffectModel.findActiveForRace(race.id);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") stealthedUserIds.add(e.targetUserId);
      }
    }

    const top3 = ranked.slice(0, 3).map((p, idx) => {
      // Never stealth self or finished racers (mirrors getRaceProgress).
      const isStealthed =
        stealthedUserIds.has(p.userId) &&
        p.userId !== userId &&
        !p.finishedAt;
      return {
        rank: idx + 1,
        userId: p.userId,
        displayName: isStealthed ? "???" : (p.user?.displayName || "Anonymous"),
        equippedAccessories: isStealthed ? [] : buildAccessoriesList(p.user),
        totalSteps: isStealthed ? null : p.totalSteps,
        isStealthed,
      };
    });

    const myIndex = ranked.findIndex((p) => p.userId === userId);
    const userPlacement = myIndex >= 0 ? myIndex + 1 : null;

    races.push({
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      top3,
      userPlacement,
    });
  }

  if (races.length === 0) return null;

  return { state: "ACTIVE_RACES", data: { races } };
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
  // Step-source models for the live-computation path in checkActiveRaces.
  // Injectable for tests; default to the shared singletons in prod.
  const stepsModel = dependencies.Steps || Steps;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const raceActiveEffectModel = dependencies.RaceActiveEffect || RaceActiveEffect;

  return async function getHomeRaceCard({
    userId,
    homeActiveRaces = false,
    timeZone = "UTC",
  }) {
    const now = nowFn();

    const pending = await checkPendingInvite(prisma, userId, now);
    if (pending) return pending;

    // Opt-in path (new app builds): when the client requests homeActiveRaces and
    // the user has >=1 active race, return the new ACTIVE_RACES list state. When
    // the opted-in user has NO active races, checkActiveRaces returns null and we
    // fall through to the legacy single-state logic below. Old clients never set
    // this flag, so they always get the legacy ACTIVE_RACE single-card response
    // (byte-for-byte unchanged).
    if (homeActiveRaces) {
      const activeRaces = await checkActiveRaces(prisma, userId, {
        timeZone,
        now,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
      });
      if (activeRaces) return activeRaces;
    } else {
      const active = await checkActiveRace(prisma, userId);
      if (active) return active;
    }

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
