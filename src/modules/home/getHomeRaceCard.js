const { prisma: defaultPrisma } = require("../../db");
const { characterPresentation } = require("../cosmetics");
const { compareParticipantsForPlacement } = require("../races/placementOrder");
const { RaceActiveEffect } = require("../powerups/models/raceActiveEffect");
const { Steps } = require("../steps/models/steps");
const { StepSample } = require("../steps/models/stepSample");
const {
  POWERUP_EFFECT_TYPES,
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("../races/services/raceStateResolution");
const { prorateSamplesIntoWindow } = require("../steps/models/stepSample");
const { raceTimeZone } = require("../races/raceTimeZone");
const {
  buildTeamsBlock,
  buildTeamsBlockFromParticipants,
} = require("../races/teamRaces");
const { applyLeechTransfers } = require("../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../powerups/hitchhikeCopies");
const defaultRaceProgressSnapshot = require("../races/services/raceProgressSnapshot");
const defaultRaceProgressPageProjection = require("../races/services/raceProgressPageProjection");
const {
  RaceResolutionJobV2: defaultRaceResolutionJobV2,
} = require("../races/models/raceResolutionJobV2");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../races/racePrizePool");
const {
  serializeTeamPayoutStamp,
} = require("../races/services/teamWinnerReward");
const {
  buildViewerDisplayPlacementMap,
} = require("../races/services/viewerDisplayPlacements");
const {
  homeLaunchReadBatch: defaultHomeLaunchReadBatch,
} = require("./services/homeLaunchReadBatch");
const {
  findLegacyPublicRaceCandidates,
} = require("../races/queries/publicRaceHomeCandidates");

// The effect types the home card must prefetch. LEECH is included (§5): once
// leech MINTS steps to the attacker, omitting it here made the home-card total
// disagree with race detail (the scoped effect model would either miss it or fall
// back to an N+1 per-participant query). Prefetching LEECH keeps the live home
// total identical to getRaceProgress.
const HOME_EFFECT_TYPES = [...POWERUP_EFFECT_TYPES, "LEECH"];

// Max number of active races returned in the new ACTIVE_RACES (opt-in) state.
const MAX_ACTIVE_RACES = 5;

function buildHomePlacementProjection({ ranked, effects, userId }) {
  const stealthedUserIds = new Set();
  let viewerIsDetoured = false;
  for (const effect of effects || []) {
    if (effect.type === "STEALTH_MODE") stealthedUserIds.add(effect.targetUserId);
    if (effect.type === "DETOUR_SIGN" && effect.targetUserId === userId) {
      viewerIsDetoured = true;
    }
  }
  const maskedUserIds = new Set(
    (ranked || [])
      .filter(
        (participant) =>
          viewerIsDetoured ||
          (participant.userId !== userId &&
            participant.finishedAt == null &&
            stealthedUserIds.has(participant.userId))
      )
      .map((participant) => participant.userId)
  );
  const displayPlacementByUserId = viewerIsDetoured
    ? new Map()
    : buildViewerDisplayPlacementMap(
        (ranked || []).map((participant, index) => ({
          userId: participant.userId,
          placement: participant.placement ?? index + 1,
        })),
        maskedUserIds
      );
  // The common case has no privacy masking, so the canonical ranking is
  // already the exact presentation order. Avoid sorting it again: the old
  // comparator called indexOf for every comparison, making each app open
  // quadratic in the race size (especially damaging for 10k-person events).
  const presentationOrder = maskedUserIds.size === 0
    ? (ranked || [])
    : (ranked || [])
        .map((participant, index) => ({ participant, index }))
        .sort((left, right) => {
          const leftMasked = maskedUserIds.has(left.participant.userId);
          const rightMasked = maskedUserIds.has(right.participant.userId);
          if (leftMasked !== rightMasked) return leftMasked ? -1 : 1;
          if (leftMasked) {
            return String(left.participant.userId).localeCompare(
              String(right.participant.userId)
            );
          }
          return left.index - right.index;
        })
        .map(({ participant }) => participant);
  return {
    displayPlacementByUserId,
    maskedUserIds,
    placementPrivacyActive: viewerIsDetoured || maskedUserIds.size > 0,
    presentationOrder,
    viewerIsDetoured,
  };
}

// The home card's duration label, in hours (spec §5.5).
//
// `maxDurationDays × 24` is only the true length while endsAt is derived from
// it. A custom-window race's persisted duration is the FLOORED day count, so
// that expression under-reports a 30h race as 24h. When the race has actually
// started, the stamped instants are the truth — use them. Otherwise (a PENDING
// invite, where endsAt is null by design) keep the existing expression exactly.
// Purely a label; home_tab.dart reads it defensively already.
function raceDurationHours(race) {
  if (race?.startedAt && race?.endsAt) {
    const ms = new Date(race.endsAt).getTime() - new Date(race.startedAt).getTime();
    if (Number.isFinite(ms) && ms > 0) return Math.round(ms / (60 * 60 * 1000));
  }
  return race?.maxDurationDays ? race.maxDurationDays * 24 : null;
}

function homeMoneyView(race, participants) {
  const rows = participants || [];
  const boundedAcceptedCount = Number(
    race?._acceptedCount ?? rows[0]?.totalCount,
  );
  const money = buildRaceMoneyView({
    race,
    participants: rows,
    acceptedCount: Number.isSafeInteger(boundedAcceptedCount) &&
      boundedAcceptedCount >= 0
      ? boundedAcceptedCount
      : rows.filter((row) => row.status === "ACCEPTED").length,
  });
  const { payouts, payoutTiers } = serializePayouts(money.payouts);
  return {
    ...serializeTeamPayoutStamp(race),
    buyInAmount: money.buyInAmount,
    potCoins: money.potCoins,
    heldPotCoins: money.heldPotCoins,
    projectedPotCoins: money.projectedPotCoins,
    prizePool: money.prizePool,
    payouts,
    payoutTiers,
    finishReward: money.finishReward,
  };
}

function pageProjectionEligibleForHome(race) {
  return Boolean(
    race &&
      race.isTeamRace !== true &&
      race.powerupsEnabled !== true &&
      Number(race.buyInAmount || 0) === 0 &&
      Number(race.potCoins || 0) === 0
  );
}

async function readBoundedHomeProjection({
  race,
  userId,
  timeZone,
  pageProjection,
}) {
  if (!pageProjectionEligibleForHome(race)) return null;
  const page = await pageProjection.readRaceProgressPageProjection({
    raceId: race.id,
    offset: 0,
    limit: 15,
    requesterUserId: userId,
    scoringTimeZone: raceTimeZone(race, timeZone),
  });
  if (!page || !page.index?.race) return null;
  const participants = [...page.rows];
  if (page.requesterRow && !participants.some((row) => row.userId === userId)) {
    participants.push(page.requesterRow);
  }
  return {
    v: 3,
    asOf: page.asOf,
    scoringTimeZone: page.index.scoringTimeZone,
    source: "page-projection",
    race: page.index.race,
    participants,
    activeEffects: [],
    teams: null,
    totalCount: page.total,
    requesterWasInPage: page.rows.some((row) => row.userId === userId),
    pageRowCount: page.rows.length,
    requesterSnapshotPlacement:
      page.requesterRow?.placement ??
      page.rows.find((row) => row.userId === userId)?.placement ??
      null,
  };
}

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
      shopItem: { select: { id: true, sku: true, slot: true, assetKey: true, renderMetadata: true, bobble: true, testOnly: true, remoteOnly: true, assetVersion: true } },
    },
  },
};

