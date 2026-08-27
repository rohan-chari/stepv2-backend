const { randomUUID } = require("node:crypto");

const { prisma: defaultPrisma } = require("../../../db");
const { AppError } = require("../../../shared/errors/AppError");
const {
  DAILY_SUBMISSION_LIMIT,
  lockFeedbackQuota,
  startOfUtcDay,
} = require("../commands/createSuggestion");

const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTA_STATES = ["RESERVED", "ACCEPTED"];

function nextUtcDay(utcDay) {
  return new Date(utcDay.getTime() + 24 * 60 * 60 * 1000);
}

function buildFeedbackEmailAttemptModel(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;

  return {
    async reserve({ userId, messageId, now }) {
      const utcDay = startOfUtcDay(now);
      const expiresAt = new Date(now.getTime() + ATTEMPT_RETENTION_MS);
      return db.$transaction(async (tx) => {
        await lockFeedbackQuota(tx, userId, utcDay);
        const [legacyCount, emailCount] = await Promise.all([
          tx.suggestion.count({
            where: {
              userId,
              createdAt: { gte: utcDay, lt: nextUtcDay(utcDay) },
            },
          }),
          tx.feedbackEmailAttempt.count({
            where: { userId, utcDay, state: { in: QUOTA_STATES } },
          }),
        ]);
        if (legacyCount + emailCount >= DAILY_SUBMISSION_LIMIT) {
          throw new AppError(
            "Daily feedback limit reached",
            "DAILY_LIMIT_REACHED",
            429
          );
        }
        return tx.feedbackEmailAttempt.create({
          data: {
            id: randomUUID(),
            userId,
            utcDay,
            state: "RESERVED",
            messageId,
            expiresAt,
          },
        });
      });
    },

    async markAccepted(id) {
      return db.feedbackEmailAttempt.updateMany({
        where: { id, state: "RESERVED" },
        data: { state: "ACCEPTED", lastErrorCode: null },
      });
    },

    async markFailed(id, lastErrorCode) {
      return db.feedbackEmailAttempt.updateMany({
        where: { id, state: "RESERVED" },
        data: { state: "FAILED", lastErrorCode },
      });
    },

    async markUncertain(id) {
      return db.feedbackEmailAttempt.updateMany({
        where: { id, state: "RESERVED" },
        data: { lastErrorCode: "EMAIL_DELIVERY_UNCERTAIN" },
      });
    },

    async deleteExpiredBatch({ before, batchSize }) {
      const rows = await db.feedbackEmailAttempt.findMany({
        where: { expiresAt: { lte: before } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: batchSize,
        select: { id: true },
      });
      if (rows.length === 0) return 0;
      const deleted = await db.feedbackEmailAttempt.deleteMany({
        where: { id: { in: rows.map((row) => row.id) }, expiresAt: { lte: before } },
      });
      return deleted.count;
    },
  };
}

const FeedbackEmailAttempt = buildFeedbackEmailAttemptModel();

module.exports = {
  ATTEMPT_RETENTION_MS,
  FeedbackEmailAttempt,
  buildFeedbackEmailAttemptModel,
};
