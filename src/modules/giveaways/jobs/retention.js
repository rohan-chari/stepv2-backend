const { prisma: defaultPrisma } = require("../../../db");
const { Prisma } = require("@prisma/client");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const { destructiveCleanupDisabled } = require("../../../shared/config/operationalControls");

const JOB_NAME = "giveaway_retention";
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const THREE_YEARS_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function buildGiveawayRetention(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const jobRun = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const env = dependencies.env || process.env;
  const logger = dependencies.logger || console;
  return async function retainGiveaways() {
    if (destructiveCleanupDisabled("GIVEAWAY_RETENTION_DISABLED", env)) return null;
    const current = now();
    const lastRanFor = await jobRun.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({ now: current, targetHour: dependencies.targetHour ?? 3, lastRanFor });
    if (!runKey || !(await jobRun.claimRun(JOB_NAME, runKey))) return null;
    const acceptanceCutoff = new Date(current.getTime() - THREE_YEARS_MS);
    const financialCutoff = new Date(current.getTime() - SEVEN_YEARS_MS);
    const rateWindowCutoff = new Date(current.getTime() - TWO_DAYS_MS);
    const result = await db.$transaction(async (tx) => {
      const oldContestIds = (await tx.giveawayContest.findMany({
        where: {
          OR: [
            { finalizedAt: { lt: acceptanceCutoff } },
            { cancelledAt: { lt: acceptanceCutoff } },
          ],
        },
        select: { id: true },
      })).map((row) => row.id);
      // Strip request/response bodies first: those can contain private review
      // notes or entrant identifiers. Keep bounded action/revision metadata as
      // the lifecycle audit while financial rows remain under their 7y rule.
      const redactedAudits = oldContestIds.length
        ? await tx.giveawayAuditEvent.updateMany({
            where: { contestId: { in: oldContestIds }, createdAt: { lt: acceptanceCutoff } },
            data: { requestBody: Prisma.DbNull, responseBody: Prisma.DbNull },
          })
        : { count: 0 };
      const redactedReviewNotes = oldContestIds.length
        ? await tx.giveawayPointReview.updateMany({
            where: { contestId: { in: oldContestIds }, decidedAt: { lt: acceptanceCutoff }, privateNote: { not: null } },
            data: { privateNote: null },
          })
        : { count: 0 };
      const nonWinners = oldContestIds.length
        ? await tx.giveawayEntrant.deleteMany({
            where: {
              contestId: { in: oldContestIds },
              fulfillment: null,
              OR: [{ result: null }, { result: { status: { not: "VERIFIED" } } }],
            },
          })
        : { count: 0 };
      const expiredFinancialWinnerIds = (await tx.giveawayFulfillment.findMany({
        where: { fulfilledAt: { lt: financialCutoff } },
        select: { entrantId: true },
      })).map((row) => row.entrantId);
      const financial = await tx.giveawayFulfillment.deleteMany({
        where: { fulfilledAt: { lt: financialCutoff } },
      });
      const oldVerifiedWinnerIds = (await tx.giveawayEntrant.findMany({ where: {
        result: { status: "VERIFIED" }, contest: { finalizedAt: { lt: financialCutoff } },
      }, select: { id: true } })).map((row) => row.id);
      for (const entrantId of [...new Set([...expiredFinancialWinnerIds, ...oldVerifiedWinnerIds])]) {
        await tx.giveawayEntrant.update({ where: { id: entrantId }, data: {
          userId: null,
          entrantIdentityHash: `purged:${entrantId}`,
          identityHashVersion: 0,
          status: "ANONYMIZED",
          country: "PURGED",
          region: "PURGED",
          displayNameSnapshot: null,
          disqualifiedReason: null,
        } });
      }
      const rateWindows = await tx.giveawayRateWindow.deleteMany({
        where: { updatedAt: { lt: rateWindowCutoff } },
      });
      return {
        nonWinners: nonWinners.count,
        redactedAudits: redactedAudits.count,
        redactedReviewNotes: redactedReviewNotes.count,
        financial: financial.count,
        rateWindows: rateWindows.count,
      };
    });
    logger.log(`[CRON] Giveaway retention: removed ${result.nonWinners} non-winner acceptances and ${result.financial} expired financial rows`);
    return result;
  };
}

function scheduleGiveawayRetention(dependencies = {}) {
  const run = buildGiveawayRetention(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] giveawayRetention tick error:", error));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Giveaway retention scheduled (3am ET, 3y/7y retention)");
  return interval;
}

module.exports = { JOB_NAME, buildGiveawayRetention, scheduleGiveawayRetention };
