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
  // One presentation row per computed list leader, fetched after the lean race
  // summaries establish rank. Bounded by race count rather than participant
  // count, so the hot GET /races query does not materialize every racer's gear.
  async findPresentationsByUserIds(userIds) {
    if (!Array.isArray(userIds) || userIds.length === 0) return [];
    return prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: {
        id: true,
        displayName: true,
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
    });
  },

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
                    remoteOnly: true,
                    assetVersion: true,
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
  async create({
    raceId,
    userId,
    status,
    buyInAmount = 0,
    buyInStatus = "NONE",
    team = null,
    fundedExposureMillicoins = null,
    fundedExposureRateMillicoinsPerDay = null,
  }) {
    return prisma.raceParticipant.create({
      data: {
        raceId,
        userId,
        status,
        buyInAmount,
        buyInStatus,
        team,
        fundedExposureMillicoins,
        fundedExposureRateMillicoinsPerDay,
      },
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

  async compareAndSetPlacementBaseline(id, expected, next) {
    const result = await prisma.raceParticipant.updateMany({
      where: {
        id,
        ...(expected == null
          ? { lastNotifiedPlacement: null }
          : { lastNotifiedPlacement: expected }),
      },
      data: { lastNotifiedPlacement: next },
    });
    return result.count === 1;
  },

  async findHighMultiplierContext(raceId, userId) {
    return prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId } },
      select: {
        id: true,
        raceId: true,
        userId: true,
        status: true,
        finishedAt: true,
        forfeitedAt: true,
        highMultiplierNotifiedAt: true,
        user: { select: { displayName: true } },
      },
    });
  },

  // Compare-and-swap the only mutable live-invite state. The expiry predicate
  // runs in the UPDATE itself: a response racing the expiry boundary cannot
  // turn an expired INVITED row into ACCEPTED/DECLINED.
  async updateLiveInvite(id, fields, now = new Date()) {
    const updated = await prisma.raceParticipant.updateMany({
      where: {
        id,
        status: "INVITED",
        OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gt: now } }],
      },
      data: fields,
    });
    if (updated.count !== 1) return null;
    return prisma.raceParticipant.findUnique({
      where: { id },
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

  // Placement-recompute's five-minute notification scan needs the same lean
  // persisted standings for every active race. Fetch them in one round-trip
  // instead of issuing one query per race. No presentation relations are
  // selected because the cron only reads ranking/team/notification fields.
  async findAcceptedByRaces(raceIds) {
    const ids = [...new Set(raceIds || [])].filter(Boolean);
    if (ids.length === 0) return [];
    return prisma.raceParticipant.findMany({
      where: { raceId: { in: ids }, status: "ACCEPTED" },
      select: {
        id: true,
        raceId: true,
        userId: true,
        totalSteps: true,
        placement: true,
        joinedAt: true,
        finishedAt: true,
        forfeitedAt: true,
        team: true,
        lastNotifiedPlacement: true,
        placementAlertsMuted: true,
      },
      orderBy: [{ raceId: "asc" }, { joinedAt: "asc" }],
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

  // THE participant-total write seam. Every writer of `totalSteps` goes
  // through here (legacy replay persist, the v2 worker's fenced replay, the
  // step-upload reconcile) and carries `rawSteps` — the RAW WALKED total that
  // the mystery-box odds position is derived from
  // (docs/box-raw-steps-position-and-option-h-requirements.md).
  //
  // `rawSteps` is OPTIONAL: omit it and the column is left exactly as it was,
  // so a caller that has no raw figure in scope can never blank a healed row.
  // Callers pass an ALREADY-MONOTONIC value (`nextRawSteps(existing, computed)`)
  // — a downward re-sync of step_samples must never move a player's odds
  // position backwards.
  async updateStepTotals(id, { totalSteps, rawSteps } = {}) {
    return prisma.raceParticipant.update({
      where: { id },
      // Item 16 (2026-07-26): stamp WHEN the persisted total was written, in the
      // same UPDATE (no extra round-trip), so GET /races can serve `teams.asOf`
      // without recomputing live totals on the most-frequently-polled screen.
      data: {
        totalSteps,
        totalsUpdatedAt: new Date(),
        ...(typeof rawSteps === "number" && Number.isFinite(rawSteps)
          ? { rawSteps: Math.max(0, Math.round(rawSteps)) }
          : {}),
      },
    });
  },

  // Uploader-only generation fence. The version-row lock, current-generation
  // comparison, membership/status recheck, and participant write are one
  // transaction. Callers must recompute and retry on VERSION_MISMATCH; this
  // method never writes a value calculated from a superseded upload.
  async updateUploaderTotalsIfScoringVersion({
    id,
    raceId,
    userId,
    expectedGeneration,
    totalSteps,
    rawSteps,
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "user_scoring_input_versions"
          ("user_id", "generation", "updated_at")
        VALUES (${userId}, 1, CURRENT_TIMESTAMP)
        ON CONFLICT ("user_id") DO NOTHING
      `;
      const versions = await tx.$queryRaw`
        SELECT "generation"
        FROM "user_scoring_input_versions"
        WHERE "user_id" = ${userId}
        FOR UPDATE
      `;
      const currentGeneration = versions[0]?.generation ?? null;
      if (
        currentGeneration == null ||
        expectedGeneration == null ||
        BigInt(currentGeneration) !== BigInt(expectedGeneration)
      ) {
        return {
          status: "VERSION_MISMATCH",
          generation: currentGeneration,
        };
      }

      const rows = await tx.$queryRaw`
        UPDATE race_participants AS participant
        SET
          total_steps = ${Math.max(0, Math.round(totalSteps))},
          raw_steps = GREATEST(
            COALESCE(participant.raw_steps, 0),
            ${Math.max(0, Math.round(rawSteps))}
          ),
          totals_updated_at = CURRENT_TIMESTAMP
        FROM races AS race
        WHERE participant.id = ${id}
          AND participant.race_id = ${raceId}
          AND participant.user_id = ${userId}
          AND participant.status = 'accepted'::"RaceParticipantStatus"
          AND participant.finished_at IS NULL
          AND participant.forfeited_at IS NULL
          AND race.id = participant.race_id
          AND race.status = 'active'::"RaceStatus"
        RETURNING
          participant.id,
          participant.total_steps AS "totalSteps",
          participant.raw_steps AS "rawSteps",
          participant.totals_updated_at AS "totalsUpdatedAt"
      `;
      return rows[0]
        ? { status: "COMMITTED", participant: rows[0] }
        : { status: "NOT_ELIGIBLE" };
    });
  },

  // Thin wrapper, kept because callers SPREAD this model (computeRaceState's
  // write capture) and because ~20 unit-test fakes implement it. Writes no
  // `rawSteps`, so it is only correct for a caller that genuinely has none.
  //
  // Calls through the MODULE binding, not `this`: callers routinely destructure
  // (`const { updateTotalSteps } = RaceParticipant`) or spread this object, and
  // either would leave `this` undefined or pointing at an override.
  async updateTotalSteps(id, totalSteps) {
    return RaceParticipant.updateStepTotals(id, { totalSteps });
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
