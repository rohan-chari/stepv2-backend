const { prisma } = require("../../../db");

const RacePowerup = {
  async create({
    raceId,
    participantId,
    userId,
    type = null,
    rarity = null,
    status = "HELD",
    earnedAtSteps,
    redeemedFromInventory = false,
  }) {
    return prisma.racePowerup.create({
      data: {
        raceId,
        participantId,
        userId,
        type,
        rarity,
        status,
        earnedAtSteps,
        redeemedFromInventory,
      },
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

  // Conditional claim of the discard transition (batch 2026-08-08 item 1).
  //
  // The discard command used to do a plain read-then-update, which is a TOCTOU:
  // two concurrent taps both read a HELD row, both pass the status check, and
  // both write a feed row (and, now that discarding pays, both would mint).
  // Only the caller whose updateMany matches a still-discardable row
  // (count === 1) may proceed. Mirrors `updateIfPending` on the Race model and
  // the conditional claim in stealRandomHeldPowerup below.
  async claimForDiscard(id) {
    return prisma.racePowerup.updateMany({
      where: { id, status: { in: ["HELD", "MYSTERY_BOX"] } },
      data: { status: "DISCARDED" },
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

  // Bulk variant of findSlotPowerups / countQueuedByParticipant across many
  // participants (Phase B2): one query returning every powerup for a set of
  // participant ids whose status is in `statuses`, ordered createdAt asc so a
  // per-participant grouping preserves the same order the single-participant
  // queries produce. Used by the GET /races inventory prefetch. Participant ids
  // are globally unique, so no race scoping is needed.
  async findInventoryForParticipants(participantIds, statuses) {
    if (!participantIds || participantIds.length === 0) return [];
    return prisma.racePowerup.findMany({
      where: { participantId: { in: participantIds }, status: { in: statuses } },
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
