const { Prisma } = require("@prisma/client");
const {
  raceSqlSummaryReadBatch,
} = require("../services/raceSqlSummaryReadBatch");
const { prisma } = require("../../../db");
const { raceListReadBatch } = require("../services/raceListReadBatch");
const userPresentationCache = require("../../social/services/userPresentationCache");

async function hydrateRaceListPeople(races, presentationCache = userPresentationCache) {
  const rows = Array.isArray(races) ? races : [];
  const ids = [...new Set(rows.flatMap((race) => [
    race?.creatorId,
    race?.winnerUserId,
  ]).filter(Boolean))];
  if (ids.length === 0) {
    return rows.map((race) => ({ ...race, creator: null, winner: null }));
  }
  const people = await presentationCache.getMany(ids, true);
  return rows.map((race) => ({
    ...race,
    creator: people.get(race.creatorId) ?? null,
    winner: people.get(race.winnerUserId) ?? null,
  }));
}

// The cosmetic hydration subtree: participant -> user -> equipped cosmetics ->
// shop item render metadata. Four Prisma queries and the dominant cost of any
// read that carries it (see the long note on stepSyncScopeRaceSelect below).
// Shared so the paged detail read below hydrates EXACTLY the same shape for its
// page as the fat include does for the whole field — a page and a whole answer
// must be indistinguishable per participant.
const participantCosmeticUserSelect = {
  select: {
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
  },
};

const participantInclude = {
  participants: {
    // Uses `include` (not `select`), so all RaceParticipant scalar fields —
    // including resultsSeenAt (race results "seen" ack, read by getRaces) — are
    // returned automatically. The lean findActiveForUser select does NOT need
    // resultsSeenAt; race resolution never reads it.
    include: {
      user: participantCosmeticUserSelect,
    },
    // `joinedAt` is not unique (bulk enrollment and fast sequential joins can
    // share the same database timestamp). Keep every legacy/full progress read
    // on the same deterministic order as the paged projection so OFFSET pages
    // cannot reshuffle tied participants between polls.
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  },
};

// Stable, display-safe projection for the split GET /races cache. Participant
// rows, offers, inventory, effects, placements, and step totals are intentionally
// absent: those are viewer-specific or live and are re-read after this fragment
// is loaded. Keep this list aligned with raceListCache.FIELD_CLASSIFICATION.
const raceListStableSelect = {
  id: true,
  creatorId: true,
  seedId: true,
  name: true,
  targetSteps: true,
  status: true,
  maxDurationDays: true,
  buyInAmount: true,
  payoutPreset: true,
  potCoins: true,
  fundedPrize: true,
  prizePoolCoins: true,
  prizeCoinUnit: true,
  prizePoolMaxCoins: true,
  prizeCalculationVersion: true,
  payoutRoundingVersion: true,
  payoutCurve: true,
  creationSource: true,
  startPolicy: true,
  teamPoolMultBps: true,
  teamPayoutVersion: true,
  teamWinnerRewardCoins: true,
  startedAt: true,
  endsAt: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  timezone: true,
  completedAt: true,
  winnerUserId: true,
  powerupsEnabled: true,
  powerupStepInterval: true,
  isPublic: true,
  maxParticipants: true,
  timeBased: true,
  isTeamRace: true,
  teamSize: true,
  teamAName: true,
  teamBName: true,
  winnerTeam: true,
  tournamentId: true,
  tournamentRound: true,
  tournamentMatchIndex: true,
  seededBucketId: true,
  createdAt: true,
  updatedAt: true,
};

// ── Paged race-detail read plan ───────────────────────────────────────────────
// Used ONLY when a client both advertises `race_participants_paging` and asks
// for `view=participants-v1`. Every other caller keeps `findById` verbatim.
//
// The point is the QUERY plan, not the payload: `findById` hydrates the cosmetic
// subtree for all N participants (477 on the prod Weekly Challenge), and slicing
// the serialized array afterwards saves bytes but not database time. This plan
// splits that one fat read into:
//
//   findDetailsCore              -> the race row + creator/winner/seed/tournament,
//                                   with NO participants relation at all.
//   findDetailsParticipantSummaries -> every participant row, scalars only, no
//                                   user/accessory join. Feeds the ACCEPTED /
//                                   per-team counts, the money view (which needs
//                                   per-row buyIn/placement/forfeit scalars, so a
//                                   GROUP BY could not replace it), the pagination
//                                   total and participantUserIds.
//   findDetailsParticipantPage   -> ONE page, cosmetics and all, LIMIT/OFFSET
//                                   applied by the database.
//
// `findDetailsCore` deliberately uses `include` rather than `select`, so every
// race scalar comes back exactly as `findById` returns it. A `select` here would
// silently drop a field the money view or the leave-action resolver reads.
const detailsRelationInclude = {
  creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
  winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
  seed: { select: { kind: true } },
  tournament: { select: { id: true, name: true, bracketSize: true } },
};

// Every participant scalar any non-cosmetic detail consumer reads. Cheap enough
// to fetch for the whole field: it is one row of small columns per participant
// with no joins, which is what replaces "scan all 477 hydrated rows for a count".
const detailsParticipantSummarySelect = {
  id: true,
  userId: true,
  status: true,
  team: true,
  totalSteps: true,
  rawSteps: true,
  placement: true,
  finishedAt: true,
  forfeitedAt: true,
  buyInAmount: true,
  buyInStatus: true,
  payoutCoins: true,
  chatMuted: true,
  placementAlertsMuted: true,
  lastReadRaceChatAt: true,
  joinedAt: true,
};

// `joinedAt` alone has no tiebreak, and seeded Daily/Weekly races bulk-enroll
// hundreds of rows in the same instant — precisely the races this pager exists
// for. Without the `id` tiebreak, Postgres may order tied rows differently
// between two LIMIT/OFFSET reads, so a page walk can duplicate or skip a
// participant and page 0 can reshuffle between polls.
const detailsParticipantOrder = [{ joinedAt: "asc" }, { id: "asc" }];

const mysteryBoxParticipantSelect = {
  id: true,
  userId: true,
  status: true,
  totalSteps: true,
  rawSteps: true,
  bonusSteps: true,
  maxBonusSteps: true,
  nextBoxAtSteps: true,
  powerupSlots: true,
  finishedAt: true,
  finishTotalSteps: true,
  forfeitedAt: true,
  team: true,
  joinedAt: true,
};

const resolutionParticipantSelect = {
  ...mysteryBoxParticipantSelect,
  placement: true,
  // Internal-only input for race-level overtake nudge batching. Never exposed
  // by a public serializer; lets the worker reuse its hydrated lean roster.
  lastNotifiedPlacement: true,
  highMultiplierNotifiedAt: true,
  user: { select: { id: true, displayName: true } },
};

const resolutionRaceSelect = {
  id: true,
  name: true,
  status: true,
  startedAt: true,
  scheduledStartAt: true,
  endsAt: true,
  timezone: true,
  targetSteps: true,
  timeBased: true,
  powerupsEnabled: true,
  powerupStepInterval: true,
  isTeamRace: true,
  teamSize: true,
  teamAName: true,
  teamBName: true,
  participants: {
    select: resolutionParticipantSelect,
    orderBy: { joinedAt: "asc" },
  },
};

const powerupUseRosterParticipantSelect = {
  id: true,
  userId: true,
  status: true,
  totalSteps: true,
  finishedAt: true,
  forfeitedAt: true,
  team: true,
  joinedAt: true,
  user: { select: { displayName: true } },
};

const powerupUseCasterSelect = {
  ...powerupUseRosterParticipantSelect,
  bonusSteps: true,
  maxBonusSteps: true,
  nextBoxAtSteps: true,
  powerupSlots: true,
  placement: true,
  highMultiplierNotifiedAt: true,
};

const powerupUseRaceScalars = {
  id: true,
  name: true,
  status: true,
  startedAt: true,
  scheduledStartAt: true,
  endsAt: true,
  timezone: true,
  targetSteps: true,
  timeBased: true,
  powerupsEnabled: true,
  powerupStepInterval: true,
  isTeamRace: true,
  teamSize: true,
  teamAName: true,
  teamBName: true,
};

