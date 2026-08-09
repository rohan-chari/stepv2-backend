const { prisma } = require("../../../db");

// Batch 2026-08-08 item 4 (podium): the top finishers of MANY completed races
// in ONE query, with the cosmetics relations the avatar needs.
//
// `placement: { in: [1,2,3] }` is what keeps this bounded — a 100-player race
// contributes at most 3 rows, so the result set is O(races), never
// O(participants). Without that predicate this would pull every participant of
// every completed race the viewer has ever run.
const PODIUM_PLACEMENTS = [1, 2, 3];

const RaceParticipant = {
  // Top-3 finishers for each of `raceIds`, for the completed-races list.
  // Returns a flat array; the caller groups by raceId. Ordered so that grouping
  // preserves 1 -> 2 -> 3 without a second sort.
  async findPodiumForRaces(raceIds) {
    if (!Array.isArray(raceIds) || raceIds.length === 0) return [];
    return prisma.raceParticipant.findMany({
      where: {
        raceId: { in: raceIds },
        status: "ACCEPTED",
        placement: { in: PODIUM_PLACEMENTS },
      },
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
      orderBy: [{ raceId: "asc" }, { placement: "asc" }],
    });
  },

  async findById(id) {
    return prisma.raceParticipant.findUnique({ where: { id } });
  },

  async findByRaceAndUser(raceId, userId) {
    return prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId } },
    });
  },

  // `team` (RaceTeam TEAM_A|TEAM_B) is only set on team races; null otherwise.
  async create({ raceId, userId, status, buyInAmount = 0, buyInStatus = "NONE", team = null }) {
    return prisma.raceParticipant.create({
      data: { raceId, userId, status, buyInAmount, buyInStatus, team },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
    });
  },

  async createMany(records) {
    return prisma.raceParticipant.createMany({
      data: records,
      skipDuplicates: true,
    });
  },

  async update(id, fields) {
    return prisma.raceParticipant.update({
      where: { id },
      data: fields,
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
    });
  },

  async findByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async findAcceptedByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: { raceId, status: "ACCEPTED" },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async findChargedByRace(raceId) {
    return prisma.raceParticipant.findMany({
      where: {
        raceId,
        buyInAmount: { gt: 0 },
        buyInStatus: { in: ["HELD", "COMMITTED"] },
      },
      include: {
        user: { select: { id: true, displayName: true, profilePhotoUrl: true } },
      },
      orderBy: { joinedAt: "asc" },
    });
  },

  async countAccepted(raceId) {
    return prisma.raceParticipant.count({
      where: { raceId, status: "ACCEPTED" },
    });
  },

  async updateTotalSteps(id, totalSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      // Item 16 (2026-07-26): stamp WHEN the persisted total was written, in the
      // same UPDATE (no extra round-trip), so GET /races can serve `teams.asOf`
      // without recomputing live totals on the most-frequently-polled screen.
      data: { totalSteps, totalsUpdatedAt: new Date() },
    });
  },

  async markFinished(id, finishedAt, finishTotalSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { finishedAt, finishTotalSteps, totalSteps: finishTotalSteps, status: "ACCEPTED" },
    });
  },

  async setPlacement(id, placement) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { placement },
    });
  },

  async addBonusSteps(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { bonusSteps: { increment: amount } },
    });
  },

  async subtractBonusSteps(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { bonusSteps: { decrement: amount } },
    });
  },

  async updatePowerupSlots(id, powerupSlots) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { powerupSlots },
    });
  },

  async updateNextBoxAtSteps(id, nextBoxAtSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { nextBoxAtSteps },
    });
  },

  async updateMaxBonusSteps(id, maxBonusSteps) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { maxBonusSteps },
    });
  },

  async delete(id) {
    return prisma.raceParticipant.delete({ where: { id } });
  },

  async incrementPayoutCoins(id, amount) {
    return prisma.raceParticipant.update({
      where: { id },
      data: { payoutCoins: { increment: amount } },
    });
  },
};

module.exports = { RaceParticipant };
