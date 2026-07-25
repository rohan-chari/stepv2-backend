const { prisma } = require("../../../db");

const participantInclude = {
  participants: {
    // Uses `include` (not `select`), so all RaceParticipant scalar fields —
    // including resultsSeenAt (race results "seen" ack, read by getRaces) — are
    // returned automatically. The lean findActiveForUser select does NOT need
    // resultsSeenAt; race resolution never reads it.
    include: {
      user: {
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
                },
              },
            },
          },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  },
};

const Race = {
  async findById(id) {
    return prisma.race.findUnique({
      where: { id },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        seed: { select: { kind: true } },
        // Tournament context for a matchup race's banner (additive; null on
        // ordinary races).
        tournament: { select: { id: true, name: true, bracketSize: true } },
        ...participantInclude,
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
    isPublic = false,
    maxParticipants = 10,
    scheduledStartAt = null,
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
        isPublic,
        maxParticipants,
        scheduledStartAt,
        timezone,
        timeBased,
        isTeamRace,
        teamSize,
        teamAName,
        teamBName,
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

  // Lean variant of findForUser for the GET /races list summaries (Phase B1).
  // Same where clauses, ordering, and completed-cap as findForUser, but the
  // participant select drops the deep user/equipped-accessory/shop-item relations
  // — getRaces never reads them (it renders row summaries, not capybaras). Keeps
  // creator/winner (used for the summary's creator/winner blocks). findForUser is
  // left unchanged for other callers.
  async findSummariesForUser(userId) {
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
          placement: true,
          finishedAt: true,
          joinedAt: true,
          buyInStatus: true,
          buyInAmount: true,
          payoutCoins: true,
          resultsSeenAt: true,
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

    return [...current, ...completed].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );
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
  async findPublicPending() {
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
      },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
      orderBy: { createdAt: "desc" },
    });
  },

  // Lean variant of findPublicPending: the SAME where clause, but selecting only
  // the fields the public-race visibility predicate needs (id, tournamentId,
  // isTeamRace, status, maxParticipants, participants.userId/status). Used by
  // getPublicRaceCount so the Races tab can show a public-race count without
  // transferring full public race cards. Membership/capacity/seed/team rules
  // stay identical because the where clause and predicate are shared.
  async findPublicPendingLean() {
    return prisma.race.findMany({
      where: {
        isPublic: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [{ creatorId: null }, { creator: { isReviewAccount: false } }],
        NOT: { status: "PENDING", seedId: { not: null } },
      },
      select: {
        id: true,
        tournamentId: true,
        isTeamRace: true,
        status: true,
        maxParticipants: true,
        participants: { select: { userId: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
    });
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

  // Live (PENDING/ACTIVE) seeded races — the recurring daily/weekly challenges.
  // Used by the Featured Races section. Includes the seed kind and full
  // participants so the caller can compute counts and the viewer's join status.
  async findLiveSeeded() {
    return prisma.race.findMany({
      where: {
        seedId: { not: null },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      include: {
        seed: { select: { kind: true } },
        ...participantInclude,
      },
      orderBy: { startedAt: "desc" },
    });
  },

};

module.exports = { Race };