// The frozen home card ranks the whole field but renders at most four people.
// Keep the shared 10k-row read to only the scalars used by placement, money,
// and team math; presentation/cosmetic data is loaded for visible users below.
const LEGACY_HOME_PARTICIPANT_SELECT = {
  id: true,
  userId: true,
  status: true,
  totalSteps: true,
  rawSteps: true,
  placement: true,
  finishedAt: true,
  forfeitedAt: true,
  team: true,
  payoutCoins: true,
  buyInAmount: true,
  buyInStatus: true,
};

const PERSISTED_HOME_ACTIVE_SELECT = {
  id: true,
  userId: true,
  team: true,
  totalSteps: true,
  finishedAt: true,
  finishTotalSteps: true,
  race: {
    select: {
      id: true,
      name: true,
      startedAt: true,
      endsAt: true,
      timezone: true,
      powerupsEnabled: true,
      isTeamRace: true,
      teamSize: true,
      fundedPrize: true,
      payoutRoundingVersion: true,
      payoutPreset: true,
      payoutCurve: true,
      potCoins: true,
      buyInAmount: true,
      maxDurationDays: true,
      prizeCoinUnit: true,
      prizePoolMaxCoins: true,
      teamPoolMultBps: true,
      teamPayoutVersion: true,
      teamWinnerRewardCoins: true,
      creationSource: true,
      startPolicy: true,
      exitActionsEnabled: true,
      status: true,
    },
  },
};

function boundedPersistedHomeRace(race) {
  return Boolean(race && race.isTeamRace !== true &&
    race.powerupsEnabled !== true &&
    (race.fundedPrize !== true || race.exitActionsEnabled !== true) &&
    Number(race.buyInAmount || 0) === 0 && Number(race.potCoins || 0) === 0);
}

const FRIEND_FINISHED_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

