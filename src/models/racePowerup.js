const { prisma } = require("../db");

const RacePowerup = {
  async create({ raceId, participantId, userId, type = null, rarity = null, status = "HELD", earnedAtSteps }) {
    return prisma.racePowerup.create({
      data: { raceId, participantId, userId, type, rarity, status, earnedAtSteps },
    });
  },

  async findById(id) {
    return prisma.racePowerup.findUnique({ where: { id } });
  },

  async findHeldByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "HELD" },
      orderBy: { createdAt: "asc" },
    });
  },

  async countHeldByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "HELD" },
    });
  },

  async update(id, fields) {
    return prisma.racePowerup.update({
      where: { id },
      data: fields,
    });
  },

  async findMysteryBoxesByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "MYSTERY_BOX" },
      orderBy: { createdAt: "asc" },
    });
  },

  async countMysteryBoxesByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "MYSTERY_BOX" },
    });
  },

  async countOccupiedSlots(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: { in: ["HELD", "MYSTERY_BOX"] } },
    });
  },

  async findSlotPowerups(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: { in: ["HELD", "MYSTERY_BOX"] } },
      orderBy: { createdAt: "asc" },
    });
  },

  async countQueuedByParticipant(participantId) {
    return prisma.racePowerup.count({
      where: { participantId, status: "QUEUED" },
    });
  },

  async findQueuedByParticipant(participantId) {
    return prisma.racePowerup.findMany({
      where: { participantId, status: "QUEUED" },
      orderBy: { createdAt: "asc" },
    });
  },

  async findUsedTypesByParticipant(participantId) {
    const results = await prisma.racePowerup.findMany({
      where: { participantId, status: "USED", type: { not: null } },
      select: { type: true },
      distinct: ["type"],
    });
    return results.map((r) => r.type);
  },

  // Sneaky Swap steal: move ONE random stealable HELD powerup from
  // `fromParticipantId` to `toParticipantId`/`toUserId`. Returns the updated
  // row, or null when the victim holds nothing stealable (validated by the
  // caller, but re-checked here — the shelf can change between the read and
  // this call).
  //
  // Concurrency: the row is claimed with a conditional updateMany that
  // re-asserts (id, HELD, still owned by the victim) — a concurrent steal
  // that already moved the row makes the claim match 0 rows, and we fall back
  // to another candidate instead of double-stealing.
  //
  // earned_at_steps is cleared on the stolen row so it can't collide with the
  // recipient's milestone-bound powerup at the same step count (Postgres
  // treats NULL as distinct in the (participant_id, earned_at_steps) unique
  // index). rollPowerup still mints fresh milestone-bound rows with a concrete
  // earned_at_steps, which keeps that path's dedup intact.
  async stealRandomHeldPowerup({
    fromParticipantId,
    toParticipantId,
    toUserId,
    excludeTypes = [],
    random = Math.random,
  }) {
    return prisma.$transaction(async (tx) => {
      const candidates = await tx.racePowerup.findMany({
        where: {
          participantId: fromParticipantId,
          status: "HELD",
          ...(excludeTypes.length ? { type: { notIn: excludeTypes } } : {}),
        },
        orderBy: { createdAt: "asc" },
      });

      while (candidates.length > 0) {
        const index = Math.min(
          Math.floor(random() * candidates.length),
          candidates.length - 1
        );
        const [chosen] = candidates.splice(index, 1);

        const claimed = await tx.racePowerup.updateMany({
          where: {
            id: chosen.id,
            participantId: fromParticipantId,
            status: "HELD",
          },
          data: {
            participantId: toParticipantId,
            userId: toUserId,
            earnedAtSteps: null,
          },
        });
        if (claimed.count === 1) {
          return tx.racePowerup.findUnique({ where: { id: chosen.id } });
        }
      }

      return null;
    });
  },

  async expireAllForRace(raceId) {
    return prisma.racePowerup.updateMany({
      where: { raceId, status: { in: ["HELD", "MYSTERY_BOX", "QUEUED"] } },
      data: { status: "EXPIRED" },
    });
  },
};

module.exports = { RacePowerup };
