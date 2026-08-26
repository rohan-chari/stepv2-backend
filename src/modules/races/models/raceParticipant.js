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
  async findUserIdsByRace(raceId) {
    if (!raceId) return [];
    const rows = await prisma.raceParticipant.findMany({
      where: { raceId },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.map((row) => row.userId).filter(Boolean);
  },

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

  // Persisted, bounded fallback for a page projection miss/outage. The
  // ranking order mirrors compareParticipantsForPlacement and computes the
  // total/placement in SQL without materializing the race roster in Node.
  async findPersistedProgressPage(raceId, { offset = 0, limit = 15 } = {}) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 1)));
    return prisma.$queryRawUnsafe(
      `
      WITH ranked AS (
        SELECT
          rp.id AS "participantId",
          rp.user_id AS "userId",
          rp.total_steps AS "totalSteps",
          rp.raw_steps AS "rawSteps",
          rp.finished_at AS "finishedAt",
          rp.finish_total_steps AS "finishTotalSteps",
          rp.forfeited_at AS "forfeitedAt",
          rp.team,
          rp.placement,
          rp.joined_at AS "joinedAt",
          ROW_NUMBER() OVER (
            ORDER BY
              CASE WHEN rp.finished_at IS NOT NULL THEN 0 ELSE 1 END,
              CASE WHEN rp.finished_at IS NOT NULL THEN rp.placement END ASC NULLS LAST,
              CASE WHEN rp.finished_at IS NOT NULL THEN rp.finished_at END ASC NULLS LAST,
              CASE WHEN rp.finished_at IS NULL THEN rp.total_steps END DESC NULLS LAST,
              rp.joined_at ASC,
              rp.user_id ASC
          )::int AS "computedPlacement",
          COUNT(*) OVER ()::int AS "totalCount"
        FROM race_participants rp
        WHERE rp.race_id = $1
          AND rp.status = 'accepted'::"RaceParticipantStatus"
      )
      SELECT * FROM ranked
      ORDER BY "computedPlacement"
      OFFSET $2 LIMIT $3
      `,
      raceId,
      safeOffset,
      safeLimit,
    );
  },

  // Ownership checks must not hydrate the complete race roster or any user
  // presentation fields. This is used by the race-resolution status poll,
  // which can be called repeatedly while a worker is draining a job.
  async existsAcceptedByRaceAndUser(raceId, userId) {
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId, status: "ACCEPTED" },
      select: { id: true },
    });
    return participant != null;
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
        totalSteps: Math.max(0, Math.round(Number(totalSteps) || 0)),
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
    const safeFinishTotalSteps = Math.max(
      0,
      Math.round(Number(finishTotalSteps) || 0),
    );
    return prisma.raceParticipant.update({
      where: { id },
      data: {
        finishedAt,
        finishTotalSteps: safeFinishTotalSteps,
        totalSteps: safeFinishTotalSteps,
        status: "ACCEPTED",
      },
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
      // Keep the cheap persisted display total aligned with the participant's
      // bonus delta immediately. The worker still recomputes the authoritative
      // full score (including timed effects) on its next resolution.
      data: {
        bonusSteps: { increment: amount },
        totalSteps: { increment: amount },
      },
    });
  },

  // The sole immediate negative-bonus write seam. The one SQL statement both
  // locks and mutates the participant row, so two attacks that pre-read the
  // same score cannot overdraw it. It also repairs legacy negative aggregates
  // without preserving the historical overkill in bonus_steps.
  async applyPenaltyAtomic(id, nominalPenalty) {
    const safeNominal = Math.max(
      0,
      Math.round(Number(nominalPenalty) || 0),
    );
    const rows = await prisma.$queryRaw`
      WITH locked AS (
        SELECT id, total_steps, bonus_steps
        FROM race_participants
        WHERE id = ${id}
        FOR UPDATE
      ), penalty AS (
        SELECT
          id,
          LEAST(${safeNominal}, GREATEST(0, total_steps))::int AS actual_penalty,
          GREATEST(0, -total_steps)::int AS legacy_overkill,
          total_steps,
          bonus_steps
        FROM locked
      )
      UPDATE race_participants AS participant
      SET
        total_steps = GREATEST(0, penalty.total_steps) - penalty.actual_penalty,
        bonus_steps = penalty.bonus_steps + penalty.legacy_overkill - penalty.actual_penalty,
        totals_updated_at = CURRENT_TIMESTAMP
      FROM penalty
      WHERE participant.id = penalty.id
      RETURNING
        participant.id,
        participant.total_steps AS "totalSteps",
        participant.bonus_steps AS "bonusSteps",
        penalty.actual_penalty AS "actualPenalty"
    `;
    const updated = rows[0];
    if (!updated) {
      const error = new Error("Race participant not found");
      error.code = "P2025";
      throw error;
    }
    return updated;
  },

  async subtractBonusSteps(id, amount) {
    return RaceParticipant.applyPenaltyAtomic(id, amount);
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