// The STEP_SYNC_COMMITTED scope's race read (see
// services/raceResolutionStepSyncScope.js). It is `resolutionRaceSelect` plus
// ONE column, deliberately:
//
//   * `totalsUpdatedAt` is the scope's staleness token — it is compared against
//     the claim instant and re-verified in the write fence, so it is the one
//     field the ordinary resolution select does not already carry.
//
// What it drops versus the FAT `findById` include this replaced is the whole
// point: the entire cosmetic-hydration subtree (participant -> user -> equipped
// cosmetics -> shop item render metadata), plus `creator`, `winner`, `seed` and
// `tournament`. That subtree is four Prisma queries and the dominant cost of
// the read, and NOTHING on the step-sync path renders an avatar or a cosmetic.
// The structural guard in test/services/racePowerupPerformance.test.js pins
// that this whole region stays free of cosmetic hydration.
//
// It is NOT narrower than that. Every remaining field is load-bearing for a
// downstream consumer of `result.race` on this plan — audited call by call:
//   * `isTeamRace`            -> retainTeamAsOfHeartbeat (queue worker)
//   * `name`, `startedAt`,
//     `powerupsEnabled`       -> the high-multiplier alert pass
//                                (raceProgressSideEffects -> highMultiplierAlert)
//   * `powerupStepInterval`,
//     `status`                -> syncRacePowerupState
//   * participants' `totalSteps`, `finishedAt`, `finishTotalSteps`,
//     `forfeitedAt`, `nextBoxAtSteps`, `powerupSlots`, `bonusSteps`,
//     `maxBonusSteps`         -> syncRacePowerupState's box/slot math
//   * participants' `highMultiplierNotifiedAt`, `user.displayName`
//                             -> the alert's already-notified guard and actor name
//
// Participants are fetched UNFILTERED (no `status: ACCEPTED` where-clause) and
// in `joinedAt` order, matching the fat include exactly: the scope builder and
// the alert pass BOTH filter on `status` themselves, and the alert requires the
// full accepted roster to pick recipients.
const stepSyncScopeParticipantSelect = {
  ...resolutionParticipantSelect,
  totalsUpdatedAt: true,
};

const stepSyncScopeRaceSelect = {
  ...resolutionRaceSelect,
  participants: {
    select: stepSyncScopeParticipantSelect,
    orderBy: { joinedAt: "asc" },
  },
};

