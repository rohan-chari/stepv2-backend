const { prisma } = require("../db");

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
        ...participantInclude,
      },
    });
  },

  // Resolve a race by its opaque share token (see utils/shareToken). Mirrors
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
    isPublic = false,
    maxParticipants = 10,
    scheduledStartAt = null,
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
        isPublic,
        maxParticipants,
        scheduledStartAt,
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

  async findForUser(userId) {
    return prisma.race.findMany({
      where: {
        participants: { some: { userId } },
      },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        winner: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
      },
      orderBy: { updatedAt: "desc" },
    });
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
      },
      include: {
        creator: { select: { id: true, displayName: true, profilePhotoUrl: true } },
        ...participantInclude,
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
  // live updates. Lean select: the job only needs id (to call resolveRaceState)
  // and name (for the placement-change push body).
  async findActiveInProgress(now) {
    return prisma.race.findMany({
      where: {
        status: "ACTIVE",
        OR: [{ endsAt: { gt: now } }, { endsAt: null }],
      },
      select: { id: true, name: true },
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
