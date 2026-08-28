const { prisma: defaultPrisma } = require("../../../db");
const {
  RacePlacementTransitionJob: defaultJobModel,
  PAGE_SIZE,
} = require("../models/racePlacementTransitionJob");
const {
  RacePlacementBaseline: defaultBaselineModel,
} = require("../models/racePlacementBaseline");
const {
  planRacePlacementTransitions: defaultPlanner,
} = require("../services/racePlacementTransitions");
const {
  bulkAppendDomainEvents: defaultBulkAppendDomainEvents,
  normalizeDomainEvent,
} = require("../../domainEvents");

const POLL_INTERVAL_MS = 250;

async function claimTeamTransition(tx, claim) {
  if (!claim) return true;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO job_runs (job_name, last_ran_for, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (job_name) DO UPDATE
       SET last_ran_for=EXCLUDED.last_ran_for, updated_at=CURRENT_TIMESTAMP
     WHERE job_runs.last_ran_for <> EXCLUDED.last_ran_for
     RETURNING job_name`,
    claim.jobName,
    claim.value,
  );
  return rows.length === 1;
}

function buildRacePlacementTransitionWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobModel = dependencies.RacePlacementTransitionJob || defaultJobModel;
  const baselineModel = dependencies.RacePlacementBaseline || defaultBaselineModel;
  const planner = dependencies.planRacePlacementTransitions || defaultPlanner;
  const bulkAppendDomainEvents = dependencies.bulkAppendDomainEvents ||
    defaultBulkAppendDomainEvents;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const beforePersist = dependencies.beforePersist || (async () => {});

  function logMetrics(metrics) {
    logger.log(JSON.stringify({ event: "race_placement_transition", ...metrics }));
  }

  async function processOne() {
    const job = await jobModel.claimOne({ now: now() });
    if (!job) return null;
    const persistStartedAt = Date.now();
    let metrics = {
      placementProposed: 0,
      placementBaselineWinners: 0,
      placementSilentWinners: 0,
      placementEventInserts: 0,
      placementEventReplays: 0,
      placementCasLosses: 0,
      pages: 0,
      placementPersistStatements: 0,
      placementPersistMs: 0,
      placementOutcome: "not_applicable",
    };
    try {
      const context = await baselineModel.loadCanonicalContext(job.raceId);
      if (!context) {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          processingGeneration: job.processingGeneration,
          attempts: job.attempts,
          errorCode: "INCOMPLETE_ROSTER",
          now: now(),
        });
        metrics.placementOutcome = "incomplete_roster_retry";
        metrics.placementPersistMs = Math.max(0, Date.now() - persistStartedAt);
        logMetrics(metrics);
        return { job, metrics };
      }
      const plan = context.terminal ? null : planner({
        race: context.race,
        participants: context.participants,
        sourceGeneration: job.processingGeneration,
        occurredAt: job.processingObservedAt,
      });
      // Enforce every domain invariant before the first placement statement.
      (plan?.events || []).map(normalizeDomainEvent);
      metrics.placementProposed = plan?.baselineChanges.length || 0;
      await beforePersist({ job, context, plan });

      let superseded = false;
      let terminal = false;
      await prisma.$transaction(async (tx) => {
        // Global queue lock order is resolution then placement. The score
        // writer already owns resolution before it upserts the handoff.
        const resolutionCurrent = await baselineModel.lockResolutionGeneration(tx, {
          raceId: job.raceId,
          generation: job.processingGeneration,
        });
        metrics.placementPersistStatements += 1;
        const owned = await jobModel.lockOwned(tx, job);
        metrics.placementPersistStatements += 1;
        if (!owned) throw Object.assign(new Error("placement lease lost"), { code: "LEASE_LOST" });
        const generationCurrent = owned.requestedGeneration === job.processingGeneration &&
          resolutionCurrent;
        const fencedContext = generationCurrent
          ? await baselineModel.loadCanonicalContext(job.raceId, tx)
          : null;
        if (generationCurrent) metrics.placementPersistStatements += 2;
        if (generationCurrent && fencedContext?.terminal) {
          const completed = await jobModel.markSucceeded(tx, {
            id: job.id,
            leaseToken: job.leaseToken,
            processingGeneration: job.processingGeneration,
            now: now(),
          });
          metrics.placementPersistStatements += 1;
          if (!completed) throw Object.assign(
            new Error("placement completion fence lost"),
            { code: "LEASE_LOST" },
          );
          terminal = true;
          return;
        }
        if (!generationCurrent || !fencedContext ||
            context.terminal || fencedContext.fingerprint !== context.fingerprint) {
          const requeued = await jobModel.requeueSuperseded(tx, {
            id: job.id,
            leaseToken: job.leaseToken,
            processingGeneration: job.processingGeneration,
            now: now(),
          });
          metrics.placementPersistStatements += 1;
          if (!requeued) throw Object.assign(
            new Error("placement supersession fence lost"),
            { code: "LEASE_LOST" },
          );
          superseded = true;
          return;
        }

        const pages = [];
        for (let offset = 0; offset < plan.baselineChanges.length; offset += PAGE_SIZE) {
          pages.push(plan.baselineChanges.slice(offset, offset + PAGE_SIZE));
        }
        if (pages.length === 0) pages.push([]);
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
          const page = pages[pageIndex];
          metrics.pages += 1;
          const winnerIds = await baselineModel.compareAndSetPage(tx, page);
          metrics.placementPersistStatements += page.length > 0 ? 1 : 0;
          metrics.placementBaselineWinners += winnerIds.size;
          metrics.placementCasLosses += page.length - winnerIds.size;
          metrics.placementSilentWinners += page.filter(
            (change) => winnerIds.has(change.participantId) && change.silent,
          ).length;
          const events = plan.kind === "team"
            ? []
            : page.flatMap((change) =>
                winnerIds.has(change.participantId) && change.event ? [change.event] : []
              );
          const appended = await bulkAppendDomainEvents(tx, events);
          metrics.placementEventInserts += appended.inserted;
          metrics.placementEventReplays += appended.replayed;
          metrics.placementPersistStatements += appended.statementCount || 0;
        }
        if (plan.kind === "team") {
          const claimWon = await claimTeamTransition(tx, plan.teamClaim);
          if (plan.teamClaim) metrics.placementPersistStatements += 1;
          if (claimWon && plan.events.length > 0) {
            const appended = await bulkAppendDomainEvents(tx, plan.events);
            metrics.placementEventInserts += appended.inserted;
            metrics.placementEventReplays += appended.replayed;
            metrics.placementPersistStatements += appended.statementCount || 0;
          }
        }
        const completed = await jobModel.markSucceeded(tx, {
          id: job.id,
          leaseToken: job.leaseToken,
          processingGeneration: job.processingGeneration,
          now: now(),
        });
        metrics.placementPersistStatements += 1;
        if (!completed) throw Object.assign(new Error("placement completion fence lost"), { code: "LEASE_LOST" });
      }, { timeout: 5_000, maxWait: 10_000 });

      metrics.placementOutcome = terminal
        ? "terminal_skip"
        : superseded ? "superseded_skip" : "committed";
      metrics.placementPersistMs = Math.max(0, Date.now() - persistStartedAt);
      logMetrics(metrics);
      return { job, metrics };
    } catch (error) {
      metrics.placementPersistMs = Math.max(0, Date.now() - persistStartedAt);
      metrics.placementOutcome = error?.code === "LEASE_LOST"
        ? "lease_lost"
        : "retryable_failure";
      try {
        await jobModel.recordFailure({
          id: job.id,
          leaseToken: job.leaseToken,
          processingGeneration: job.processingGeneration,
          attempts: job.attempts,
          errorCode: error?.code || "PLACEMENT_WORKER_ERROR",
          now: now(),
        });
      } catch (failureError) {
        logger.error("[RACE_PLACEMENT_TRANSITION] recordFailure failed", failureError);
      }
      const method = job.attempts > 3 ? "error" : "warn";
      (logger[method] || logger.error).call(logger,
        "[RACE_PLACEMENT_TRANSITION] retryable worker failure", {
          errorCode: error?.code || "PLACEMENT_WORKER_ERROR",
          attempts: job.attempts,
          alarm: job.attempts > 3,
      });
      logMetrics(metrics);
      return { job, metrics, error };
    }
  }

  async function tick({ maxJobs = 1 } = {}) {
    let processed = 0;
    for (; processed < Math.max(1, maxJobs); processed += 1) {
      if (!(await processOne())) break;
    }
    return processed;
  }

  return { processOne, tick };
}

function scheduleRacePlacementTransitionWorker(dependencies = {}) {
  const worker = buildRacePlacementTransitionWorker(dependencies);
  const logger = dependencies.logger || console;
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } catch (error) {
      logger.error("[RACE_PLACEMENT_TRANSITION] tick failed", error);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  if (interval.unref) interval.unref();
  logger.log("[CRON] Race placement transition worker scheduled (poll 250ms)");
  return {
    interval,
    worker,
    stop() { clearInterval(interval); },
  };
}

module.exports = {
  POLL_INTERVAL_MS,
  buildRacePlacementTransitionWorker,
  scheduleRacePlacementTransitionWorker,
};
