const crypto = require("node:crypto");
const { prisma, runInPrismaTransaction, deferUntilAfterCommit } = require("../../../db");
const { createRace: defaultCreateRace } = require("../commands/createRace");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  computeRaceExposureStamp,
  lockFundedExposureUsers,
  reserveActiveCompetitionMembership,
  reserveFundedExposure,
  resolveRacePrizeStamp,
} = require("../services/fundedExposure");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const { invalidateUser: defaultInvalidateRaceListUser } = require("../services/raceListCache");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const authMeCache = require("../../users/services/authMeCache");
const {
  raceResolutionWorkBudget: defaultWorkBudget,
} = require("../services/raceResolutionWorkBudget");

const LEASE_MS = 2 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const BATCH_SIZE = 5;
const POLL_INTERVAL_MS = 5_000;

function buildRaceSeriesRenewalJob(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const createRace = dependencies.createRace || defaultCreateRace;
  const settings = dependencies.appSettings || defaultAppSettings;
  const invalidateRaceListUser =
    dependencies.invalidateRaceListUser || defaultInvalidateRaceListUser;
  const invalidateAuthUser =
    dependencies.invalidateAuthUser ||
    (Object.keys(dependencies).length > 0
      ? async () => null
      : authMeCache.invalidateSafe);
  const appendDomainEvent =
    dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const now = dependencies.now || (() => new Date());
  const workBudget = dependencies.raceResolutionWorkBudget || defaultWorkBudget;

  async function closeSeries(tx, series, reason) {
    const endedAt = now();
    const affected = (series.subscriptions || [])
      .filter((row) => row.active !== false)
      .map((row) => row.userId);
    await tx.raceSeries.update({
      where: { id: series.id },
      data: { enabled: false, endedAt, terminalReason: reason },
    });
    await tx.raceSeriesSubscription.updateMany({
      where: { seriesId: series.id, active: true },
      data: { active: false, unsubscribedAt: endedAt },
    });
    await deferUntilAfterCommit(async () => {
      await Promise.allSettled(
        affected.flatMap((id) => [
          invalidateRaceListUser(id),
          invalidateAuthUser(id),
        ]),
      );
    });
  }

  async function claimOne() {
    return runInPrismaTransaction(async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT id
          FROM race_series_renewal_jobs
         WHERE (
           state IN ('QUEUED'::"RaceSeriesRenewalJobState", 'FAILED_RETRYABLE'::"RaceSeriesRenewalJobState")
           AND (retry_at IS NULL OR retry_at <= NOW())
         ) OR (
           state = 'RUNNING'::"RaceSeriesRenewalJobState"
           AND lease_expires_at <= NOW()
         )
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      `;
      if (!rows[0]) return null;
      const token = crypto.randomUUID();
      return tx.raceSeriesRenewalJob.update({
        where: { id: rows[0].id },
        data: {
          state: "RUNNING",
          attempts: { increment: 1 },
          leaseGeneration: { increment: 1 },
          leaseToken: token,
          leaseExpiresAt: new Date(now().getTime() + LEASE_MS),
          retryAt: null,
          lastErrorCode: null,
        },
      });
    });
  }

  async function processClaim(job) {
    try {
      return await runInPrismaTransaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM race_series_renewal_jobs
           WHERE id = ${job.id}::uuid
           FOR UPDATE
        `;
        const currentJob = await tx.raceSeriesRenewalJob.findUnique({
          where: { id: job.id },
          include: {
            predecessor: {
              include: {
                series: {
                  include: {
                    subscriptions: {
                      where: { active: true },
                      orderBy: [{ subscribedAt: "asc" }, { userId: "asc" }],
                    },
                  },
                },
              },
            },
          },
        });
        if (
          !currentJob ||
          currentJob.state !== "RUNNING" ||
          currentJob.leaseToken !== job.leaseToken
        ) return null;
        if (currentJob.targetRaceId) {
          await tx.raceSeriesRenewalJob.update({
            where: { id: currentJob.id },
            data: {
              state: "SUCCEEDED",
              terminalAt: now(),
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return currentJob.targetRaceId;
        }
        let predecessor = currentJob.predecessor;
        let series = predecessor?.series;
        if (!series || predecessor.settlementCompletedAt == null) {
          throw Object.assign(new Error("Settlement is not durable."), {
            code: "SETTLEMENT_NOT_READY",
          });
        }
        // Serialize the series pointer and predecessor lifecycle behind the
        // claimed job before creating a target. An expired-lease contender can
        // observe the new token only after this lock releases and therefore
        // cannot build a second successor.
        await tx.$queryRaw`SELECT id FROM race_series WHERE id = ${series.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM races WHERE id = ${predecessor.id} FOR UPDATE`;
        series = await tx.raceSeries.findUnique({
          where: { id: series.id },
          include: {
            subscriptions: {
              where: { active: true },
              orderBy: [{ subscribedAt: "asc" }, { userId: "asc" }],
            },
          },
        });
        predecessor = await tx.race.findUnique({ where: { id: predecessor.id } });
        if (!series || predecessor?.settlementCompletedAt == null) {
          throw Object.assign(new Error("Settlement is not durable."), {
            code: "SETTLEMENT_NOT_READY",
          });
        }
        const creatorSubscribed = series.subscriptions.some(
          (row) => row.userId === series.creatorId,
        );
        if (!series.enabled || !creatorSubscribed) {
          if (series.enabled) await closeSeries(tx, series, "CREATOR_UNSUBSCRIBED");
          await tx.raceSeriesRenewalJob.update({
            where: { id: currentJob.id },
            data: {
              state: "FAILED_TERMINAL",
              terminalAt: now(),
              lastErrorCode: "SERIES_DISABLED",
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return null;
        }
        if ((await settings.getFlag("fundedPrizePoolsEnabled")) !== true) {
          await closeSeries(tx, series, "POLICY_NO_LONGER_ELIGIBLE");
          await tx.raceSeriesRenewalJob.update({
            where: { id: currentJob.id },
            data: {
              state: "FAILED_TERMINAL",
              terminalAt: now(),
              lastErrorCode: "POLICY_NO_LONGER_ELIGIBLE",
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return null;
        }

        const snapshot = series.settings || {};
        const creator = await tx.user.findUnique({
          where: { id: series.creatorId },
          select: { timezone: true },
        });
        if (!creator) {
          await closeSeries(tx, series, "CREATOR_INELIGIBLE");
          await tx.raceSeriesRenewalJob.update({
            where: { id: currentJob.id },
            data: {
              state: "FAILED_TERMINAL",
              terminalAt: now(),
              lastErrorCode: "CREATOR_INELIGIBLE",
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return null;
        }
        let created;
        try {
          created = await createRace({
            userId: series.creatorId,
            name: snapshot.name,
            targetSteps: snapshot.targetSteps,
            maxDurationDays: snapshot.maxDurationDays,
            powerupsEnabled: snapshot.powerupsEnabled,
            powerupStepInterval: snapshot.powerupStepInterval,
            buyInAmount: 0,
            payoutPreset: snapshot.payoutPreset,
            isPublic: snapshot.isPublic,
            maxParticipants: snapshot.maxParticipants,
            timeZone: creator.timezone || snapshot.timezone,
          });
        } catch (error) {
          if (["ACTIVE_COMPETITION_LIMIT", "FUNDED_EXPOSURE_LIMIT"].includes(error?.code)) {
            await closeSeries(tx, series, "CREATOR_INELIGIBLE");
            await tx.raceSeriesRenewalJob.update({
              where: { id: currentJob.id },
              data: {
                state: "FAILED_TERMINAL",
                terminalAt: now(),
                lastErrorCode: "CREATOR_INELIGIBLE",
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            return null;
          }
          throw error;
        }
        const generation = series.generation + 1;
        await acquireRaceWriteFence(tx, created.id);
        await tx.race.update({
          where: { id: created.id },
          data: {
            seriesId: series.id,
            seriesGeneration: generation,
            seriesPredecessorRaceId: predecessor.id,
            recurringPayoutMinRawSteps: predecessor.recurringPayoutMinRawSteps || 2000,
            recurringPayoutPolicyVersion: predecessor.recurringPayoutPolicyVersion || 1,
          },
        });

        const remainingCapacity = Math.max(
          0,
          Number(snapshot.maxParticipants || 100) - 1,
        );
        // Preserve subscription order while scanning. Capacity counts actual
        // successful enrollments, not merely the first N candidates: an
        // unavailable or currently over-limit subscriber must not strand a
        // place that a later active subscriber can fill.
        const candidates = series.subscriptions
          .filter((row) => row.userId !== series.creatorId);
        const accounts = await tx.user.findMany({
          where: { id: { in: candidates.map((row) => row.userId) } },
          select: { id: true },
        });
        const available = new Set(accounts.map((row) => row.id));
        const candidateIds = candidates
          .map((row) => row.userId)
          .filter((id) => available.has(id));
        await lockFundedExposureUsers(tx, candidateIds);
        const targetRace = await tx.race.findUnique({ where: { id: created.id } });
        const stamp = computeRaceExposureStamp({
          maxDurationDays: targetRace.maxDurationDays,
          prizeCoinUnit: resolveRacePrizeStamp(targetRace).prizeCoinUnit,
          teamPoolMultBps: targetRace.teamPoolMultBps,
        });
        const enrolled = [];
        for (const userId of candidateIds) {
          if (enrolled.length >= remainingCapacity) break;
          try {
            await reserveActiveCompetitionMembership({ tx, userId });
            await reserveFundedExposure({
              tx,
              userId,
              stamp,
              competition: { raceId: created.id },
              enforceLimits: false,
            });
            const participant = await tx.raceParticipant.create({
              data: {
                raceId: created.id,
                userId,
                status: "ACCEPTED",
                buyInAmount: 0,
                buyInStatus: "NONE",
                fundedExposureMillicoins: stamp.exposureMillicoins,
                fundedExposureRateMillicoinsPerDay: stamp.exposureRateMillicoinsPerDay,
                nextBoxAtSteps:
                  targetRace.powerupsEnabled && targetRace.powerupStepInterval
                    ? targetRace.powerupStepInterval
                    : 0,
              },
            });
            await appendDomainEvent(tx, {
              eventKey: `RACE_INVITE_ACCEPTED_V1:${participant.id}`,
              eventType: "RACE_INVITE_ACCEPTED_V1",
              schemaVersion: 1,
              aggregateType: "RACE",
              aggregateId: created.id,
              occurredAt: participant.updatedAt || now(),
              payload: {
                raceId: created.id,
                raceName: targetRace.name,
                participantId: participant.id,
                userId,
                creatorUserId: series.creatorId,
                recurringSeriesId: series.id,
                seriesGeneration: generation,
              },
              audience: [{ recipientId: series.creatorId, facts: {} }],
            });
            enrolled.push(userId);
          } catch (error) {
            if (!["ACTIVE_COMPETITION_LIMIT", "FUNDED_EXPOSURE_LIMIT"].includes(error?.code)) {
              throw error;
            }
          }
        }
        await tx.raceSeries.update({
          where: { id: series.id },
          data: { currentRaceId: created.id, generation },
        });
        await tx.raceSeriesRenewalJob.update({
          where: { id: currentJob.id },
          data: {
            state: "SUCCEEDED",
            targetRaceId: created.id,
            terminalAt: now(),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        await deferUntilAfterCommit(async () => {
          await Promise.allSettled(
            [series.creatorId, ...enrolled].flatMap((id) => [
              invalidateRaceListUser(id),
              invalidateAuthUser(id),
            ]),
          );
        });
        return created.id;
      }, { maxWait: 10_000, timeout: 30_000 });
    } catch (error) {
      await db.raceSeriesRenewalJob.updateMany({
        where: { id: job.id, state: "RUNNING", leaseToken: job.leaseToken },
        data: {
          state: "FAILED_RETRYABLE",
          retryAt: new Date(now().getTime() + RETRY_MS),
          lastErrorCode: String(error?.code || "RENEWAL_FAILED").slice(0, 128),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return null;
    }
  }

  return async function processRaceSeriesRenewals() {
    let processed = 0;
    while (processed < BATCH_SIZE) {
      const claimed = await workBudget.run("post", async () => {
        // Acquire the shared process budget before leasing durable work. A
        // renewal waiting behind core resolution must not burn through its
        // lease before it has a slot in which to run.
        const job = await claimOne();
        if (!job) return false;
        await processClaim(job);
        return true;
      });
      if (!claimed) break;
      processed += 1;
    }
    return { processed };
  };
}

const processRaceSeriesRenewals = buildRaceSeriesRenewalJob();

function scheduleRaceSeriesRenewal(dependencies = {}) {
  const processRenewals =
    dependencies.processRaceSeriesRenewals || processRaceSeriesRenewals;
  const logger = dependencies.logger || console;
  const intervalMs = Math.max(
    1_000,
    Number(dependencies.pollIntervalMs) || POLL_INTERVAL_MS,
  );
  let stopped = false;
  let inFlight = null;
  async function tick() {
    if (stopped || inFlight) return inFlight;
    inFlight = processRenewals()
      .catch((error) => logger.error("[RACE_SERIES_RENEWAL] tick failed:", error))
      .finally(() => { inFlight = null; });
    return inFlight;
  }
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return {
    interval,
    async stop() {
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  buildRaceSeriesRenewalJob,
  processRaceSeriesRenewals,
  scheduleRaceSeriesRenewal,
};
