const { Prisma } = require("@prisma/client");
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
                  remoteOnly: true,
                  assetVersion: true,
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

const Race = {
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
    // Creation-stamped exit protocol. Defaults false so all direct/legacy
    // callers preserve their existing race lifecycle.
    exitActionsEnabled = false,
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
    // Item 5 (2026-08-08): the team payout buff, in basis points, STAMPED here
    // and read by every projection and by settlement. NULL (the default, and
    // every pre-existing row) means 1.0 — see races/teamPoolMultiplier.js.
    teamPoolMultBps = null,
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
        exitActionsEnabled,
        isPublic,
        maxParticipants,
        scheduledStartAt,
        timezone,
        timeBased,
        isTeamRace,
        teamSize,
        teamAName,
        teamBName,
        teamPoolMultBps,
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
        r.started_at AS "startedAt",
        r.target_steps AS "targetSteps",
        r.buy_in_amount AS "buyInAmount",
        r.payout_preset::text AS "payoutPreset",
        r.pot_coins AS "potCoins",
        r.funded_prize AS "fundedPrize",
        r.prize_pool_coins AS "prizePoolCoins",
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
          r.prize_pool_coins AS "prizePoolCoins",
          r.payout_curve AS "payoutCurve",
          r.powerups_enabled AS "powerupsEnabled",
          r.max_participants AS "maxParticipants",
          r.is_team_race AS "isTeamRace",
          r.team_pool_mult_bps AS "teamPoolMultBps",
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

module.exports = { Race };
