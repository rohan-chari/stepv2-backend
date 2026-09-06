const { prisma, runInPrismaTransaction, deferUntilAfterCommit } = require("../../../db");
const { invalidateUser: defaultInvalidateRaceListUser } = require("../services/raceListCache");
const authMeCache = require("../../users/services/authMeCache");
const {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} = require("../../../shared/errors/AppError");

function buildUpdateRaceSeries(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const invalidateRaceListUser =
    dependencies.invalidateRaceListUser || defaultInvalidateRaceListUser;
  const invalidateAuthUser =
    dependencies.invalidateAuthUser ||
    (Object.keys(dependencies).length > 0
      ? async () => null
      : authMeCache.invalidateSafe);

  async function updateSubscription({ userId, seriesId, active }) {
    if (active !== false) {
      if (active === true) {
        throw new ConflictError(
          "A new invite is required to rejoin this series.",
          "REINVITE_REQUIRED",
        );
      }
      throw new ValidationError("Invalid request.", "INVALID_REQUEST");
    }
    return runInPrismaTransaction(async (tx) => {
      // Renewal takes the durable job row, then the series row, then its
      // predecessor race. Taking the same series -> current-race order makes
      // opt-out linearizable with a worker that is advancing currentRaceId.
      const lockedSeriesRows = await tx.$queryRaw`
        SELECT id FROM race_series WHERE id = ${seriesId}::uuid FOR UPDATE
      `;
      if (!lockedSeriesRows.length) {
        throw new NotFoundError("Race series not found.", "RACE_SERIES_NOT_FOUND");
      }
      const series = await tx.raceSeries.findUnique({
        where: { id: seriesId },
        select: { id: true, currentRaceId: true },
      });
      await tx.$queryRaw`SELECT id FROM races WHERE id = ${series.currentRaceId} FOR UPDATE`;
      await tx.$queryRaw`
        SELECT id FROM race_series_subscriptions
         WHERE series_id = ${seriesId}::uuid AND user_id = ${userId}
         FOR UPDATE
      `;
      const [subscription, acceptedSeriesParticipant] = await Promise.all([
        tx.raceSeriesSubscription.findUnique({
          where: { seriesId_userId: { seriesId, userId } },
        }),
        tx.raceParticipant.findFirst({
          where: {
            userId,
            status: "ACCEPTED",
            race: { seriesId },
          },
          select: { id: true },
        }),
      ]);
      // A subscriber can be skipped from a later occurrence by current
      // admission limits while remaining subscribed. Their accepted
      // membership in any occurrence of this locked series is the durable
      // provenance needed to opt out; requiring a row in currentRaceId would
      // trap precisely those skipped subscribers.
      if (!subscription || !acceptedSeriesParticipant) {
        throw new ForbiddenError(
          "You do not have access to this series.",
          "SERIES_ACCESS_DENIED",
        );
      }
      if (subscription.active) {
        await tx.raceSeriesSubscription.update({
          where: { id: subscription.id },
          data: { active: false, unsubscribedAt: new Date() },
        });
      }
      await deferUntilAfterCommit(async () => {
        await Promise.allSettled([
          invalidateRaceListUser(userId),
          invalidateAuthUser(userId),
        ]);
      });
      return {
        seriesId,
        active: false,
        effectiveAfterRaceId: series.currentRaceId,
      };
    });
  }

  async function updateSeries({ userId, seriesId, enabled }) {
    if (enabled !== false) {
      throw new ValidationError("Invalid request.", "INVALID_REQUEST");
    }
    return runInPrismaTransaction(async (tx) => {
      const lockedSeriesRows = await tx.$queryRaw`
        SELECT id FROM race_series WHERE id = ${seriesId}::uuid FOR UPDATE
      `;
      if (!lockedSeriesRows.length) {
        throw new NotFoundError("Race series not found.", "RACE_SERIES_NOT_FOUND");
      }
      const series = await tx.raceSeries.findUnique({
        where: { id: seriesId },
        include: {
          subscriptions: { where: { active: true }, select: { userId: true } },
        },
      });
      await tx.$queryRaw`SELECT id FROM races WHERE id = ${series.currentRaceId} FOR UPDATE`;
      if (series.creatorId !== userId) {
        throw new ForbiddenError(
          "Only the series creator can stop recurrence.",
          "SERIES_ACCESS_DENIED",
        );
      }
      const affected = series.subscriptions.map((row) => row.userId);
      if (series.enabled) {
        const endedAt = new Date();
        await tx.raceSeries.update({
          where: { id: seriesId },
          data: { enabled: false, endedAt, terminalReason: "CREATOR_STOPPED" },
        });
        await tx.raceSeriesSubscription.updateMany({
          where: { seriesId, active: true },
          data: { active: false, unsubscribedAt: endedAt },
        });
      }
      await deferUntilAfterCommit(async () => {
        await Promise.allSettled(
          affected.flatMap((id) => [
            invalidateRaceListUser(id),
            invalidateAuthUser(id),
          ]),
        );
      });
      return {
        seriesId,
        enabled: false,
        effectiveAfterRaceId: series.currentRaceId,
      };
    });
  }

  return { updateSubscription, updateSeries };
}

const updateRaceSeries = buildUpdateRaceSeries();

module.exports = { buildUpdateRaceSeries, updateRaceSeries };