function serializeUser(
  user,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
  if (!user) return null;
  return {
    userId: user.id,
    displayName: user.displayName || "Anonymous",
    profilePhotoUrl: user.profilePhotoUrl || null,
    // {animal, accessories} — naked capy for viewers without `characters`.
    ...characterPresentation(
      user,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    ),
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

async function checkPendingInvite(
  prisma,
  userId,
  now,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  launchReadBatch = null
) {
  const where = {
    userId,
    status: "INVITED",
    race: { status: "PENDING" },
    OR: [
      { inviteExpiresAt: null },
      { inviteExpiresAt: { gt: now } },
    ],
  };
  const select = {
      inviteExpiresAt: true,
      joinedAt: true,
      race: {
        select: {
          id: true,
          name: true,
          startedAt: true,
          endsAt: true,
          maxDurationDays: true,
          creator: { select: USER_SELECT },
          _count: { select: { participants: true } },
        },
      },
    };
  const invites = launchReadBatch
    ? await launchReadBatch.loadPendingInvites({ prisma, userId, now, select })
    : await prisma.raceParticipant.findMany({
        where,
        select,
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
      durationHours: raceDurationHours(race),
      participantCount:
        race._count?.participants ?? race.participants?.length ?? 0,
      inviter: serializeUser(
        race.creator,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      expiresAt: primary.inviteExpiresAt,
    },
  };
}

async function checkActiveRace(
  prisma,
  userId,
  supportsCharacters = false,
  supportsTeamRaces = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false,
  raceActiveEffectModel = RaceActiveEffect,
  privacySafeDisplayRanks = false,
  launchReadBatch = null,
) {
  const myActive = launchReadBatch
    ? await launchReadBatch.loadLegacyActiveRow({
        prisma,
        userId,
        supportsTeamRaces,
      })
    : await prisma.raceParticipant.findFirst({
    where: {
      userId,
      status: "ACCEPTED",
      race: {
        status: "ACTIVE",
        // Matchup races are never shown on the home card — only via the
        // tournament screen (§4).
        tournamentId: null,
        // TR-702: an old binary can't render a team race — it would draw one as
        // a broken individual race. Skip team races for those clients (they
        // fall through to the next home state). In practice unreachable: an old
        // client can neither create (TR-106) nor join (TR-703) a team race.
        ...(supportsTeamRaces ? {} : { isTeamRace: false }),
      },
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
  // TR-702 belt-and-braces: the query above already filters team races out for
  // tokenless clients; never serialize one even if that filter is bypassed.
  if (race.isTeamRace && !supportsTeamRaces) return null;
  if (launchReadBatch) {
    const boundedSimpleRace = race.isTeamRace !== true &&
      race.powerupsEnabled !== true &&
      (race.fundedPrize !== true || race.exitActionsEnabled !== true) &&
      Number(race.buyInAmount || 0) === 0 && Number(race.potCoins || 0) === 0;
    race.participants = boundedSimpleRace
      ? await launchReadBatch.loadBoundedLegacyRoster({
          prisma,
          raceId: race.id,
          userId,
        })
      : await launchReadBatch.loadAcceptedRoster({
          prisma,
          raceId: race.id,
          participantSelect: LEGACY_HOME_PARTICIPANT_SELECT,
        });
    if (boundedSimpleRace) {
      race._acceptedCount = Number(
        race.participants[0]?.totalCount || race.participants.length,
      );
    }
  }

  const sorted = race.participants;
  const effects = race.powerupsEnabled === true
    ? await raceActiveEffectModel.findActiveForRace(race.id)
    : [];
  const projection = buildHomePlacementProjection({
    ranked: sorted,
    effects,
    userId,
  });
  const me = sorted.find((p) => p.userId === userId);
  const leader = projection.presentationOrder[0];
  const others = projection.presentationOrder
    .filter((p) => p.userId !== userId && p.userId !== leader?.userId)
    .slice(0, 2);

  if (launchReadBatch) {
    const visible = [me, leader, ...others].filter(Boolean);
    const users = await launchReadBatch.loadUsers({
      prisma,
      userIds: visible.map((participant) => participant.userId),
      select: USER_SELECT,
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    for (const participant of visible) {
      participant.user = userById.get(participant.userId) || null;
    }
  }

  let gapText = null;
  if (me && leader && leader.userId !== userId) {
    const gap = leader.totalSteps - me.totalSteps;
    gapText = `${gap.toLocaleString()} steps behind ${leader.user.displayName || "the leader"}`;
  } else if (me && sorted.length > 1) {
    const next = sorted[1];
    const gap = me.totalSteps - (next?.totalSteps || 0);
    gapText = gap > 0 ? `${gap.toLocaleString()} steps ahead. Keep going` : "Tied for the lead";
  } else if (me) {
    gapText = "Leading the race";
  }

  function buildEntry(p) {
    const canonicalPlacement = Number(p.computedPlacement) || sorted.indexOf(p) + 1;
    const masked = projection.maskedUserIds.has(p.userId);
    return {
      rank:
        masked || (!privacySafeDisplayRanks && projection.placementPrivacyActive)
          ? null
          : canonicalPlacement,
      ...(privacySafeDisplayRanks
        ? {
            displayPlacement: masked
              ? null
              : projection.displayPlacementByUserId.get(p.userId) ?? null,
          }
        : {}),
      totalSteps: masked ? null : Math.max(0, Number(p.totalSteps) || 0),
      ...(masked
        ? {
            userId: p.userId,
            displayName: "???",
            profilePhotoUrl: null,
            animal: null,
            accessories: [],
          }
        : serializeUser(
            p.user,
            supportsCharacters,
            releaseChannel,
            supportsRemoteAssets
          )),
      isStealthed: masked,
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
      ...(privacySafeDisplayRanks
        ? { placementPrivacyActive: projection.placementPrivacyActive }
        : {}),
      ...homeMoneyView(race, sorted),
      // ── Team races (TR-809) — additive. The Home rail draws a compact
      // rope-knot scoreline ("Swift Capys 12,340 — 11,900 Turbo Beavers") from
      // the same canonical `teams` block the list + progress surfaces use.
      // Only ever present for token clients (gated above); individual races
      // keep the byte-identical legacy shape.
      ...(race.isTeamRace
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam: me?.team ?? null,
            teams: buildTeamsBlockFromParticipants(race, sorted),
          }
        : {}),
    },
  };
}

// Cross-participant prefetch: pull step samples, daily rows, and powerup
// effects for ALL participants of ALL the user's active races in three bulk
// queries, then hand the per-participant math (calculateBaseAdjusted /
// calculateCurrentTotal) scoped in-memory models with the SAME interface. The
// helpers run unchanged — same windows, same proration, same rounding — so
// results are identical to the per-participant queries; only the number of
// round-trips changes (~4/person to 3/request). One shared prefetch also
// dedupes users who appear in several of the viewer's races. Any request
// outside the prefetched range (defensive; not expected) falls through to the
// real models, trading speed for correctness.
async function prefetchScopedModels({
  races,
  now,
  stepsModel,
  stepSampleModel,
  raceActiveEffectModel,
}) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const started = races.filter((r) => r.startedAt);
  if (started.length === 0) return null;

  // Samples: every window the helpers ask for starts at/after its race's
  // start (effectiveStart >= startedAt; effect windows live inside the race),
  // so the earliest startedAt covers every race. The forward margin
  // generously covers "today"-capped and active-effect windows.
  const earliestStartMs = Math.min(...started.map((r) => r.startedAt.getTime()));
  const sampleRangeStart = new Date(earliestStartMs);
  const sampleRangeEnd = new Date(now.getTime() + 7 * DAY_MS);
  // Daily rows are keyed by LOCAL date (stored as UTC-midnight of the date
  // string), so pad backwards: a race's local start date can precede the UTC
  // date of startedAt in western time zones.
  const dailyRangeStart = new Date(earliestStartMs - 3 * DAY_MS);
  const dailyRangeEnd = new Date(now.getTime() + 3 * DAY_MS);

  const userIds = [
    ...new Set(started.flatMap((r) => r.participants.map((p) => p.userId))),
  ];
  // Participant ids are globally unique, so effects keyed by participant id
  // alone serve every race from one map.
  const powerupRaces = started.filter((r) => r.powerupsEnabled);
  const participantIds = powerupRaces.flatMap((r) =>
    r.participants.map((p) => p.id)
  );

  const [sampleRows, dailyRows, effectsByParticipant] = await Promise.all([
    stepSampleModel.findRowsForUsersInRange(userIds, sampleRangeStart, sampleRangeEnd),
    stepsModel.findByUserIdsAndDateRange(userIds, dailyRangeStart, dailyRangeEnd),
    participantIds.length > 0
      ? raceActiveEffectModel.findEffectsForRaceParticipantsByTypes(
          powerupRaces.map((r) => r.id),
          participantIds,
          HOME_EFFECT_TYPES
        )
      : Promise.resolve({}),
  ]);

  const samplesByUser = new Map();
  for (const row of sampleRows) {
    let list = samplesByUser.get(row.userId);
    if (!list) samplesByUser.set(row.userId, (list = []));
    list.push(row);
  }
  const dailyByUser = new Map();
  for (const row of dailyRows) {
    let list = dailyByUser.get(row.userId);
    if (!list) dailyByUser.set(row.userId, (list = []));
    list.push(row);
  }

  const sampleStartMs = new Date(sampleRangeStart).getTime();
  const sampleEndMs = sampleRangeEnd.getTime();
  const dailyStartMs = dailyRangeStart.getTime();
  const dailyEndMs = dailyRangeEnd.getTime();
  const prefetchedTypes = new Set(HOME_EFFECT_TYPES);

  const scopedStepSamples = {
    async sumStepsInWindows(userId, windows) {
      if (!windows || windows.length === 0) return [];
      const covered = windows.every((w) => {
        const ws = new Date(w.start).getTime();
        const we = new Date(w.end).getTime();
        return ws >= sampleStartMs && we <= sampleEndMs;
      });
      if (!covered) return stepSampleModel.sumStepsInWindows(userId, windows);
      const rows = samplesByUser.get(userId) || [];
      return windows.map((w) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(w.start).getTime(),
          new Date(w.end).getTime()
        )
      );
    },
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const sums = await this.sumStepsInWindows(userId, [
        { start: windowStart, end: windowEnd },
      ]);
      return sums[0];
    },
    // CLOSED-bucket variant, prefetch-backed. Must exist here or the home card
    // would score effects off open buckets while GET /races/:id/progress scores
    // them off closed ones -- the two paths have to agree.
    async sumClosedStepsInWindows(userId, windows, now) {
      if (!windows || windows.length === 0) return [];
      const covered = windows.every((w) => {
        const ws = new Date(w.start).getTime();
        const we = new Date(w.end).getTime();
        return ws >= sampleStartMs && we <= sampleEndMs;
      });
      if (!covered) return stepSampleModel.sumClosedStepsInWindows(userId, windows, now);
      const nowMs = new Date(now).getTime();
      const rows = (samplesByUser.get(userId) || []).filter(
        (r) => new Date(r.end).getTime() <= nowMs
      );
      return windows.map((w) =>
        prorateSamplesIntoWindow(
          rows,
          new Date(w.start).getTime(),
          new Date(w.end).getTime()
        )
      );
    },
  };

  const scopedSteps = {
    async findByUserIdAndDate(userId, date) {
      const keyMs = new Date(date).getTime();
      if (keyMs < dailyStartMs || keyMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDate(userId, date);
      }
      const rows = dailyByUser.get(userId) || [];
      return rows.find((r) => new Date(r.date).getTime() === keyMs) ?? null;
    },
    async findByUserIdAndDateRange(userId, startDate, endDate) {
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      if (startMs < dailyStartMs || endMs > dailyEndMs) {
        return stepsModel.findByUserIdAndDateRange(userId, startDate, endDate);
      }
      const rows = dailyByUser.get(userId) || [];
      return rows.filter((r) => {
        const ms = new Date(r.date).getTime();
        return ms >= startMs && ms <= endMs;
      });
    },
  };

  const scopedEffects = {
    async findEffectsForRaceByTypes(raceId, targetParticipantId, types) {
      if (!types.every((t) => prefetchedTypes.has(t))) {
        return raceActiveEffectModel.findEffectsForRaceByTypes(
          raceId,
          targetParticipantId,
          types
        );
      }
      const forParticipant = effectsByParticipant[targetParticipantId] || {};
      const byType = {};
      for (const type of types) byType[type] = forParticipant[type] || [];
      return byType;
    },
    async findEffectsForRaceByType(raceId, targetParticipantId, type) {
      if (!prefetchedTypes.has(type)) {
        return raceActiveEffectModel.findEffectsForRaceByType(
          raceId,
          targetParticipantId,
          type
        );
      }
      return (effectsByParticipant[targetParticipantId] || {})[type] || [];
    },
    // Race-level lookups aren't per-participant hot paths; pass through.
    findRaceEffectsByType: (raceId, type) =>
      raceActiveEffectModel.findRaceEffectsByType(raceId, type),
    findActiveForRace: (raceId) => raceActiveEffectModel.findActiveForRace(raceId),
  };

  return {
    stepsModel: scopedSteps,
    stepSampleModel: scopedStepSamples,
    raceActiveEffectModel: scopedEffects,
  };
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
function snapshotTimeBoundaryIsCurrent(snapshot, now) {
  const nowMs = now.getTime();
  const asOfMs = new Date(snapshot?.asOf).getTime();
  if (!Number.isFinite(asOfMs) || asOfMs > nowMs + 1000) return false;

  const boundaries = [snapshot?.race?.endsAt];
  for (const effect of snapshot?.activeEffects || []) {
    boundaries.push(effect?.startsAt, effect?.expiresAt);
  }
  for (const raw of boundaries) {
    if (raw == null) continue;
    const boundaryMs = new Date(raw).getTime();
    if (!Number.isFinite(boundaryMs)) return false;
    if (boundaryMs > asOfMs && boundaryMs <= nowMs) return false;
  }
  return true;
}

function snapshotMatchesCompletedGeneration({
  snapshot,
  job,
  race,
  now,
  timeZone,
  store,
}) {
  if (!snapshot || !job || job.state !== "SUCCEEDED") return false;
  if (Number(job.generation) !== Number(job.processingGeneration)) return false;
  if (!store.isFresh(snapshot, now.getTime())) return false;
  if (!store.matchesTimeZone(snapshot, raceTimeZone(race, timeZone))) return false;
  if (!snapshotTimeBoundaryIsCurrent(snapshot, now)) return false;

  const asOfMs = new Date(snapshot.asOf).getTime();
  const completedMs = new Date(job.lastCompletedAt).getTime();
  if (!Number.isFinite(completedMs) || asOfMs < completedMs) return false;
  if (snapshot.race?.raceId !== race.id || snapshot.race?.status !== "ACTIVE") {
    return false;
  }
  if (
    new Date(snapshot.race?.endsAt).getTime() !== new Date(race.endsAt).getTime() ||
    snapshot.race?.powerupsEnabled !== race.powerupsEnabled ||
    snapshot.race?.isTeamRace !== race.isTeamRace ||
    (snapshot.race?.teamSize ?? null) !== (race.teamSize ?? null)
  ) {
    return false;
  }

  const participants = Array.isArray(snapshot.participants)
    ? snapshot.participants
    : [];
  if (participants.length === 0) return false;
  const placements = new Set();
  const userIds = new Set();
  for (const participant of participants) {
    const placement = Number(participant?.placement);
    if (!participant?.userId || !Number.isInteger(placement)) return false;
    if (placement < 1 || placement > participants.length) return false;
    placements.add(placement);
    userIds.add(participant.userId);
  }
  return placements.size === participants.length && userIds.size === participants.length;
}

async function readHomeSnapshot(store, raceId) {
  try {
    if (typeof store.readSupportedSnapshot === "function") {
      return await store.readSupportedSnapshot(raceId);
    }
    return (
      (await store.readSnapshot(raceId, store.LEAN_SCHEMA_VERSION)) ||
      (await store.readSnapshot(raceId, store.SCHEMA_VERSION))
    );
  } catch {
    return null;
  }
}

async function checkActiveRacesFromSnapshots(prisma, userId, options = {}) {
  const {
    timeZone = "UTC",
    now = new Date(),
    supportsCharacters = false,
    releaseChannel = "prod",
    supportsRemoteAssets = false,
    supportsTeamRaces = false,
    privacySafeDisplayRanks = false,
    usePersistedTotals = false,
    snapshotStore = defaultRaceProgressSnapshot,
    pageProjection = defaultRaceProgressPageProjection,
    raceResolutionJobModel = defaultRaceResolutionJobV2,
    fallback,
    includeLegacyProjection = false,
    launchReadBatch = null,
  } = options;

  // A failed invalidation opens this process-local breaker because Redis may
  // still contain pre-mutation standings. Honor it before reading any key.
  if (snapshotStore.isBypassed?.() === true) return fallback();

  const activeWhere = {
      userId,
      status: "ACCEPTED",
      race: {
        status: "ACTIVE",
        tournamentId: null,
        ...(supportsTeamRaces ? {} : { isTeamRace: false }),
      },
    };
  const activeSelect = {
      id: true,
      userId: true,
      team: true,
      totalSteps: true,
      finishedAt: true,
      finishTotalSteps: true,
      race: {
        select: {
          id: true,
          name: true,
          startedAt: true,
          endsAt: true,
          timezone: true,
          powerupsEnabled: true,
          isTeamRace: true,
          teamSize: true,
          fundedPrize: true,
          payoutRoundingVersion: true,
          payoutPreset: true,
          payoutCurve: true,
          potCoins: true,
          buyInAmount: true,
          maxDurationDays: true,
          prizeCoinUnit: true,
          prizePoolMaxCoins: true,
          teamPoolMultBps: true,
          teamPayoutVersion: true,
          teamWinnerRewardCoins: true,
          creationSource: true,
          startPolicy: true,
          exitActionsEnabled: true,
          status: true,
        },
      },
    };
  const myActive = launchReadBatch
    ? await launchReadBatch.loadActiveRows({
        prisma,
        userId,
        supportsTeamRaces,
        select: activeSelect,
        maxRows: MAX_ACTIVE_RACES,
      })
    : await prisma.raceParticipant.findMany({
        where: activeWhere,
        select: activeSelect,
        orderBy: { race: { startedAt: "desc" } },
        take: MAX_ACTIVE_RACES,
      });
  if (!myActive || myActive.length === 0) return null;

  const raceIds = myActive.map((row) => row.race?.id).filter(Boolean);
  let jobs;
  try {
    const boundedSnapshots = usePersistedTotals && pageProjection
      ? await Promise.all(myActive.map(({ race }) =>
          readBoundedHomeProjection({ race, userId, timeZone, pageProjection })
            .catch(() => null)))
      : [];
    const snapshots = boundedSnapshots.length === myActive.length &&
      boundedSnapshots.every(Boolean)
      ? boundedSnapshots
      : await Promise.all(raceIds.map((raceId) =>
          readHomeSnapshot(snapshotStore, raceId)));
    // A missing/stale Redis value is the common miss case. Avoid adding a job
    // table read before taking the exact live fallback on those requests.
    if (
      !usePersistedTotals &&
      snapshots.some((snapshot) => !snapshotStore.isFresh(snapshot, now.getTime()))
    ) {
      return fallback();
    }
    if (!usePersistedTotals) {
      const loadedJobs = await raceResolutionJobModel.findByRaceIds(raceIds);
      jobs = new Map(loadedJobs.map((job) => [job.raceId, job]));
    }
    for (let index = 0; index < myActive.length; index += 1) {
      const race = myActive[index].race;
      let snapshot = snapshots[index];
      if (
        !race ||
        !(usePersistedTotals
          ? snapshotStore.matchesTimeZone(snapshot, raceTimeZone(race, timeZone)) &&
            snapshotTimeBoundaryIsCurrent(snapshot, now) &&
            snapshot.race?.raceId === race.id &&
            snapshot.race?.status === "ACTIVE"
          : snapshotMatchesCompletedGeneration({
              snapshot,
              job: jobs.get(race.id),
              race,
              now,
              timeZone,
              store: snapshotStore,
            })) ||
        !snapshot.participants.some((participant) => participant.userId === userId) ||
        (race.isTeamRace && supportsTeamRaces && !snapshot.teams)
      ) {
        return fallback();
      }
      if (usePersistedTotals) {
        // sync-v2 has already made the viewer's persisted row current. Keep the
        // shared race snapshot for every rival, overlay only that one bounded
        // row, then recompute deterministic placement in memory. This avoids a
        // 10,000-row hydration per app open while keeping the number the user
        // just synced immediately truthful; rivals converge with the worker's
        // next snapshot (soft TTL <= 15 seconds).
        const adjusted = snapshot.participants.map((participant) =>
          participant.userId === userId
            ? {
                ...participant,
                participantId: myActive[index].id,
                totalSteps: myActive[index].finishedAt
                  ? myActive[index].finishTotalSteps ?? myActive[index].totalSteps ?? 0
                  : myActive[index].totalSteps ?? 0,
                finishedAt: myActive[index].finishedAt,
              }
            : { ...participant });
        adjusted.sort(compareParticipantsForPlacement);
        const adjustedViewerIndex = adjusted.findIndex(
          (participant) => participant.userId === userId
        );
        const viewerPlacementOverride =
          snapshot.requesterWasInPage || adjustedViewerIndex < snapshot.pageRowCount
            ? adjustedViewerIndex + 1
            : snapshot.requesterSnapshotPlacement;
        snapshot = {
          ...snapshot,
          viewerPlacementOverride,
          participants: adjusted.map((participant, placement) => ({
            ...participant,
            placement: placement + 1,
          })),
        };
      }
      myActive[index].snapshot = snapshot;
    }
  } catch {
    return fallback();
  }

  const projectionsByRaceId = new Map(
    myActive.map(({ race, snapshot }) => {
      const ranked = [...snapshot.participants].sort(
        (left, right) => Number(left.placement) - Number(right.placement)
      );
      return [
        race.id,
        buildHomePlacementProjection({
          ranked,
          effects: race.powerupsEnabled ? snapshot.activeEffects || [] : [],
          userId,
        }),
      ];
    })
  );
  const visibleUserIds = [
    ...new Set(
      [
        userId,
        ...myActive.flatMap((row) =>
          projectionsByRaceId
            .get(row.race.id)
            .presentationOrder
            .slice(0, 3)
            .filter(
              (participant) =>
                !projectionsByRaceId
                  .get(row.race.id)
                  .maskedUserIds.has(participant.userId)
            )
            .map((participant) => participant.userId)
        ),
      ]
    ),
  ];
  const users = visibleUserIds.length > 0
    ? launchReadBatch
      ? await launchReadBatch.loadUsers({
          prisma, userIds: visibleUserIds, select: USER_SELECT,
        })
      : await prisma.user.findMany({
          where: { id: { in: visibleUserIds } },
          select: USER_SELECT,
        })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));

  const races = myActive.map(({ race, team, snapshot }) => {
    const ranked = [...snapshot.participants].sort(
      (left, right) => Number(left.placement) - Number(right.placement)
    );
    const projection = projectionsByRaceId.get(race.id);
    const top3 = projection.presentationOrder.slice(0, 3).map((participant) => {
      const canonicalPlacement = ranked.indexOf(participant) + 1;
      const isStealthed = projection.maskedUserIds.has(participant.userId);
      const user = userById.get(participant.userId) || null;
      return {
        rank:
          isStealthed ||
          (!privacySafeDisplayRanks && projection.placementPrivacyActive)
            ? null
            : canonicalPlacement,
        ...(privacySafeDisplayRanks
          ? {
              displayPlacement: isStealthed
                ? null
                : projection.displayPlacementByUserId.get(participant.userId) ?? null,
            }
          : {}),
        userId: participant.userId,
        displayName: isStealthed ? "???" : (user?.displayName || "Anonymous"),
        ...(isStealthed
          ? { equippedAccessories: [], animal: null }
          : (() => {
              const { animal, accessories } = characterPresentation(
                user,
                supportsCharacters,
                releaseChannel,
                supportsRemoteAssets
              );
              return { equippedAccessories: accessories, animal };
            })()),
        totalSteps: isStealthed
          ? null
          : Math.max(0, Number(participant.totalSteps) || 0),
        isStealthed,
      };
    });
    const myIndex = ranked.findIndex((participant) => participant.userId === userId);
    const result = {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      top3,
      userPlacement:
        projection.viewerIsDetoured ||
        (!privacySafeDisplayRanks && projection.placementPrivacyActive) ||
        myIndex < 0
          ? null
          : snapshot.viewerPlacementOverride ?? myIndex + 1,
      userPlacementHidden: projection.viewerIsDetoured,
      ...(privacySafeDisplayRanks
        ? {
            userDisplayPlacement: projection.viewerIsDetoured
              ? null
              : projection.displayPlacementByUserId.get(userId) ?? null,
            placementPrivacyActive: projection.placementPrivacyActive,
          }
        : {}),
      participantCount: snapshot.totalCount ?? ranked.length,
      ...homeMoneyView(
        race,
        ranked.map((participant) => ({
          ...participant,
          status: "ACCEPTED",
        })),
      ),
      ...(race.isTeamRace && supportsTeamRaces
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam: team ?? null,
            teams: snapshot.teams,
          }
        : {}),
    };
    if (!includeLegacyProjection) return result;
    const entriesByUserId = new Map(ranked.map((participant) => {
      const masked = projection.maskedUserIds.has(participant.userId);
      const user = userById.get(participant.userId) || null;
      return [participant.userId, {
        rank:
          masked || (!privacySafeDisplayRanks && projection.placementPrivacyActive)
            ? null
            : ranked.indexOf(participant) + 1,
        ...(privacySafeDisplayRanks
          ? { displayPlacement: masked
              ? null
              : projection.displayPlacementByUserId.get(participant.userId) ?? null }
          : {}),
        totalSteps: masked ? null : Math.max(0, Number(participant.totalSteps) || 0),
        ...(masked
          ? { userId: participant.userId, displayName: "???", profilePhotoUrl: null,
              animal: null, accessories: [] }
          : serializeUser(user, supportsCharacters, releaseChannel, supportsRemoteAssets)),
        isStealthed: masked,
      }];
    }));
    Object.defineProperty(result, "_legacySnapshotProjection", {
      enumerable: false,
      value: {
        entriesByUserId,
        presentationUserIds: projection.presentationOrder.map((row) => row.userId),
        viewerUserId: userId,
        placementPrivacyActive: projection.placementPrivacyActive,
      },
    });
    return result;
  });
  return { state: "ACTIVE_RACES", data: { races } };
}

async function checkActiveRaceFromSnapshot(prisma, userId, options = {}) {
  const active = await checkActiveRacesFromSnapshots(prisma, userId, {
    ...options,
    usePersistedTotals: true,
    includeLegacyProjection: true,
  });
  if (!active || active.state !== "ACTIVE_RACES" || !active.data?.races?.length) {
    return active;
  }
  const race = active.data.races[0];
  const projection = race._legacySnapshotProjection;
  if (!projection) return options.fallback();
  const me = projection.entriesByUserId.get(userId) || null;
  const leaderId = projection.presentationUserIds[0] || null;
  const leader = leaderId ? projection.entriesByUserId.get(leaderId) || null : null;
  const others = projection.presentationUserIds
    .filter((id) => id !== userId && id !== leaderId)
    .slice(0, 2)
    .map((id) => projection.entriesByUserId.get(id))
    .filter(Boolean);
  const moneyKeys = [
    "buyInAmount", "potCoins", "heldPotCoins", "projectedPotCoins",
    "prizePool", "payouts", "payoutTiers", "finishReward",
    "teamPayoutVersion", "teamWinnerRewardCoins",
  ];
  const money = Object.fromEntries(
    moneyKeys.filter((key) => Object.prototype.hasOwnProperty.call(race, key))
      .map((key) => [key, race[key]])
  );
  return {
    state: "ACTIVE_RACE",
    data: {
      raceId: race.raceId,
      name: race.name,
      endsAt: race.endsAt,
      me,
      leader,
      others,
      ...(options.privacySafeDisplayRanks
        ? { placementPrivacyActive: projection.placementPrivacyActive }
        : {}),
      ...money,
      ...(race.isTeamRace
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam: race.myTeam ?? null,
            teams: race.teams,
          }
        : {}),
    },
  };
}

async function checkActiveRaces(prisma, userId, options = {}) {
  const {
    timeZone = "UTC",
    now = new Date(),
    stepsModel = Steps,
    stepSampleModel = StepSample,
    raceActiveEffectModel = RaceActiveEffect,
    supportsCharacters = false,
    releaseChannel = "prod",
    supportsRemoteAssets = false,
    // TR-809 parity (batch 2026-07-26, B-12d): the ACTIVE_RACES state never
    // emitted `teams`/`isTeamRace`, unlike the legacy single-card path, so on
    // the new home state a team race rendered as an individual ticket with no
    // scoreline. Token-gated exactly like the legacy path.
    supportsTeamRaces = false,
    privacySafeDisplayRanks = false,
    // §6.3: when true (new client sent homePersistedTotals=1 after a CURRENT
    // sync-v2), build entries from persisted RaceParticipant.totalSteps instead
    // of recomputing live health windows for every participant. Masking,
    // ordering, top-three, placement, and team blocks are unchanged.
    usePersistedTotals = false,
    leanLiveEnabled = false,
    launchReadBatch = null,
  } = options;

  let myActive = null;
  if (usePersistedTotals && leanLiveEnabled && launchReadBatch) {
    const boundedRows = await launchReadBatch.loadActiveRows({
      prisma,
      userId,
      supportsTeamRaces,
      select: PERSISTED_HOME_ACTIVE_SELECT,
      maxRows: MAX_ACTIVE_RACES,
    });
    if (boundedRows.length > 0 && boundedRows.every((row) =>
      boundedPersistedHomeRace(row.race))) {
      await Promise.all(boundedRows.map(async (row) => {
        row.race.participants = await launchReadBatch.loadBoundedLegacyRoster({
          prisma,
          raceId: row.race.id,
          userId,
        });
        row.race._acceptedCount = Number(
          row.race.participants[0]?.totalCount || row.race.participants.length,
        );
      }));
      myActive = boundedRows;
    }
  }

  myActive ||= await prisma.raceParticipant.findMany({
    where: {
      userId,
      status: "ACCEPTED",
      // Matchup races are surfaced only via the tournament screen (§4).
      race: { status: "ACTIVE", tournamentId: null },
    },
    include: {
      race: {
        include: {
          participants: {
            where: { status: "ACCEPTED" },
            ...(leanLiveEnabled
              ? {}
              : { include: { user: { select: USER_SELECT } } }),
            orderBy: { totalSteps: "desc" },
          },
        },
      },
    },
    orderBy: { race: { startedAt: "desc" } },
    take: MAX_ACTIVE_RACES,
  });

  if (!myActive || myActive.length === 0) return null;

  // Prefetch is only possible against the real models (or fakes that opt in);
  // tests inject minimal fakes without the bulk methods and keep the legacy
  // per-participant query path, which is behaviorally identical.
  const canPrefetch =
    !usePersistedTotals &&
    typeof stepSampleModel.findRowsForUsersInRange === "function" &&
    typeof stepsModel.findByUserIdsAndDateRange === "function" &&
    typeof raceActiveEffectModel.findEffectsForRaceParticipantsByTypes ===
      "function";

  // One shared prefetch for every race (null when the injected models are
  // minimal test fakes, or no race has started — the legacy per-participant
  // query path then runs unchanged).
  const scoped = canPrefetch
    ? await prefetchScopedModels({
        races: myActive.map((pt) => pt.race).filter(Boolean),
        now,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
      })
    : null;
  const raceStepsModel = scoped ? scoped.stepsModel : stepsModel;
  const raceStepSampleModel = scoped ? scoped.stepSampleModel : stepSampleModel;
  const raceEffectModel = scoped ? scoped.raceActiveEffectModel : raceActiveEffectModel;

  async function buildRaceEntry(participation) {
    const race = participation.race;
    if (!race) return null;

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
    const liveTotals = new Map(); // participant.id -> total (live or persisted)
    if (usePersistedTotals) {
      // §6.3 opt-in: use persisted RaceParticipant.totalSteps directly. The
      // uploader's own row was just made current in-band by sync-v2's uploader
      // pass; rival rows may be briefly stale until the durable job's job-success
      // refresh (the accepted, bounded new-client tradeoff, D14). Reads never
      // write totals. Finishers keep their frozen finishTotalSteps.
      for (const p of race.participants) {
        liveTotals.set(
          p.id,
          p.finishedAt ? p.finishTotalSteps ?? p.totalSteps ?? 0 : p.totalSteps ?? 0
        );
      }
    } else if (race.startedAt) {
      // Phase A: per-participant PRE-LEECH total + the leeches targeting them.
      // Finished racers keep their frozen total and take no part in the transfer.
      const preLeech = await Promise.all(
        race.participants.map(async (p) => {
          if (p.finishedAt) {
            return { participant: p, frozen: true, total: p.finishTotalSteps ?? p.totalSteps ?? 0 };
          }
          const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
            participant: p,
            raceStartedAt: race.startedAt,
            // Seeded races bucket in their canonical tz so the home card agrees
            // with the race-detail screen and settlement; user races use the
            // requester's header tz (legacy).
            timeZone: raceTimeZone(race, timeZone),
            stepsModel: raceStepsModel,
            stepSampleModel: raceStepSampleModel,
            now,
          });
          const { total, leechTransfers } = await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant: p,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel: raceEffectModel,
            stepSampleModel: raceStepSampleModel,
            now,
          });
          return { participant: p, frozen: false, preLeechTotal: total, leechTransfers };
        })
      );

      // Phase A2 — HITCHHIKE (§7.3). The home card shows the SAME number race
      // detail does, so the copy has to be folded in here too: a caster with a
      // live link would otherwise see one total on the home card and a larger
      // one in race detail — the live-vs-live divergence the parity rule exists
      // to prevent. Read-only, like everything else on this path.
      const hitchhikeCopies = race.powerupsEnabled
        ? await collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: race.endsAt,
            participants: race.participants,
            raceActiveEffectModel: raceEffectModel,
            stepSampleModel: raceStepSampleModel,
            now,
            raceTimezone: race.timezone || "UTC",
          })
        : [];

      // Phase B: resolve leech race-wide (zero-sum, deterministic) so the home
      // card's totals match race detail — including the attacker's minted credit.
      const leechFinals = applyLeechTransfers(
        applyHitchhikeCopies(
          preLeech
            .filter((e) => !e.frozen)
            .map((e) => ({
              participantId: e.participant.id,
              userId: e.participant.userId,
              preLeechTotal: e.preLeechTotal,
              leechTransfers: e.leechTransfers,
            })),
          hitchhikeCopies
        )
      );
      for (const e of preLeech) {
        liveTotals.set(
          e.participant.id,
          e.frozen ? e.total : leechFinals.get(e.participant.id) ?? e.preLeechTotal
        );
      }
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
    // B-12d: Detour Sign had NO handling here at all, so home kept showing a
    // real placement while the races list and race detail both showed "???".
    let viewerIsDetoured = false;
    let activeEffects = [];
    if (race.powerupsEnabled) {
      activeEffects = await raceEffectModel.findActiveForRace(race.id);
      for (const e of activeEffects) {
        if (e.type === "STEALTH_MODE") stealthedUserIds.add(e.targetUserId);
        if (e.type === "DETOUR_SIGN" && e.targetUserId === userId) {
          viewerIsDetoured = true;
        }
      }
    }

    const projection = buildHomePlacementProjection({
      ranked,
      effects: race.powerupsEnabled ? activeEffects : [],
      userId,
    });
    if (leanLiveEnabled) {
      const visibleParticipants = projection.presentationOrder
        .slice(0, 3)
        .filter((participant) => !projection.maskedUserIds.has(participant.userId));
      const visibleIds = visibleParticipants.map((participant) => participant.userId);
      const users = visibleIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: visibleIds } },
            select: USER_SELECT,
          })
        : [];
      const userById = new Map(users.map((user) => [user.id, user]));
      for (const participant of visibleParticipants) {
        participant.user = userById.get(participant.userId) || null;
      }
    }
    const top3 = projection.presentationOrder.slice(0, 3).map((p) => {
      const canonicalPlacement = Number(p.computedPlacement) || ranked.indexOf(p) + 1;
      const isStealthed = projection.maskedUserIds.has(p.userId);
      return {
        rank:
          isStealthed ||
          (!privacySafeDisplayRanks && projection.placementPrivacyActive)
            ? null
            : canonicalPlacement,
        ...(privacySafeDisplayRanks
          ? {
              displayPlacement: isStealthed
                ? null
                : projection.displayPlacementByUserId.get(p.userId) ?? null,
            }
          : {}),
        userId: p.userId,
        displayName: isStealthed ? "???" : (p.user?.displayName || "Anonymous"),
        ...(isStealthed
          ? { equippedAccessories: [], animal: null }
          : (() => {
              const { animal, accessories } = characterPresentation(
                p.user,
                supportsCharacters,
                releaseChannel,
                supportsRemoteAssets
              );
              return { equippedAccessories: accessories, animal };
            })()),
        totalSteps: isStealthed ? null : Math.max(0, Number(p.totalSteps) || 0),
        isStealthed,
      };
    });

    const myIndex = ranked.findIndex((p) => p.userId === userId);
    const persistedViewerPlacement = myIndex < 0
      ? null
      : Number(ranked[myIndex].computedPlacement) || myIndex + 1;
    const userPlacement =
      viewerIsDetoured ||
      (!privacySafeDisplayRanks && projection.placementPrivacyActive) ||
      myIndex < 0
        ? null
        : persistedViewerPlacement;

    return {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      top3,
      userPlacement,
      // Additive, mirrors GET /races' myPlacementHidden so the client reads one
      // rule everywhere. Frozen clients ignore it and just see no chip.
      userPlacementHidden: viewerIsDetoured,
      ...(privacySafeDisplayRanks
        ? {
            userDisplayPlacement: viewerIsDetoured
              ? null
              : projection.displayPlacementByUserId.get(userId) ?? null,
            placementPrivacyActive: projection.placementPrivacyActive,
          }
        : {}),
      participantCount: race._acceptedCount ?? ranked.length,
      ...homeMoneyView(race, liveParticipants),
      // B-12d: the canonical team block, from the LIVE totals this entry
      // already computed (so it matches the ticket's own numbers), built by the
      // same shared builder every other surface uses.
      ...(race.isTeamRace && supportsTeamRaces
        ? {
            isTeamRace: true,
            teamSize: race.teamSize ?? null,
            myTeam:
              race.participants.find((p) => p.userId === userId)?.team ?? null,
            teams: buildTeamsBlock(
              race,
              liveParticipants
                .filter((p) => p.status === "ACCEPTED")
                .map((p) => ({
                  participant: p,
                  totalSteps: Math.max(0, Number(p.totalSteps) || 0),
                }))
            ),
          }
        : {}),
    };
  }

  // Races are independent read-only computations; run them concurrently.
  // Promise.all preserves myActive's order (startedAt desc), matching the
  // sequential loop this replaces.
  const races = (await Promise.all(myActive.map(buildRaceEntry))).filter(
    Boolean
  );

  if (races.length === 0) return null;

  return { state: "ACTIVE_RACES", data: { races } };
}