const Race = {
  async findForStepSyncScope(id) {
    return prisma.race.findUnique({
      where: { id },
      select: stepSyncScopeRaceSelect,
    });
  },

  async findBootstrapAccessContext(id, userId) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        seededBucketId: true,
        tournamentId: true,
        // Required by the race-preview carve-out in loadBootstrapAccess
        // (canReadRacePreview reads race.isPublic). /bootstrap is the FIRST call
        // the race-detail screen makes, so without this column that gate 403s
        // before getRaceDetails — which has isPublic via findDetailsCore's
        // include — is ever reached.
        isPublic: true,
        participants: {
          where: { userId },
          select: { userId: true, status: true },
          take: 1,
        },
        tournament: {
          select: {
            participants: {
              where: { userId, status: "ACCEPTED" },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    });
  },

  async findMessageAccessContext(id, userId) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        seededBucketId: true,
        tournamentId: true,
        powerupsEnabled: true,
        participants: {
          where: { userId },
          select: { userId: true, status: true },
          take: 1,
        },
        tournament: {
          select: {
            participants: {
              where: { userId, status: "ACCEPTED" },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    });
  },

  // Capability guard for dynamic race routes. Deliberately lean: old clients
  // poll progress frequently, so checking whether an opaque id is a private
  // seeded bucket must not hydrate the full participant/accessory graph.
  async findSeededBucketMarker(id) {
    return prisma.race.findUnique({
      where: { id },
      select: { seededBucketId: true },
    });
  },

  async findById(id) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        ...detailsRelationInclude,
        // Tournament context for a matchup race's banner (additive; null on
        // ordinary races) is part of detailsRelationInclude.
        ...participantInclude,
      },
    });
  },

  async findProgressScoringContext(id) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        participants: { orderBy: detailsParticipantOrder },
        tournament: { select: { id: true, name: true, bracketSize: true } },
      },
    });
  },

  // Payout projection context for a participant-paged progress request. The
  // page access query intentionally carries only the viewer row, while money
  // math must use the complete accepted field. This second read stays scalar
  // and Postgres-owned; no user/cosmetic graph or Redis snapshot participates.
  async findProgressMoneyContext(id) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        participants: {
          select: {
            id: true,
            userId: true,
            status: true,
            totalSteps: true,
            placement: true,
            payoutCoins: true,
            forfeitedAt: true,
            rawSteps: true,
          },
        },
      },
    });
  },

  // Page-scoped progress context. Unlike findProgressScoringContext this never
  // hydrates the race-wide participant relation: the request path only needs
  // race metadata and the authenticated viewer's membership row.
  async findProgressPageContext(id, userId) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        participants: {
          where: { userId },
          take: 1,
        },
        tournament: { select: { id: true, name: true, bracketSize: true } },
      },
    });
  },

  async findProgressStatus(id) {
    return prisma.race.findUnique({
      where: { id },
      select: { status: true, winnerTeam: true },
    });
  },

  // Race scalars + the four display relations, with NO participants. See the
  // "Paged race-detail read plan" note above.
  async findDetailsCore(id) {
    return prisma.race.findUnique({
      where: { id },
      include: detailsRelationInclude,
    });
  },

  // Every participant row, scalars only — no user / cosmetic join.
  async findDetailsParticipantSummaries(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId },
      select: detailsParticipantSummarySelect,
      orderBy: detailsParticipantOrder,
    });
  },

  // ONE page of participants, cosmetics included, LIMIT/OFFSET pushed into the
  // database rather than sliced in JS after the fact.
  async findDetailsParticipantPage(raceId, { skip = 0, take = 10 } = {}) {
    return prisma.raceParticipant.findMany({
      where: { raceId },
      include: { user: participantCosmeticUserSelect },
      orderBy: detailsParticipantOrder,
      skip,
      take,
    });
  },

  async findMysteryBoxContext(id) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
        isTeamRace: true,
        teamSize: true,
        participants: {
          select: mysteryBoxParticipantSelect,
          orderBy: { joinedAt: "asc" },
        },
      },
    });
  },

  async findPowerupUseContext(id) {
    return prisma.race.findUnique({
      where: { id },
      select: resolutionRaceSelect,
    });
  },

  async findPowerupUseContextV1(id, casterUserId) {
    return prisma.$transaction(async (tx) => {
      const race = await tx.race.findUnique({
        where: { id },
        select: {
          ...powerupUseRaceScalars,
          participants: {
            where: { status: "ACCEPTED" },
            select: powerupUseRosterParticipantSelect,
            orderBy: { joinedAt: "asc" },
          },
        },
      });
      const caster = await tx.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: id, userId: casterUserId } },
        select: powerupUseCasterSelect,
      });
      if (!race || !caster || caster.status !== "ACCEPTED") return race;
      race.participants = race.participants.map((participant) =>
        participant.userId === casterUserId ? caster : participant
      );
      return race;
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  },

  // Target-picker read: accepted identity/team/forfeit rows only. It is
  // intentionally distinct from the POST-use resolution read because picker
  // data is advisory; the mutation always revalidates against fresh state.
  async findPowerupTargetContext(id) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        powerupsEnabled: true,
        participants: {
          where: { status: "ACCEPTED" },
          select: {
            id: true,
            userId: true,
            status: true,
            totalSteps: true,
            finishedAt: true,
            placement: true,
            forfeitedAt: true,
            team: true,
            joinedAt: true,
            powerupSlots: true,
            user: {
              select: { displayName: true, profilePhotoUrl: true },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
  },

  async findSneakySwapTargetContext(id) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        isTeamRace: true,
        participants: {
          select: {
            id: true,
            userId: true,
            status: true,
            finishedAt: true,
            forfeitedAt: true,
            team: true,
            joinedAt: true,
            user: { select: { displayName: true } },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
    });
  },

  async findForResolution(id) {
    return prisma.race.findUnique({
      where: { id },
      select: resolutionRaceSelect,
    });
  },

  async findPowerupRepairContext(id, userId) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
        participants: {
          where: { userId },
          select: {
            id: true,
            userId: true,
            status: true,
            powerupSlots: true,
            bonusSteps: true,
            maxBonusSteps: true,
            nextBoxAtSteps: true,
            finishedAt: true,
            finishTotalSteps: true,
          },
        },
      },
    });
  },

  // Resolve a race by its opaque share token (see shared/lib/shareToken). Mirrors
  // findById's include so the share preview + share-token join see the same
  // creator/participant shape. Returns null for an unknown/revoked token.
  async findByShareToken(shareToken) {
    if (!shareToken) return null;
    return prisma.race.findUnique({
      where: { shareToken },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        seed: { select: { kind: true } },
        ...participantInclude,
      },
    });
  },

  async create({
    creatorId,
    name,
    targetSteps,
    maxDurationDays,
    powerupsEnabled = false,
    powerupStepInterval = null,
    buyInAmount = 0,
    payoutPreset = "WINNER_TAKES_ALL",
    potCoins = 0,
    // App-funded prize pool discriminator. Defaults false so every legacy caller
    // (and every existing row) keeps the buy-in model.
    fundedPrize = false,
    prizeCoinUnit = null,
    prizePoolMaxCoins = null,
    prizeCalculationVersion = 1,
    payoutRoundingVersion = 0,
    // Creation-stamped exit protocol. Defaults false so all direct/legacy
    // callers preserve their existing race lifecycle.
    exitActionsEnabled = false,
    isPublic = false,
    maxParticipants = 10,
    scheduledStartAt = null,
    // Optional exact end instant for a custom race window. NULL (every legacy
    // caller, every seeded race, every frozen client) = duration-derived end.
    scheduledEndAt = null,
    // Canonical IANA tz that buckets this race's steps. NULL keeps the legacy
    // (caller-tz live, UTC settlement) behavior for callers that don't supply one.
    timezone = null,
    // TR-902: createRace passes true for all new races; the schema default
    // (false) is kept for legacy callers/rows.
    timeBased = false,
    // Team races (TR-100s). All default to individual-race values.
    isTeamRace = false,
    teamSize = null,
    teamAName = null,
    teamBName = null,
    // Item 5 (2026-08-08): the team payout buff, in basis points, STAMPED here
    // and read by every projection and by settlement. NULL (the default, and
    // every pre-existing row) means 1.0 — see races/teamPoolMultiplier.js.
    teamPoolMultBps = null,
    teamPayoutVersion = null,
    teamWinnerRewardCoins = null,
    creationSource = null,
    startPolicy = null,
  }) {
    return prisma.race.create({
      data: {
        creatorId,
        name,
        targetSteps,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        potCoins,
        fundedPrize,
        prizeCoinUnit,
        prizePoolMaxCoins,
        prizeCalculationVersion,
        payoutRoundingVersion,
        exitActionsEnabled,
        isPublic,
        maxParticipants,
        scheduledStartAt,
        scheduledEndAt,
        timezone,
        timeBased,
        isTeamRace,
        teamSize,
        teamAName,
        teamBName,
        teamPoolMultBps,
        teamPayoutVersion,
        teamWinnerRewardCoins,
        creationSource,
        startPolicy,
      },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
    });
  },

  async update(id, fields) {
    return prisma.race.update({
      where: { id },
      data: fields,
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
    });
  },

  async addToPot(id, amount) {
    return prisma.race.update({
      where: { id },
      data: { potCoins: { increment: amount } },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
    });
  },

  async updateIfActive(id, fields) {
    return prisma.race.updateMany({
      where: { id, status: "ACTIVE" },
      data: fields,
    });
  },

  // Conditional PENDING -> (ACTIVE/...) transition. Returns { count } so a caller
  // can act ONLY when it actually flipped the row — two concurrent starters
  // (manual Start racing the auto-start cron, or two server instances) both read
  // PENDING, but only one updateMany matches; the loser sees count === 0 and must
  // not re-emit RACE_STARTED. Mirrors updateIfActive used by completeRace.
  async updateIfPending(id, fields) {
    return prisma.race.updateMany({
      where: { id, status: "PENDING" },
      data: fields,
    });
  },

  async findForUser(userId) {
    // A declined invite removes the race from the user's world — it must
    // not surface in any of their active/pending/completed lists.
    const participantFilter = {
      participants: { some: { userId, status: { not: "DECLINED" } } },
    };
    const include = {
      creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      ...participantInclude,
    };

    // Completed races are capped to the most recent few: the races tab shows
    // them in a collapsed-by-default history section, and long-time users
    // accumulate dozens — shipping them all (with full participant data) made
    // /races the app's largest payload. Response shape is unchanged, so older
    // app builds simply see a shorter history.
    const [current, completed] = await Promise.all([
      prisma.race.findMany({
        where: { ...participantFilter, status: { not: "COMPLETED" } },
        include,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.race.findMany({
        where: { ...participantFilter, status: "COMPLETED" },
        include,
        orderBy: { completedAt: "desc" },
        take: 10,
      }),
    ]);

    // Preserve the historical single-query ordering (updatedAt desc across
    // the combined list); getRaces buckets by status either way.
    return [...current, ...completed].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  },

  // Stable candidate rows for the split GET /races cache. Membership is still
  // scoped by user in SQL; only the resulting race metadata is eligible for
  // Redis. The viewer participant and all live roster state are loaded by the
  // summary query after this projection is read.
  async findRaceListStableForUser(userId, extraCompletedRaceIds = []) {
    const participantFilter = {
      participants: { some: { userId, status: { not: "DECLINED" } } },
    };
    const [current, completed, injectedCompleted] = await Promise.all([
      prisma.race.findMany({
        where: { ...participantFilter, status: { not: "COMPLETED" } },
        select: raceListStableSelect,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.race.findMany({
        where: { ...participantFilter, status: "COMPLETED" },
        select: raceListStableSelect,
        orderBy: { completedAt: "desc" },
        take: 10,
      }),
      extraCompletedRaceIds.length > 0
        ? prisma.race.findMany({
            where: {
              ...participantFilter,
              status: "COMPLETED",
              id: { in: extraCompletedRaceIds },
            },
            select: raceListStableSelect,
            orderBy: { completedAt: "desc" },
          })
        : Promise.resolve([]),
    ]);
    const completedById = new Map(
      [...completed, ...injectedCompleted].map((race) => [race.id, race]),
    );
    return hydrateRaceListPeople([...current, ...completedById.values()].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    ));
  },

  // Compact launch path: one participant-indexed query returns both race
  // membership and the viewer fields needed by the list overlay. The shared
  // page projection supplies race-wide counts/rank/leader, so a cold app open
  // never runs the 10k-roster SQL summary or duplicate membership queries.
  async findBoundedRaceListForUser(userId, extraCompletedRaceIds = []) {
    const select = {
        id: true, raceId: true, userId: true, status: true, placement: true,
        favoritedAt: true, buyInStatus: true, payoutCoins: true,
        resultsSeenAt: true, inviteExpiresAt: true, team: true,
        forfeitedAt: true,
        race: { select: raceListStableSelect },
      };
    const rows = await raceListReadBatch.loadRows({
      prisma, userId, select,
    });
    const current = [];
    const completed = [];
    for (const row of rows) {
      if (!row.race) continue;
      const race = { ...row.race, _viewerParticipant: {
        id: row.id, raceId: row.raceId, userId: row.userId,
        status: row.status, placement: row.placement,
        favoritedAt: row.favoritedAt, buyInStatus: row.buyInStatus,
        payoutCoins: row.payoutCoins, resultsSeenAt: row.resultsSeenAt,
        inviteExpiresAt: row.inviteExpiresAt, team: row.team,
        forfeitedAt: row.forfeitedAt,
      } };
      if (race.status === "COMPLETED") completed.push(race);
      else current.push(race);
    }
    completed.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    const injected = new Set(extraCompletedRaceIds || []);
    const selectedCompleted = completed.filter((race, index) =>
      index < 10 || injected.has(race.id));
    return hydrateRaceListPeople([...current, ...selectedCompleted].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
  },

  // Lean variant of findForUser for the GET /races list summaries (Phase B1).
  // Same where clauses, ordering, and completed-cap as findForUser, but the
  // participant select drops the deep user/equipped-accessory/shop-item relations
  // — getRaces never reads them (it renders row summaries, not capybaras). Keeps
  // creator/winner (used for the summary's creator/winner blocks). findForUser is
  // left unchanged for other callers.
  async findSummariesForUser(userId, extraCompletedRaceIds = []) {
    const participantFilter = {
      participants: { some: { userId, status: { not: "DECLINED" } } },
    };
    const leanParticipants = {
      participants: {
        select: {
          id: true,
          userId: true,
          status: true,
          totalSteps: true,
          // Item 16 (2026-07-26): feeds `teams.asOf` on GET /races. Omitting it
          // from this select would silently read undefined and always emit null.
          totalsUpdatedAt: true,
          placement: true,
          favoritedAt: true,
          finishedAt: true,
          joinedAt: true,
          buyInStatus: true,
          buyInAmount: true,
          payoutCoins: true,
          resultsSeenAt: true,
          inviteExpiresAt: true,
          team: true,
          forfeitedAt: true,
        },
        orderBy: { joinedAt: "asc" },
      },
    };
    const include = {
      creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      ...leanParticipants,
    };

    const [current, completed, injectedCompleted] = await Promise.all([
      prisma.race.findMany({
        where: { ...participantFilter, status: { not: "COMPLETED" } },
        include,
        orderBy: { updatedAt: "desc" },
      }),
      prisma.race.findMany({
        where: { ...participantFilter, status: "COMPLETED" },
        include,
        orderBy: { completedAt: "desc" },
        take: 10,
      }),
      extraCompletedRaceIds.length > 0
        ? prisma.race.findMany({
            where: {
              ...participantFilter,
              status: "COMPLETED",
              id: { in: extraCompletedRaceIds },
            },
            include,
            orderBy: { completedAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

    const completedById = new Map(
      [...completed, ...injectedCompleted].map((race) => [race.id, race]),
    );
    return [...current, ...completedById.values()].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  },

  async findSqlSummariesForUser(
    userId,
    extraCompletedRaceIds = [],
    { stableRaces = null, stableSource = null } = {},
  ) {
    const participantFilter = {
      participants: { some: { userId, status: { not: "DECLINED" } } },
    };
    const relations = {
      creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
    };
    const stableRaceIds = Array.isArray(stableRaces)
      ? stableRaces.map((race) => race?.id).filter(Boolean)
      : null;
    const stableWhere = stableRaceIds
      ? { id: { in: stableRaceIds } }
      : {};
    const stableMembership = Array.isArray(stableRaces) && stableSource !== "postgres"
      ? await prisma.race.findMany({
          where: { ...participantFilter, ...stableWhere },
          select: { id: true, status: true },
        })
      : null;
    const stableStatusById = new Map(
      (stableMembership || []).map((race) => [race.id, race.status]),
    );
    const [current, completed, injectedCompleted] = await Promise.all([
      Array.isArray(stableRaces)
        ? Promise.resolve(stableRaces.filter((race) =>
            (stableMembership == null || stableStatusById.get(race?.id) != null) &&
            (stableMembership == null || stableStatusById.get(race.id) !== "COMPLETED")
          ))
        : prisma.race.findMany({
        where: { ...participantFilter, ...stableWhere, status: { not: "COMPLETED" } },
        include: relations,
        orderBy: { updatedAt: "desc" },
      }),
      Array.isArray(stableRaces)
        ? Promise.resolve(stableRaces.filter((race) =>
            stableMembership == null
              ? race?.status === "COMPLETED"
              : stableStatusById.get(race?.id) === "COMPLETED"
          ))
        : prisma.race.findMany({
        where: { ...participantFilter, ...stableWhere, status: "COMPLETED" },
        include: relations,
        orderBy: { completedAt: "desc" },
        take: 10,
      }),
      extraCompletedRaceIds.length > 0
        ? prisma.race.findMany({
            where: {
              ...participantFilter,
              status: "COMPLETED",
              id: { in: extraCompletedRaceIds },
            },
            include: relations,
            orderBy: { completedAt: "desc" },
          })
        : Promise.resolve([]),
    ]);
    const completedById = new Map(
      [...completed, ...injectedCompleted].map((race) => [race.id, race])
    );
    const races = [...current, ...completedById.values()].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    if (races.length === 0) {
      return { ambiguousFinisherOrder: false, races: [] };
    }
    const ids = races.map((race) => race.id);

    const raceSetKey = [...ids].sort().join("\u0000");
    const rows = await raceSqlSummaryReadBatch.load({
      prisma,
      raceSetKey,
      userId,
      execute: async (viewerUserIds) => {
        // Rank the shared roster once for this race set. Viewer-specific
        // participant rows are fetched separately below so Postgres does not
        // send the (potentially 10k-entry) rankRoster once per viewer.
        const sharedRows = await prisma.$queryRaw`
      WITH accepted AS (
        SELECT
          rp.*,
          ROW_NUMBER() OVER (
            PARTITION BY rp.race_id
            ORDER BY
              CASE WHEN rp.finished_at IS NOT NULL THEN 0 ELSE 1 END ASC,
              CASE WHEN rp.finished_at IS NOT NULL
                   THEN COALESCE(rp.placement::bigint, 9007199254740991) END ASC,
              CASE WHEN rp.finished_at IS NOT NULL THEN rp.finished_at END ASC,
              CASE WHEN rp.finished_at IS NULL THEN COALESCE(rp.total_steps, 0) END DESC,
              COALESCE(rp.joined_at, TIMESTAMP '1970-01-01 00:00:00') ASC,
              rp.user_id COLLATE "C" ASC
          ) AS persisted_position,
          COUNT(*) OVER (
            PARTITION BY rp.race_id, rp.placement, rp.finished_at
          ) AS finish_key_count,
          race_scope.powerups_enabled
        FROM race_participants rp
        JOIN races race_scope ON race_scope.id = rp.race_id
        WHERE rp.race_id IN (${Prisma.join(ids)})
          AND rp.status = 'accepted'::"RaceParticipantStatus"
      ), aggregates AS (
        SELECT
          race_id,
          COUNT(*)::int AS accepted_count,
          COUNT(*) FILTER (WHERE team = 'team_a'::"RaceTeam")::int AS team_a_count,
          COUNT(*) FILTER (WHERE team = 'team_b'::"RaceTeam")::int AS team_b_count,
          COUNT(*) FILTER (
            WHERE team = 'team_a'::"RaceTeam" AND forfeited_at IS NULL
          )::int AS team_a_payout_recipient_count,
          COUNT(*) FILTER (
            WHERE team = 'team_b'::"RaceTeam" AND forfeited_at IS NULL
          )::int AS team_b_payout_recipient_count,
          COALESCE(
            ARRAY_AGG(
              payout_coins
              ORDER BY payout_coins DESC, user_id COLLATE "C" ASC
            ) FILTER (WHERE payout_coins > 0),
            ARRAY[]::integer[]
          ) AS completed_payouts,
          COALESCE(SUM(total_steps) FILTER (WHERE team = 'team_a'::"RaceTeam"), 0)::bigint AS team_a_steps,
          COALESCE(SUM(total_steps) FILTER (WHERE team = 'team_b'::"RaceTeam"), 0)::bigint AS team_b_steps,
          MAX(totals_updated_at) AS totals_as_of,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', id,
                'userId', user_id,
                'finishedAt', finished_at,
                'placement', persisted_position
              )
              ORDER BY persisted_position
            ) FILTER (WHERE powerups_enabled = TRUE),
            '[]'::jsonb
          ) AS rank_roster,
          COALESCE(
            JSONB_OBJECT_AGG(user_id, persisted_position)
              FILTER (WHERE user_id IN (${Prisma.join(viewerUserIds)})),
            '{}'::jsonb
          ) AS viewer_positions,
          BOOL_OR(finished_at IS NOT NULL AND finish_key_count > 1) AS ambiguous_finisher_order
        FROM accepted
        GROUP BY race_id, powerups_enabled
      )
      SELECT
        r.id AS "raceId",
        COALESCE(a.accepted_count, 0)::int AS "acceptedCount",
        COALESCE(a.team_a_count, 0)::int AS "teamACount",
        COALESCE(a.team_b_count, 0)::int AS "teamBCount",
        COALESCE(a.team_a_payout_recipient_count, 0)::int AS "teamAPayoutRecipientCount",
        COALESCE(a.team_b_payout_recipient_count, 0)::int AS "teamBPayoutRecipientCount",
        COALESCE(a.completed_payouts, ARRAY[]::integer[]) AS "completedPayouts",
        COALESCE(a.team_a_steps, 0)::text AS "teamASteps",
        COALESCE(a.team_b_steps, 0)::text AS "teamBSteps",
        a.totals_as_of AS "totalsAsOf",
        COALESCE(a.rank_roster, '[]'::jsonb) AS "rankRoster",
        COALESCE(a.viewer_positions, '{}'::jsonb) AS "viewerPositions",
        COALESCE(a.ambiguous_finisher_order, FALSE) AS "ambiguousFinisherOrder",
        leader.id AS "leaderParticipantId",
        leader.user_id AS "leaderUserId",
        leader.total_steps AS "leaderTotalSteps",
        leader.placement AS "leaderPlacement",
        leader.finished_at AS "leaderFinishedAt",
        leader.joined_at AS "leaderJoinedAt"
      FROM races r
      LEFT JOIN aggregates a ON a.race_id = r.id
      LEFT JOIN accepted leader
        ON leader.race_id = r.id AND leader.persisted_position = 1
      WHERE r.id IN (${Prisma.join(ids)})
    `;
        const viewerRows = await prisma.raceParticipant.findMany({
          where: {
            raceId: { in: ids },
            userId: { in: viewerUserIds },
            status: { not: "DECLINED" },
          },
          select: {
            id: true,
            raceId: true,
            userId: true,
            status: true,
            placement: true,
            favoritedAt: true,
            buyInStatus: true,
            payoutCoins: true,
            resultsSeenAt: true,
            inviteExpiresAt: true,
            team: true,
            forfeitedAt: true,
          },
        });
        const viewersByRaceAndUser = new Map(viewerRows.map((viewer) => [
          `${viewer.raceId}\u0000${viewer.userId}`,
          viewer,
        ]));
        return viewerUserIds.flatMap((viewerUserId) => sharedRows.map((shared) => {
          const viewer = viewersByRaceAndUser.get(
            `${shared.raceId}\u0000${viewerUserId}`,
          );
          const viewerPosition = shared.viewerPositions?.[viewerUserId] ?? null;
          return {
            ...shared,
            viewerUserId,
            viewerParticipantId: viewer?.id || null,
            viewerStatus: viewer?.status || null,
            viewerPlacement: viewer?.placement ?? null,
            viewerFavoritedAt: viewer?.favoritedAt || null,
            viewerBuyInStatus: viewer?.buyInStatus || null,
            viewerPayoutCoins: viewer?.payoutCoins ?? null,
            viewerResultsSeenAt: viewer?.resultsSeenAt || null,
            viewerInviteExpiresAt: viewer?.inviteExpiresAt || null,
            viewerTeam: viewer?.team || null,
            viewerForfeitedAt: viewer?.forfeitedAt || null,
            viewerPosition,
          };
        }));
      },
    });
    if (rows.some((row) => row.ambiguousFinisherOrder === true)) {
      return { ambiguousFinisherOrder: true, races: [] };
    }
    const byRaceId = new Map(rows.map((row) => [row.raceId, row]));
    return {
      ambiguousFinisherOrder: false,
      races: races.map((race) => {
        const row = byRaceId.get(race.id) || {};
        const viewer = row.viewerParticipantId
          ? {
              id: row.viewerParticipantId,
              userId,
              status: String(row.viewerStatus || "").toUpperCase(),
              placement: row.viewerPlacement,
              favoritedAt: row.viewerFavoritedAt,
              buyInStatus: String(row.viewerBuyInStatus || "NONE").toUpperCase(),
              payoutCoins: row.viewerPayoutCoins,
              resultsSeenAt: row.viewerResultsSeenAt,
              inviteExpiresAt: row.viewerInviteExpiresAt,
              team: row.viewerTeam ? String(row.viewerTeam).toUpperCase() : null,
              forfeitedAt: row.viewerForfeitedAt,
            }
          : null;
        const leader = row.leaderParticipantId
          ? {
              id: row.leaderParticipantId,
              userId: row.leaderUserId,
              status: "ACCEPTED",
              totalSteps: row.leaderTotalSteps,
              placement: row.leaderPlacement,
              finishedAt: row.leaderFinishedAt,
              joinedAt: row.leaderJoinedAt,
            }
          : null;
        return {
          ...race,
          participants: [viewer, leader].filter(
            (participant, index, list) => participant &&
              list.findIndex((candidate) => candidate?.id === participant.id) === index
          ),
          _listSummary: {
            acceptedCount: Number(row.acceptedCount || 0),
            rankRoster: Array.isArray(row.rankRoster) ? row.rankRoster : [],
            viewerPosition: row.viewerPosition == null
              ? null
              : Number(row.viewerPosition),
            leaderUserId: row.leaderUserId || null,
            leaderParticipantId: row.leaderParticipantId || null,
            teamA: {
              memberCount: Number(row.teamACount || 0),
              totalSteps: Number(row.teamASteps || 0),
            },
            teamB: {
              memberCount: Number(row.teamBCount || 0),
              totalSteps: Number(row.teamBSteps || 0),
            },
            // Internal money facts for the production SQL-summary path. Its
            // public participant list intentionally contains only viewer +
            // leader, which is insufficient to derive a team split. Carry the
            // full-roster counts and persisted completed awards without
            // widening the public participant payload.
            teamPayoutRecipientCount: Math.max(
              Number(row.teamAPayoutRecipientCount || 0),
              Number(row.teamBPayoutRecipientCount || 0),
            ),
            completedPayouts: Array.isArray(row.completedPayouts)
              ? row.completedPayouts.map((amount) => Number(amount || 0))
              : [],
            totalsAsOf: row.totalsAsOf || null,
          },
        };
      }),
    };
  },

  async findActiveForUser(userId) {
    // Lean fetch used only by resolveRaceState + syncRacePowerupState. These
    // services only read race id/status/startedAt/targetSteps/powerupsEnabled/
    // powerupStepInterval and participant id/userId/status/totalSteps/
    // finishedAt/finishTotalSteps/bonusSteps/maxBonusSteps/nextBoxAtSteps/
    // powerupSlots/placement + participant.user.displayName. Pulling the full
    // deep participantInclude (equipped accessories, shop items, render
    // metadata) was the dominant cost of POST /steps.
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        participants: { some: { userId, status: "ACCEPTED" } },
      },
      select: {
        id: true,
        seedId: true,
        startedAt: true,
        scheduledStartAt: true,
        status: true,
        startedAt: true,
        targetSteps: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
        // timezone is REQUIRED here: resolveRaceState buckets box progress in
        // raceTimeZone(race, "UTC"). Omitting it silently falls back to UTC
        // while the display path (findById) uses the race tz — evening-local
        // steps get double-counted (daily row + next-UTC-day samples), boxes
        // mint off the inflated basis, and the "steps to next box" countdown
        // clamps flat at one full interval (the summer-solstice incident).
        timezone: true,
        // endsAt/timeBased are read by resolveRaceState's guards: stop
        // live-resolving past endsAt (settlement owns it), and never
        // target-finish a time-based race from a step sync.
        endsAt: true,
        timeBased: true,
        // Team races: resolveRaceState freezes forfeited members and the
        // powerup-odds path ranks by TEAM totals, so the lean select must
        // carry the team fields too.
        isTeamRace: true,
        teamSize: true,
        participants: {
          select: {
            id: true,
            userId: true,
            status: true,
            totalSteps: true,
            // rawSteps is REQUIRED here (2026-08-09): every writer of
            // `totalSteps` also persists the RAW walked total MONOTONICALLY
            // (`max(existing, baseAdjusted)`), and this lean select feeds the
            // step-upload reconcile. Omitting it reads the existing value as
            // absent, so a downward re-sync would happily write the lower
            // number back and move a player's drop-odds position backwards.
            rawSteps: true,
            bonusSteps: true,
            maxBonusSteps: true,
            nextBoxAtSteps: true,
            powerupSlots: true,
            placement: true,
            finishedAt: true,
            finishTotalSteps: true,
            // Team races: side + forfeit freeze marker (TR-601/655).
            team: true,
            forfeitedAt: true,
            // joinedAt is REQUIRED here: resolveRaceState -> calculateBaseAdjusted
            // -> getEffectiveStart clamps the box/step window to the real join.
            // Omitting it makes getEffectiveStart fall back to race start, which
            // sums a mid-race joiner's PRE-join steps and mints a burst of
            // milestone mystery boxes (the public-race over-grant incident).
            joinedAt: true,
            user: { select: { displayName: true } },
          },
          orderBy: { joinedAt: "asc" },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  },

  // Public races shown in the browse list. Includes both PENDING (user-created,
  // not yet started) and ACTIVE races so seeded public races — which are created
  // ACTIVE with no creator — are joinable from the browser, not just the home
  // card. Allow null-creator (seeded) races through while still hiding races
  // created by review/demo accounts.
  async findPublicPending({ excludeSeeded = false } = {}) {
    return prisma.race.findMany({
      where: {
        isPublic: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { creatorId: null },
          { creator: { isReviewAccount: false } },
        ],
        // Seeded races are joinable from the browse list only when ACTIVE. Their
        // pre-created PENDING "next" race is surfaced ONLY via
        // getFeaturedRaces.upcoming, so old app builds — which would mis-render a
        // not-yet-started race here with an "ends in" countdown — never see it.
        // User-created (seedId null) PENDING races still appear as before.
        NOT: { status: "PENDING", seedId: { not: null } },
        // Capable bucket clients must not receive the mixed-version legacy
        // seeded stream. Keep this predicate in SQL (rather than filtering the
        // serialized cards) so neither rows nor their participant counts can
        // accidentally leak into another consumer.
        ...(excludeSeeded ? { seedId: null } : {}),
      },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // Home Suggested Races: one bounded Postgres read whose COMPLETE eligibility
  // predicate runs before LIMIT 4. This is deliberately separate from the
  // legacy browse query above: /races/public must remain exhaustive and
  // byte-compatible, while Home must not let a window of newer ineligible rows
  // hide an older joinable race.
  async findPublicSuggestions({
    userId,
    supportsTeamRaces = false,
    excludeSeeded = false,
    limit = 4,
  }) {
    const teamPredicate = supportsTeamRaces
      ? Prisma.sql`AND (r.is_team_race = FALSE OR r.status = 'pending'::"RaceStatus")`
      : Prisma.sql`AND r.is_team_race = FALSE`;
    const seedPredicate = excludeSeeded
      ? Prisma.sql`AND r.seed_id IS NULL`
      : Prisma.empty;

    return prisma.$queryRaw`
      SELECT
        r.id,
        r.name,
        r.status::text AS status,
        r.max_duration_days AS "maxDurationDays",
        r.ends_at AS "endsAt",
        r.scheduled_start_at AS "scheduledStartAt",
        r.scheduled_end_at AS "scheduledEndAt",
        r.started_at AS "startedAt",
        r.target_steps AS "targetSteps",
        r.buy_in_amount AS "buyInAmount",
        r.payout_preset::text AS "payoutPreset",
        r.pot_coins AS "potCoins",
        r.funded_prize AS "fundedPrize",
        r.payout_rounding_version AS "payoutRoundingVersion",
        r.prize_pool_coins AS "prizePoolCoins",
        r.prize_coin_unit AS "prizeCoinUnit",
        r.prize_pool_max_coins AS "prizePoolMaxCoins",
        r.prize_calculation_version AS "prizeCalculationVersion",
        r.payout_curve AS "payoutCurve",
        r.powerups_enabled AS "powerupsEnabled",
        r.powerup_step_interval AS "powerupStepInterval",
        r.exit_actions_enabled AS "exitActionsEnabled",
        r.max_participants AS "maxParticipants",
        r.is_team_race AS "isTeamRace",
        r.team_size AS "teamSize",
        r.team_a_name AS "teamAName",
        r.team_b_name AS "teamBName",
        r.team_pool_mult_bps AS "teamPoolMultBps",
        r.team_payout_version AS "teamPayoutVersion",
        r.team_winner_reward_coins AS "teamWinnerRewardCoins",
        r.seed_id AS "seedId",
        r.creation_source AS "creationSource",
        r.start_policy AS "startPolicy",
        r.created_at AS "createdAt",
        COALESCE(parts.accepted_count, 0)::int AS "acceptedCount",
        COALESCE(parts.rows, '[]'::jsonb) AS participants
      FROM races r
      LEFT JOIN users creator ON creator.id = r.creator_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE rp.status = 'accepted'::"RaceParticipantStatus") AS accepted_count,
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'userId', rp.user_id,
              'status', UPPER(rp.status::text),
              'buyInStatus', UPPER(rp.buy_in_status::text),
              'buyInAmount', rp.buy_in_amount,
              'team', CASE WHEN rp.team IS NULL THEN NULL ELSE UPPER(rp.team::text) END,
              'totalSteps', rp.total_steps,
              'forfeitedAt', rp.forfeited_at,
              'totalsUpdatedAt', rp.totals_updated_at
            )
            ORDER BY rp.joined_at ASC
          ) AS rows
        FROM race_participants rp
        WHERE rp.race_id = r.id
      ) parts ON TRUE
      WHERE r.is_public = TRUE
        AND r.status IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
        AND r.tournament_id IS NULL
        AND (r.creator_id IS NULL OR creator.is_review_account = FALSE)
        AND NOT (r.status = 'pending'::"RaceStatus" AND r.seed_id IS NOT NULL)
        ${seedPredicate}
        ${teamPredicate}
        AND NOT EXISTS (
          SELECT 1
          FROM race_participants mine
          WHERE mine.race_id = r.id AND mine.user_id = ${userId}
        )
        AND (
          r.max_participants IS NULL
          OR COALESCE(parts.accepted_count, 0) < r.max_participants
        )
      ORDER BY r.created_at DESC, r.id ASC
      LIMIT ${limit}
    `;
  },

  // Lean variant of findPublicPending: the SAME where clause, but selecting only
  // the fields the public-race visibility predicate needs (id, tournamentId,
  // isTeamRace, status, maxParticipants, participants.userId/status). Used by
  // getPublicRaceCount so the Races tab can show a public-race count without
  // transferring full public race cards. Membership/capacity/seed/team rules
  // stay identical because the where clause and predicate are shared.
  async findPublicPendingLean({ excludeSeeded = false } = {}) {
    return prisma.race.findMany({
      where: {
        isPublic: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [{ creatorId: null }, { creator: { isReviewAccount: false } }],
        NOT: { status: "PENDING", seedId: { not: null } },
        ...(excludeSeeded ? { seedId: null } : {}),
      },
      select: {
        id: true,
        seedId: true,
        startedAt: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
        tournamentId: true,
        isTeamRace: true,
        status: true,
        maxParticipants: true,
        participants: { select: { userId: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async countVisiblePublicRaces({
    userId,
    supportsTeamRaces = false,
    excludeSeeded = false,
    hiddenSeededWindows = [],
  }) {
    const teamPredicate = supportsTeamRaces
      ? Prisma.sql`AND (r.is_team_race = FALSE OR r.status = 'pending'::"RaceStatus")`
      : Prisma.sql`AND r.is_team_race = FALSE`;
    const seedPredicate = excludeSeeded
      ? Prisma.sql`AND r.seed_id IS NULL`
      : Prisma.empty;
    const hiddenPredicates = (hiddenSeededWindows || [])
      .filter((row) => row?.seedId && row?.windowStart)
      .map((row) => Prisma.sql`(
        r.seed_id = ${row.seedId}
        AND COALESCE(r.scheduled_start_at, r.started_at) = ${new Date(row.windowStart)}
      )`);
    const hiddenPredicate = hiddenPredicates.length > 0
      ? Prisma.sql`AND NOT (${Prisma.join(hiddenPredicates, " OR ")})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM races r
      LEFT JOIN users creator ON creator.id = r.creator_id
      WHERE r.is_public = TRUE
        AND r.status IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
        AND r.tournament_id IS NULL
        AND (r.creator_id IS NULL OR creator.is_review_account = FALSE)
        AND NOT (r.status = 'pending'::"RaceStatus" AND r.seed_id IS NOT NULL)
        ${seedPredicate}
        ${teamPredicate}
        ${hiddenPredicate}
        AND NOT EXISTS (
          SELECT 1 FROM race_participants mine
          WHERE mine.race_id = r.id AND mine.user_id = ${userId}
        )
        AND (
          r.max_participants IS NULL OR (
            SELECT COUNT(*)
            FROM race_participants accepted
            WHERE accepted.race_id = r.id
              AND accepted.status = 'accepted'::"RaceParticipantStatus"
          ) < r.max_participants
        )
    `;
    return Number(rows[0]?.count || 0);
  },

  // Distinct userIds of ACCEPTED participants in currently-ACTIVE races. Used
  // by the global-step-event scheduler to fan out the "2x event started" push.
  async findActiveParticipantUserIds() {
    const rows = await prisma.raceParticipant.findMany({
      where: { status: "ACCEPTED", race: { status: "ACTIVE" } },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.map((r) => r.userId);
  },

  async findActiveIds() {
    const rows = await prisma.race.findMany({
      where: { status: "ACTIVE", startedAt: { not: null } },
      select: { id: true, timezone: true },
      orderBy: { id: "asc" },
    });
    return rows;
  },

  async findActiveExpired(now) {
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        endsAt: { lte: now },
      },
      include: {
        ...participantInclude,
      },
    });
  },

  // ACTIVE races that have NOT yet expired — the complement of findActiveExpired,
  // used by the live placement-recompute job (Phase 0). Excludes endsAt <= now so
  // the live job never collides with raceExpiry's settlement; includes endsAt:null
  // (open-ended target races, which raceExpiry never settles) so they still get
  // live updates. Lean select: the job needs id (to call resolveRaceState), name
  // (for the placement-change push body), and payoutPreset/potCoins so it can
  // derive how many places are "in the money" — the threshold a meaningful
  // placement alert is gated on — plus endsAt so it can pick out the "final
  // stretch" races (ending within the hour) for a tighter step-sync nudge.
  // endsAt is null for open-ended step-target races (those are never final-stretch).
  async findActiveInProgress(now) {
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        OR: [{ endsAt: { gt: now } }, { endsAt: null }],
      },
      select: {
        id: true,
        name: true,
        payoutPreset: true,
        potCoins: true,
        // App-funded races carry no pot, so the "in the money" threshold the
        // placement alert is gated on has to be derived from the pool formula
        // instead — which needs the discriminator plus the duration band.
        fundedPrize: true,
        // payoutCurve (additive): the paid-place count is curve-independent, but
        // this lean select is exactly the kind of place where omitting the
        // column would silently downgrade a stamped race to the even split.
        payoutCurve: true,
        maxDurationDays: true,
        // startedAt (additive): the race-ending-soon reminder needs the total
        // scheduled duration (endsAt - startedAt) to skip sub-2h seeded races
        // that start already inside the 2h window (§8 short-race guard).
        startedAt: true,
        // seedId (additive): the race-ending-soon reminder is suppressed for the
        // seeded daily/weekly challenges — every opted-in user is auto-enrolled
        // in those daily, so the nudge would be a push nobody asked for. Must
        // stay in this select or the skip silently reads undefined.
        seedId: true,
        endsAt: true,
        // Team races: the recompute job suppresses individual placement events
        // and evaluates team lead-change / final-stretch / slacker pushes
        // instead (TR-681/682/683/685).
        isTeamRace: true,
        teamSize: true,
        teamAName: true,
        teamBName: true,
        // Batch 2026-07-26 (B-12b): the placement cron must resolve the race's
        // OWN timezone rather than falling through to UTC. Omitting `timezone`
        // from this select is the exact trap that made the cron score in UTC
        // while every live surface scored in the race tz.
        timezone: true,
        creator: { select: { timezone: true } },
      },
    });
  },

  // PENDING, user-created (non-seeded) races whose scheduledStartAt has arrived.
  // Used by the autoStartScheduledRaces cron job (1.1.7). Seeded races
  // (seedId != null) are excluded — they have their own auto-start/renewal in
  // seededRaceRenewal.js. A lean select is fine; the job only needs the race id
  // and creatorId to call startRace, plus the scheduledStartAt for anchoring.
  async findScheduledDue(now) {
    return prisma.race.findMany({
      where: {
        status: "PENDING",
        seedId: null,
        scheduledStartAt: { not: null, lte: now },
      },
      select: {
        id: true,
        creatorId: true,
        seedId: true,
        status: true,
        scheduledStartAt: true,
      },
    });
  },

  // Batch 2026-08-08 item 2 — backstop candidates for private-race auto-start.
  // findScheduledDue can never see these: its where clause requires
  // `scheduledStartAt: { not: null }`, so an UNSCHEDULED private race would
  // never be rescued by the cron (and a race whose last invite merely EXPIRED
  // has no inline hook to fire, because nobody ever accepts again).
  //
  // Lean select on purpose: only the fields shouldAutoStartPrivateRace reads,
  // plus creatorId for the startRace call. NOT the full participantInclude —
  // this runs every 5 minutes over every pending private race, and the
  // per-participant user/accessory joins would be pure waste.
  // Two-column gate for the inline auto-start hook (review fix 4). The hook
  // runs on EVERY join/accept/decline, but only a PENDING private race can ever
  // auto-start — so the common cases (a public join, a decline on an already
  // ACTIVE race) are rejected on this tiny read instead of paying for
  // findById's full participant/user include tree.
  async findAutoStartGate(id) {
    return prisma.race.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        isPublic: true,
        isTeamRace: true,
        creationSource: true,
        startPolicy: true,
      },
    });
  },

  // `maxAgeDays` is a DEPLOY-DAY SAFETY BOUND, not a tuning knob (review
  // blocker 2). Without it, the first cron tick after this feature is enabled
  // treats every historical PENDING private race with 2+ accepted participants
  // as a candidate — mass-starting races abandoned months ago and pushing every
  // one of their participants. A race nobody has touched in a week is dormant;
  // the creator can still start it by hand.
  async findUnscheduledPrivatePending({ limit = 500, maxAgeDays = 7 } = {}) {
    const createdSince = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    return prisma.race.findMany({
      where: {
        status: "PENDING",
        OR: [
          { isPublic: false },
          {
            creationSource: "QUICK_CREATE",
            startPolicy: "ON_MINIMUM_PARTICIPANTS",
          },
        ],
        seedId: null,
        tournamentId: null,
        scheduledStartAt: null,
        createdAt: { gte: createdSince },
      },
      select: {
        id: true,
        creatorId: true,
        status: true,
        isPublic: true,
        creationSource: true,
        startPolicy: true,
        seedId: true,
        tournamentId: true,
        scheduledStartAt: true,
        isTeamRace: true,
        teamSize: true,
        maxParticipants: true,
        participants: {
          select: {
            id: true,
            userId: true,
            status: true,
            team: true,
            inviteExpiresAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  },

  // Live (PENDING/ACTIVE) seeded races — the recurring daily/weekly challenges.
  // Used by the Featured Races section. Includes the seed kind and full
  // participants so the caller can compute counts and the viewer's join status.
  async findLiveSeeded({ legacyOnly = false } = {}) {
    return prisma.race.findMany({
      where: {
        seedId: { not: null },
        status: { in: ["PENDING", "ACTIVE"] },
        // Frozen clients retain the global seeded serializer. Private bucket
        // rows must never enter that query, even though those clients do not
        // send the capability token used by the new virtual-card path.
        ...(legacyOnly ? { seededBucketId: null } : {}),
      },
      include: {
        seed: { select: { kind: true } },
        ...participantInclude,
      },
      orderBy: { startedAt: "desc" },
    });
  },

  // The featured card needs field counts, money aggregates, and only the
  // requesting user's membership. Hydrating every participant plus their
  // profile/accessories made each app-open deserialize hundreds or thousands
  // of rows whose values never enter the response.
  async findLiveSeededSummariesForUser(userId, { legacyOnly = false } = {}) {
    const rows = await prisma.$queryRaw`
      SELECT
        r.id,
        r.seed_id AS "seedId",
        r.name,
        UPPER(r.status::text) AS status,
        r.max_participants AS "maxParticipants",
        r.powerups_enabled AS "powerupsEnabled",
        r.started_at AS "startedAt",
        r.ends_at AS "endsAt",
        r.scheduled_start_at AS "scheduledStartAt",
        r.scheduled_end_at AS "scheduledEndAt",
        r.max_duration_days AS "maxDurationDays",
        r.buy_in_amount AS "buyInAmount",
        UPPER(r.payout_preset::text) AS "payoutPreset",
        r.pot_coins AS "potCoins",
        r.funded_prize AS "fundedPrize",
        r.prize_pool_coins AS "prizePoolCoins",
        r.prize_coin_unit AS "prizeCoinUnit",
        r.prize_pool_max_coins AS "prizePoolMaxCoins",
        r.prize_calculation_version AS "prizeCalculationVersion",
        r.payout_rounding_version AS "payoutRoundingVersion",
        r.payout_curve AS "payoutCurve",
        r.exit_actions_enabled AS "exitActionsEnabled",
        r.is_team_race AS "isTeamRace",
        r.team_pool_mult_bps AS "teamPoolMultBps",
        r.team_payout_version AS "teamPayoutVersion",
        r.team_winner_reward_coins AS "teamWinnerRewardCoins",
        seed.kind AS "seedKind",
        COALESCE(summary.accepted_count, 0)::int AS "acceptedCount",
        UPPER(summary.viewer_status) AS "viewerStatus",
        COALESCE(summary.held_pot_coins, 0)::int AS "heldPotCoins",
        COALESCE(summary.funded_projection_player_count, 0)::int
          AS "fundedProjectionPlayerCount",
        GREATEST(
          COALESCE(summary.team_a_payout_recipient_count, 0),
          COALESCE(summary.team_b_payout_recipient_count, 0)
        )::int AS "teamPayoutRecipientCount"
      FROM races r
      JOIN race_seeds seed ON seed.id = r.seed_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (
            WHERE participant.status = 'accepted'::"RaceParticipantStatus"
          ) AS accepted_count,
          MAX(participant.status::text) FILTER (
            WHERE participant.user_id = ${userId}
          ) AS viewer_status,
          COALESCE(SUM(participant.buy_in_amount) FILTER (
            WHERE participant.buy_in_status = 'held'::"RaceBuyInStatus"
          ), 0) AS held_pot_coins,
          COUNT(*) FILTER (
            WHERE participant.status = 'accepted'::"RaceParticipantStatus"
              AND NOT (
                participant.forfeited_at IS NOT NULL AND
                COALESCE(participant.total_steps, 0) <= 0
              )
          ) AS funded_projection_player_count,
          COUNT(*) FILTER (
            WHERE participant.status = 'accepted'::"RaceParticipantStatus"
              AND participant.team = 'team_a'::"RaceTeam"
              AND participant.forfeited_at IS NULL
          ) AS team_a_payout_recipient_count,
          COUNT(*) FILTER (
            WHERE participant.status = 'accepted'::"RaceParticipantStatus"
              AND participant.team = 'team_b'::"RaceTeam"
              AND participant.forfeited_at IS NULL
          ) AS team_b_payout_recipient_count
        FROM race_participants participant
        WHERE participant.race_id = r.id
      ) summary ON TRUE
      WHERE r.seed_id IS NOT NULL
        AND r.status IN (
          'pending'::"RaceStatus",
          'active'::"RaceStatus"
        )
        AND (${legacyOnly} = FALSE OR r.seeded_bucket_id IS NULL)
      ORDER BY r.started_at DESC
    `;
    return rows.map((row) => ({
      ...row,
      seed: { kind: row.seedKind },
      participants: [],
      _featuredSummary: {
        acceptedCount: Number(row.acceptedCount || 0),
        viewerStatus: row.viewerStatus || null,
        heldPotCoins: Number(row.heldPotCoins || 0),
        fundedProjectionPlayerCount: Number(row.fundedProjectionPlayerCount || 0),
        teamPayoutRecipientCount: Number(row.teamPayoutRecipientCount || 0),
      },
    }));
  },

  // Home's featured branch differs from the legacy /races/featured surface:
  // joined/invited and full cards are excluded, expired ACTIVE rows are
  // excluded, and eligibility happens before the one-live-row-per-seed choice.
  // The lateral aggregate keeps this one category round-trip without loading
  // arbitrary participant relations.
  async findFeaturedSuggestions({ userId, now }) {
    return prisma.$queryRaw`
      WITH eligible AS (
        SELECT
          r.id,
          r.name,
          r.status::text AS status,
          r.ends_at AS "endsAt",
          r.started_at AS "startedAt",
          r.max_duration_days AS "maxDurationDays",
          r.buy_in_amount AS "buyInAmount",
          r.payout_preset::text AS "payoutPreset",
          r.pot_coins AS "potCoins",
          r.funded_prize AS "fundedPrize",
          r.payout_rounding_version AS "payoutRoundingVersion",
          r.prize_pool_coins AS "prizePoolCoins",
          r.prize_coin_unit AS "prizeCoinUnit",
          r.prize_pool_max_coins AS "prizePoolMaxCoins",
          r.prize_calculation_version AS "prizeCalculationVersion",
          r.payout_curve AS "payoutCurve",
          r.powerups_enabled AS "powerupsEnabled",
          r.max_participants AS "maxParticipants",
          r.is_team_race AS "isTeamRace",
          r.team_pool_mult_bps AS "teamPoolMultBps",
          r.team_payout_version AS "teamPayoutVersion",
          r.team_winner_reward_coins AS "teamWinnerRewardCoins",
          r.seed_id AS "seedId",
          seed.kind AS "seedKind",
          COALESCE(parts.accepted_count, 0)::int AS "acceptedCount",
          COALESCE(parts.rows, '[]'::jsonb) AS participants,
          ROW_NUMBER() OVER (
            PARTITION BY r.seed_id
            ORDER BY r.started_at DESC NULLS LAST, r.id ASC
          ) AS seed_rank
        FROM races r
        JOIN race_seeds seed ON seed.id = r.seed_id
        LEFT JOIN users creator ON creator.id = r.creator_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE rp.status = 'accepted'::"RaceParticipantStatus") AS accepted_count,
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'userId', rp.user_id,
                'status', UPPER(rp.status::text),
                'buyInStatus', UPPER(rp.buy_in_status::text),
                'buyInAmount', rp.buy_in_amount
              )
              ORDER BY rp.joined_at ASC
            ) AS rows
          FROM race_participants rp
          WHERE rp.race_id = r.id
        ) parts ON TRUE
        WHERE seed.kind IN ('DAILY_10K', 'WEEKLY_50K')
          AND seed.active = TRUE
          -- Home's legacy suggestion branch is consumed by frozen clients;
          -- bucket IDs and their participant aggregates are never safe there.
          AND r.seeded_bucket_id IS NULL
          AND (r.creator_id IS NULL OR creator.is_review_account = FALSE)
          AND r.status = 'active'::"RaceStatus"
          AND r.ends_at > ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM race_participants mine
            WHERE mine.race_id = r.id
              AND mine.user_id = ${userId}
              AND mine.status IN (
                'accepted'::"RaceParticipantStatus",
                'invited'::"RaceParticipantStatus"
              )
          )
          AND (
            r.max_participants IS NULL
            OR COALESCE(parts.accepted_count, 0) < r.max_participants
          )
      )
      SELECT *
      FROM eligible
      WHERE seed_rank = 1
      ORDER BY
        CASE "seedKind" WHEN 'DAILY_10K' THEN 0 WHEN 'WEEKLY_50K' THEN 1 ELSE 2 END,
        id ASC
      LIMIT 2
    `;
  },

};

module.exports = { Race, hydrateRaceListPeople };
