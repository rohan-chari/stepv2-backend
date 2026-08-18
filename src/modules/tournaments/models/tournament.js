const { prisma } = require("../../../db");

// User shape reused across participant + matchup-race player payloads so the
// bracket view can render capybaras with equipped cosmetics.
const userSelect = {
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

// Deep include for the full tournament payload: participants (+ user), and the
// matchup races with their two participants (+ user) so the bracket can be drawn
// in one fetch.
const tournamentInclude = {
  creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
  champion: { select: { id: true, displayName: true, profilePhotoUrl: true } },
  seed: { select: { id: true, kind: true, championPrizeCoins: true } },
  participants: {
    include: { user: userSelect },
    orderBy: { joinedAt: "asc" },
  },
  races: {
    include: {
      participants: {
        include: { user: userSelect },
        orderBy: { joinedAt: "asc" },
      },
      // ACTIVE effects only — drives the per-viewer bracket illusions (§6.4).
      activeEffects: { where: { status: "ACTIVE" } },
    },
    orderBy: [{ tournamentRound: "asc" }, { tournamentMatchIndex: "asc" }],
  },
};

// Lean include for summary listings (no matchup races / cosmetics).
const summaryInclude = {
  creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
  seed: { select: { id: true, kind: true, championPrizeCoins: true } },
  participants: {
    select: {
      userId: true,
      status: true,
      seed: true,
      eliminatedInRound: true,
      joinedAt: true,
    },
  },
};

const Tournament = {
  async findById(id) {
    return prisma.tournament.findUnique({
      where: { id },
      include: tournamentInclude,
    });
  },

  async findDetailV1(id) {
    return prisma.tournament.findUnique({
      where: { id },
      select: {
        id: true,
        creatorId: true,
        seedId: true,
        name: true,
        status: true,
        bracketSize: true,
        matchupDurationDays: true,
        buyInAmount: true,
        potCoins: true,
        fundedPrize: true,
        prizePoolCoins: true,
        payoutRoundingVersion: true,
        payoutRoundingMetadata: true,
        powerupsEnabled: true,
        powerupStepInterval: true,
        isPublic: true,
        shareToken: true,
        currentRound: true,
        totalRounds: true,
        championUserId: true,
        championPrizeCoinsSnapshot: true,
        startedAt: true,
        completedAt: true,
        seed: {
          select: { id: true, kind: true, championPrizeCoins: true },
        },
        participants: {
          select: {
            userId: true,
            status: true,
            seed: true,
            eliminatedInRound: true,
            joinedAt: true,
            user: {
              select: {
                id: true,
                displayName: true,
                profilePhotoUrl: true,
              },
            },
          },
          orderBy: { joinedAt: "asc" },
        },
        races: {
          select: {
            id: true,
            tournamentRound: true,
            tournamentMatchIndex: true,
            status: true,
            endsAt: true,
            powerupsEnabled: true,
            winnerUserId: true,
            participants: {
              select: {
                userId: true,
                status: true,
                totalSteps: true,
                finishedAt: true,
                forfeitedAt: true,
                joinedAt: true,
              },
              orderBy: { joinedAt: "asc" },
            },
            activeEffects: {
              where: { status: "ACTIVE" },
              select: {
                type: true,
                targetUserId: true,
                expiresAt: true,
                metadata: true,
              },
            },
          },
          orderBy: [
            { tournamentRound: "asc" },
            { tournamentMatchIndex: "asc" },
          ],
        },
      },
    });
  },

  async findByShareToken(shareToken) {
    if (!shareToken) return null;
    return prisma.tournament.findUnique({
      where: { shareToken },
      include: tournamentInclude,
    });
  },

  async findSummaryById(id) {
    return prisma.tournament.findUnique({
      where: { id },
      include: summaryInclude,
    });
  },

  async create(data) {
    return prisma.tournament.create({ data, include: tournamentInclude });
  },

  async update(id, data) {
    return prisma.tournament.update({
      where: { id },
      data,
      include: tournamentInclude,
    });
  },

  // Conditional PENDING -> ACTIVE claim (idempotency, mirrors Race.updateIfPending).
  async updateIfPending(id, data) {
    return prisma.tournament.updateMany({
      where: { id, status: "PENDING" },
      data,
    });
  },

  async updateIfActive(id, data) {
    return prisma.tournament.updateMany({
      where: { id, status: "ACTIVE" },
      data,
    });
  },

  // Every tournament the user is ACCEPTED in (status != CANCELLED), PLUS ones
  // they are INVITED to only while still PENDING (a stale invite to a started/
  // finished bracket must not linger). Summary include.
  async findForUser(userId) {
    return prisma.tournament.findMany({
      where: {
        status: { not: "CANCELLED" },
        participants: {
          some: {
            OR: [
              { userId, status: "ACCEPTED" },
              { userId, status: "INVITED", tournament: { status: "PENDING" } },
            ],
          },
        },
      },
      include: summaryInclude,
      orderBy: { createdAt: "desc" },
    });
  },

  // Public, user-created, PENDING tournaments with open slots the viewer isn't in.
  async findPublicPending() {
    return prisma.tournament.findMany({
      where: {
        isPublic: true,
        status: "PENDING",
        seedId: null,
        OR: [{ creatorId: null }, { creator: { isReviewAccount: false } }],
      },
      include: summaryInclude,
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  },

  // Home Suggested Races: featured and user-created candidates share one
  // bounded Postgres read. Membership, capacity, active-seed, same-seed alive,
  // review, and public predicates all precede the combined LIMIT 4. Featured
  // rows sort first; each group is newest-first with id as the stable tie break.
  async findPublicSuggestions({ userId, limit = 4 }) {
    return prisma.$queryRaw`
      WITH eligible AS (
        SELECT
          t.id,
          t.name,
          t.status::text AS status,
          t.bracket_size AS "bracketSize",
          t.matchup_duration_days AS "matchupDurationDays",
          t.buy_in_amount AS "buyInAmount",
          t.pot_coins AS "potCoins",
          t.funded_prize AS "fundedPrize",
          t.prize_pool_coins AS "prizePoolCoins",
          t.powerups_enabled AS "powerupsEnabled",
          t.powerup_step_interval AS "powerupStepInterval",
          t.is_public AS "isPublic",
          t.current_round AS "currentRound",
          t.total_rounds AS "totalRounds",
          t.creator_id AS "creatorId",
          t.seed_id AS "seedId",
          t.champion_prize_coins_snapshot AS "championPrizeCoinsSnapshot",
          t.created_at AS "createdAt",
          t.started_at AS "startedAt",
          t.completed_at AS "completedAt",
          seed.kind AS "seedKind",
          seed.champion_prize_coins AS "championPrizeCoins",
          COALESCE(parts.accepted_count, 0)::int AS "acceptedCount",
          COALESCE(parts.rows, '[]'::jsonb) AS participants,
          CASE WHEN t.seed_id IS NOT NULL THEN 0 ELSE 1 END AS category_rank,
          CASE
            WHEN t.seed_id IS NOT NULL THEN
              ROW_NUMBER() OVER (
                PARTITION BY t.seed_id
                ORDER BY t.created_at DESC, t.id ASC
              )
            ELSE 1
          END AS seed_rank
        FROM tournaments t
        LEFT JOIN tournament_seeds seed ON seed.id = t.seed_id
        LEFT JOIN users creator ON creator.id = t.creator_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE tp.status = 'accepted'::"RaceParticipantStatus") AS accepted_count,
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'userId', tp.user_id,
                'status', UPPER(tp.status::text),
                'eliminatedInRound', tp.eliminated_in_round,
                'joinedAt', tp.joined_at
              )
              ORDER BY tp.joined_at ASC
            ) AS rows
          FROM tournament_participants tp
          WHERE tp.tournament_id = t.id
        ) parts ON TRUE
        WHERE t.status = 'pending'::"TournamentStatus"
          AND (
            (t.seed_id IS NOT NULL AND seed.active = TRUE)
            OR (
              t.seed_id IS NULL
              AND t.is_public = TRUE
              AND (t.creator_id IS NULL OR creator.is_review_account = FALSE)
            )
          )
          AND COALESCE(parts.accepted_count, 0) < t.bracket_size
          AND NOT EXISTS (
            SELECT 1
            FROM tournament_participants mine
            WHERE mine.tournament_id = t.id
              AND mine.user_id = ${userId}
              AND mine.status <> 'declined'::"RaceParticipantStatus"
          )
          AND (
            t.seed_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM tournament_participants alive
              JOIN tournaments alive_t ON alive_t.id = alive.tournament_id
              WHERE alive.user_id = ${userId}
                AND alive.status = 'accepted'::"RaceParticipantStatus"
                AND alive.eliminated_in_round IS NULL
                AND alive_t.seed_id = t.seed_id
                AND alive_t.status IN (
                  'pending'::"TournamentStatus",
                  'active'::"TournamentStatus"
                )
            )
          )
      ), ranked AS (
        SELECT *
        FROM eligible
        WHERE seed_rank = 1
      )
      SELECT *
      FROM ranked
      ORDER BY category_rank ASC, "createdAt" DESC, id ASC
      LIMIT ${limit}
    `;
  },
};

module.exports = { Tournament, tournamentInclude, summaryInclude };
