const { prisma } = require("../db");

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
};

module.exports = { Tournament, tournamentInclude, summaryInclude };