async function checkFriendRacing(
  prisma,
  userId,
  friendIds,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
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
    (fp) =>
      fp.race.maxParticipants == null ||
      fp.race.participants.length < fp.race.maxParticipants
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
      friend: serializeUser(
        choice.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      participants: race.participants.map((p, idx) => ({
        rank: idx + 1,
        totalSteps: Math.max(0, Number(p.totalSteps) || 0),
        ...serializeUser(
          p.user,
          supportsCharacters,
          releaseChannel,
          supportsRemoteAssets
        ),
      })),
    },
  };
}

async function checkFriendFinished(
  prisma,
  userId,
  friendIds,
  now,
  supportsCharacters = false,
  releaseChannel = "prod",
  supportsRemoteAssets = false
) {
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
      friend: serializeUser(
        finisher.user,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets
      ),
      raceName: finisher.race.name,
      placement: finisher.placement,
      finishedAt: finisher.race.completedAt,
    },
  };
}

async function checkPublicRace(prisma, userId) {
  // Active public races the user isn't already in. Prefer DAILY_10K, then WEEKLY_50K, then anything.
  const candidates = await findLegacyPublicRaceCandidates({ prisma, userId });

  if (candidates.length === 0) return null;

  // Filter out full races, then rank by seed preference.
  const joinable = candidates.filter(
    (r) => r.maxParticipants == null || r.participantCount < r.maxParticipants
  );
  if (joinable.length === 0) return null;

  const seedRank = { DAILY_10K: 0, WEEKLY_50K: 1 };
  joinable.sort((a, b) => {
    const aRank = a.seedKind ? (seedRank[a.seedKind] ?? 2) : 3;
    const bRank = b.seedKind ? (seedRank[b.seedKind] ?? 2) : 3;
    return aRank - bRank;
  });

  const race = joinable[0];

  return {
    state: "PUBLIC_RACE",
    data: {
      raceId: race.id,
      name: race.name,
      endsAt: race.endsAt,
      participantCount: race.participantCount,
      seedKind: race.seedKind || null,
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
  const snapshotStore =
    dependencies.raceProgressSnapshot || defaultRaceProgressSnapshot;
  const raceResolutionJobModel =
    dependencies.RaceResolutionJobV2 || defaultRaceResolutionJobV2;
  const launchReadBatch = dependencies.homeLaunchReadBatch ||
    (prisma === defaultPrisma ? defaultHomeLaunchReadBatch : null);

  return async function getHomeRaceCard({
    userId,
    homeActiveRaces = false,
    // §6.3: opt-in to persisted-total ACTIVE_RACES cards. Only honored together
    // with homeActiveRaces; ignored otherwise. Old clients never send it.
    homePersistedTotals = false,
    timeZone = "UTC",
    supportsCharacters = false,
    supportsRemoteAssets = false,
    // TR-702/809: whether the caller declared the `team_races` token. Old
    // clients never see a team race on the Home card.
    supportsTeamRaces = false,
    privacySafeDisplayRanks = false,
    // Batch 2026-07-26, item 8. Defaults to "prod" — a shipped binary never
    // receives a test-only assetKey it does not bundle.
    releaseChannel = "prod",
    leanLiveEnabled = false,
    snapshotReuseEnabled = false,
  }) {
    const now = nowFn();

    const pending = await checkPendingInvite(
      prisma,
      userId,
      now,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets,
      launchReadBatch
    );
    if (pending) return pending;

    // Opt-in path (new app builds): when the client requests homeActiveRaces and
    // the user has >=1 active race, return the new ACTIVE_RACES list state. When
    // the opted-in user has NO active races, checkActiveRaces returns null and we
    // fall through to the legacy single-state logic below. Old clients never set
    // this flag, so they always get the legacy ACTIVE_RACE single-card response
    // (byte-for-byte unchanged).
    if (homeActiveRaces) {
      const activeRaceOptions = {
        timeZone,
        now,
        stepsModel,
        stepSampleModel,
        raceActiveEffectModel,
        supportsCharacters,
        releaseChannel,
        supportsRemoteAssets,
        supportsTeamRaces,
        privacySafeDisplayRanks,
        usePersistedTotals: homePersistedTotals,
        leanLiveEnabled,
        launchReadBatch,
      };
      const activeRaces = snapshotReuseEnabled
        ? await checkActiveRacesFromSnapshots(prisma, userId, {
            ...activeRaceOptions,
            snapshotStore,
            raceResolutionJobModel,
            launchReadBatch,
            fallback: () => checkActiveRaces(prisma, userId, activeRaceOptions),
          })
        : await checkActiveRaces(prisma, userId, activeRaceOptions);
      if (activeRaces) return activeRaces;
    } else {
      const fallback = () => checkActiveRace(
          prisma,
          userId,
          supportsCharacters,
          supportsTeamRaces,
          releaseChannel,
          supportsRemoteAssets,
          raceActiveEffectModel,
          privacySafeDisplayRanks,
          launchReadBatch,
        );
      const active = snapshotReuseEnabled
        ? await checkActiveRaceFromSnapshot(prisma, userId, {
            timeZone,
            now,
            supportsCharacters,
            releaseChannel,
            supportsRemoteAssets,
            supportsTeamRaces,
            privacySafeDisplayRanks,
            // Frozen clients need the same four-person response, not a parsed
            // 10k presentation roster. The page projection carries the
            // authoritative generation plus top page and requester overlay;
            // this changes only the internal read plan, never their payload.
            usePersistedTotals: true,
            snapshotStore,
            raceResolutionJobModel,
            launchReadBatch,
            fallback,
          })
        : await fallback();
      if (active) return active;
    }

    const friendIds = await getAcceptedFriendIds(prisma, userId);

    const friendRacing = await checkFriendRacing(
      prisma,
      userId,
      friendIds,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
    if (friendRacing) return friendRacing;

    const friendFinished = await checkFriendFinished(
      prisma,
      userId,
      friendIds,
      now,
      supportsCharacters,
      releaseChannel,
      supportsRemoteAssets
    );
    if (friendFinished) return friendFinished;

    const publicRace = await checkPublicRace(prisma, userId);
    if (publicRace) return publicRace;

    return { state: "EMPTY", data: {} };
  };
}

const getHomeRaceCard = buildGetHomeRaceCard();

module.exports = {
  buildGetHomeRaceCard,
  checkActiveRaceFromSnapshot,
  checkActiveRacesFromSnapshots,
  getHomeRaceCard,
};
