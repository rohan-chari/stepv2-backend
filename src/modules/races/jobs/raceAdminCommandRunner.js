const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const {
  acquireRaceWriteFence,
  lockCompetitionRows,
} = require("../services/raceWriteFence");
const {
  computeRaceExposureStamp,
  lockFundedExposureUsers,
  reserveFundedExposure,
  resolveRacePrizeStamp,
} = require("../services/fundedExposure");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");
const {
  invalidateRaceProgress: defaultInvalidateRaceProgress,
} = require("../services/raceProgressSnapshot");
const {
  invalidateUser: defaultInvalidateRaceListUser,
} = require("../services/raceListCache");
const {
  evaluateOpenTeamPayoutRepair,
} = require("../services/teamPayoutRepair");

const POLL_INTERVAL_MS = 1000;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 10;

async function claimCommand(prisma, at) {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(at.getTime() + LEASE_MS);
  const rows = await prisma.$transaction((tx) => tx.$queryRaw`
    WITH candidate AS (
      SELECT id
        FROM race_admin_commands
       WHERE (status = 'PENDING' AND available_at <= ${at})
          OR (status = 'RUNNING' AND lease_expires_at < ${at})
       ORDER BY available_at ASC, created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE race_admin_commands command
       SET status = 'RUNNING',
           lease_token = ${leaseToken},
           lease_expires_at = ${leaseExpiresAt},
           attempts = attempts + 1,
           updated_at = ${at}
      FROM candidate
     WHERE command.id = candidate.id
    RETURNING command.*
  `);
  return rows[0] || null;
}

function commandPayload(command) {
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("race admin command payload is invalid");
  }
  if (payload.raceId !== command.race_id) {
    throw new Error("race admin command raceId mismatch");
  }
  return payload;
}

async function activateTournamentPowerups(tx, command, payload, at) {
  const activatedAt = new Date(payload.activatedAt);
  if (Number.isNaN(activatedAt.getTime()) ||
      typeof payload.tournamentId !== "string") {
    throw new Error("tournament activation identity is invalid");
  }
  const race = await tx.race.findUnique({
    where: { id: command.race_id },
    include: { tournament: true },
  });
  if (!race || race.status !== "ACTIVE" ||
      race.tournamentId !== payload.tournamentId ||
      race.tournament?.status !== "ACTIVE") {
    return {
      mutated: false,
      terminalReason: "TOURNAMENT_MATCHUP_NOT_ACTIVE",
      tournamentId: payload.tournamentId,
      participantUserIds: [],
    };
  }
  if (race.tournamentPowerupsActivatedAt != null) {
    return {
      mutated: false,
      terminalReason: race.tournamentPowerupsActivatedAt.getTime() === activatedAt.getTime()
        ? "ACTIVATION_ALREADY_APPLIED"
        : "ACTIVATION_IDENTITY_MISMATCH",
      tournamentId: race.tournamentId,
      participantUserIds: [],
    };
  }
  // A separately-enabled race has no trustworthy prospective activation
  // boundary. Never rewrite its baselines retroactively.
  if (race.powerupsEnabled === true) {
    return {
      mutated: false,
      terminalReason: "POWERUPS_ALREADY_ENABLED_WITHOUT_ACTIVATION_IDENTITY",
      tournamentId: race.tournamentId,
      participantUserIds: [],
    };
  }
  const interval = Number.isInteger(payload.powerupStepInterval)
    ? payload.powerupStepInterval
    : Number.isInteger(payload.interval) ? payload.interval : 2000;
  const participants = await tx.raceParticipant.findMany({
    where: { raceId: race.id, status: "ACCEPTED" },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });
  const captured = payload.baselineByParticipant;
  if (captured && (typeof captured !== "object" || Array.isArray(captured))) {
    throw new Error("tournament activation baseline snapshot is invalid");
  }
  const baselines = participants.map((participant) => {
    const capturedValue = captured?.[participant.id];
    return {
      participant,
      rawAtActivation: Math.max(0, Number(
        capturedValue ?? participant.rawSteps ??
          (participant.totalSteps - participant.bonusSteps),
      ) || 0),
    };
  });
  await tx.race.update({
    where: { id: race.id },
    data: {
      powerupsEnabled: true,
      powerupStepInterval: interval,
      tournamentPowerupsActivatedAt: activatedAt,
    },
  });
  for (const { participant, rawAtActivation } of baselines) {
    await tx.raceParticipant.update({
      where: { id: participant.id },
      data: {
        baselineSteps: rawAtActivation,
        nextBoxAtSteps: rawAtActivation + interval,
        totalsUpdatedAt: at,
      },
    });
  }
  return {
    mutated: true,
    tournamentId: race.tournamentId,
    participantUserIds: participants.map((participant) => participant.userId),
  };
}

async function enrollHistoricalCohort(tx, command, payload, at) {
  const requested = [...new Set(
    (Array.isArray(payload.userIds) ? payload.userIds : [])
      .filter((id) => typeof id === "string" && id.length > 0),
  )].sort();
  if (requested.length === 0) return { retryUserIds: [] };
  await acquireGlobalEnrollmentLock(tx);
  await lockFundedExposureUsers(tx, requested);
  const signupRows = await tx.user.findMany({
    where: { id: { in: requested } },
    select: { id: true, createdAt: true },
    orderBy: { id: "asc" },
  });
  const signupAtByUser = new Map(
    signupRows.map((row) => [row.id, row.createdAt]),
  );
  const race = await tx.race.findUnique({ where: { id: command.race_id } });
  if (!race || !["PENDING", "ACTIVE"].includes(race.status)) {
    return { retryUserIds: [], terminalReason: "RACE_NOT_JOINABLE" };
  }
  const expectedStart = new Date(payload.windowStart);
  const expectedEnd = new Date(payload.windowEnd);
  const bucket = race.seededBucketId
    ? await tx.seededRaceBucket.findUnique({ where: { id: race.seededBucketId } })
    : null;
  const identityMatches =
    typeof payload.seedId === "string" && race.seedId === payload.seedId &&
    race.seededBucketId === (payload.seededBucketId || null) &&
    race.timezone === "America/New_York" &&
    !Number.isNaN(expectedStart.getTime()) &&
    !Number.isNaN(expectedEnd.getTime()) &&
    (bucket
      ? bucket.seedId === payload.seedId &&
        bucket.windowStart.getTime() === expectedStart.getTime() &&
        bucket.windowEnd.getTime() === expectedEnd.getTime()
      : race.scheduledStartAt?.getTime() === expectedStart.getTime());
  if (!identityMatches) {
    throw new Error("historical cohort target identity mismatch");
  }
  await lockCompetitionRows(tx, { raceIds: [race.id] });
  const exposureStamp = race.fundedPrize === true
    ? computeRaceExposureStamp({
        maxDurationDays: race.maxDurationDays,
        prizeCoinUnit: resolveRacePrizeStamp(race).prizeCoinUnit,
        teamPoolMultBps: race.teamPoolMultBps,
      })
    : null;
  let acceptedCount = await tx.raceParticipant.count({
    where: { raceId: race.id, status: "ACCEPTED" },
  });
  const retryUserIds = [];
  for (const userId of requested) {
    const existing = await tx.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId } },
      select: { id: true },
    });
    if (existing) continue;
    if (race.maxParticipants != null && acceptedCount >= race.maxParticipants) {
      retryUserIds.push(userId);
      continue;
    }
    if (exposureStamp) {
      await reserveFundedExposure({
        tx,
        userId,
        stamp: exposureStamp,
        competition: { raceId: race.id },
        // This is the reservation that would already have existed at signup;
        // applying today's live cap would make the repair non-historical.
        enforceLimits: false,
      });
    }
    await tx.raceParticipant.create({
      data: {
        raceId: race.id,
        userId,
        status: "ACCEPTED",
        joinedAt: signupAtByUser.get(userId) || at,
        ...(exposureStamp ? {
          fundedExposureMillicoins: exposureStamp.exposureMillicoins,
          fundedExposureRateMillicoinsPerDay:
            exposureStamp.exposureRateMillicoinsPerDay,
        } : {}),
      },
    });
    acceptedCount += 1;
  }
  return { retryUserIds };
}

async function repairFixedTeamPayout(tx, command, payload) {
  const race = await tx.race.findUnique({
    where: { id: command.race_id },
    include: { participants: true },
  });
  const participantUserIds = (race?.participants || [])
    .map((participant) => participant.userId)
    .filter(Boolean);
  if (
    payload.executionAuthorized !== true ||
    !/^[a-f0-9]{64}$/.test(payload.repairReportDigest || "") ||
    !Number.isInteger(payload.expectedUpwardCount) ||
    payload.expectedUpwardCount <= 0
  ) {
    return {
      mutated: false,
      terminalReason: "REPAIR_EXECUTION_NOT_AUTHORIZED",
      participantUserIds,
    };
  }
  if (!race || !["PENDING", "ACTIVE"].includes(race.status)) {
    return {
      mutated: false,
      terminalReason: "RACE_NOT_OPEN",
      participantUserIds,
    };
  }
  if (
    race.fundedPrize !== true ||
    race.isTeamRace !== true ||
    race.creatorId == null ||
    race.seedId != null ||
    race.tournamentId != null ||
    (race.buyInAmount || 0) > 0
  ) {
    return {
      mutated: false,
      terminalReason: "RACE_OUT_OF_SCOPE",
      participantUserIds,
    };
  }
  if (
    race.teamPayoutVersion != null ||
    race.teamWinnerRewardCoins != null
  ) {
    return {
      mutated: false,
      terminalReason:
        race.teamPayoutVersion === 1 && race.teamWinnerRewardCoins > 0
          ? "RACE_ALREADY_STAMPED"
          : "RACE_PARTIAL_OR_MALFORMED_STAMP",
      participantUserIds,
    };
  }
  const evaluation = evaluateOpenTeamPayoutRepair(race);
  if (
    payload.teamPayoutVersion !== 1 ||
    payload.teamWinnerRewardCoins !== evaluation.rewardCoins
  ) {
    return {
      mutated: false,
      terminalReason: "REPAIR_IDENTITY_MISMATCH",
      participantUserIds,
    };
  }
  if (
    payload.dryRunDurationDays !== race.maxDurationDays ||
    payload.dryRunCurrentProjectionCoins !==
      evaluation.currentProjectionCoins ||
    payload.dryRunRepairedProjectionCoins !==
      evaluation.repairedProjectionCoins ||
    payload.dryRunSideALiabilityCoins !== evaluation.sideALiabilityCoins ||
    payload.dryRunSideBLiabilityCoins !== evaluation.sideBLiabilityCoins
  ) {
    return {
      mutated: false,
      terminalReason: "REPAIR_SNAPSHOT_MISMATCH",
      participantUserIds,
    };
  }
  if (!evaluation.increasesProjection) {
    return {
      mutated: false,
      terminalReason: evaluation.deltaCoins < 0
        ? "REPAIR_WOULD_DECREASE"
        : "REPAIR_NOT_UPWARD",
      participantUserIds,
    };
  }
  const updated = await tx.race.updateMany({
    where: {
      id: race.id,
      status: { in: ["PENDING", "ACTIVE"] },
      teamPayoutVersion: null,
      teamWinnerRewardCoins: null,
    },
    data: {
      teamPayoutVersion: 1,
      teamWinnerRewardCoins: evaluation.rewardCoins,
    },
  });
  if (updated.count !== 1) {
    return {
      mutated: false,
      terminalReason: "REPAIR_CAS_LOST",
      participantUserIds,
    };
  }
  return {
    mutated: true,
    participantUserIds,
    evaluation,
  };
}

function buildRaceAdminCommandWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const invalidateRaceProgress =
    dependencies.invalidateRaceProgress || defaultInvalidateRaceProgress;
  const invalidateRaceListUser =
    dependencies.invalidateRaceListUser || defaultInvalidateRaceListUser;
  // Tournament reads are currently direct Postgres reads. Keep an injectable
  // post-commit seam so introducing a tournament cache cannot make this worker
  // silently stale, and tests can assert the required invalidation boundary.
  const invalidateTournament = dependencies.invalidateTournament || (async () => true);

  return async function runRaceAdminCommand() {
    const command = await claimCommand(prisma, now());
    if (!command) return false;
    try {
      const execution = await prisma.$transaction(async (tx) => {
        await acquireRaceWriteFence(tx, command.race_id);
        const fenced = await tx.raceAdminCommand.findFirst({
          where: {
            id: command.id,
            status: "RUNNING",
            leaseToken: command.lease_token,
          },
        });
        if (!fenced) throw new Error("race admin command lease lost");
        const payload = commandPayload(command);
        let outcome = null;
        if (command.command_type === "TOURNAMENT_POWERUPS_ACTIVATE") {
          outcome = await activateTournamentPowerups(tx, command, payload, now());
        } else if (command.command_type === "HISTORICAL_COHORT_ENROLLMENT") {
          outcome = await enrollHistoricalCohort(tx, command, payload, now());
        } else if (command.command_type === "FIXED_TEAM_PAYOUT_REPAIR_V1") {
          outcome = await repairFixedTeamPayout(tx, command, payload);
        } else {
          throw new Error(`unknown race admin command ${command.command_type}`);
        }
        const retryUserIds = outcome?.retryUserIds || [];
        const completed = await tx.raceAdminCommand.updateMany({
          where: { id: command.id, status: "RUNNING", leaseToken: command.lease_token },
          data: retryUserIds.length > 0
            ? {
                status: "PENDING",
                payload: {
                  ...payload,
                  userIds: retryUserIds,
                  skippedUserIds: retryUserIds,
                  lastAttemptAt: now().toISOString(),
                },
                availableAt: new Date(now().getTime() + 60 * 60_000),
                leaseToken: null,
                leaseExpiresAt: null,
                lastError: `CAPACITY_SKIPPED:${retryUserIds.join(",")}`,
              }
            : {
                status: "COMPLETED",
                completedAt: now(),
                leaseToken: null,
                leaseExpiresAt: null,
                lastError: outcome?.terminalReason || null,
              },
        });
        if (completed.count !== 1) throw new Error("race admin command lease lost");
        return { outcome, raceId: command.race_id, commandId: command.id };
      }, { timeout: 30_000, maxWait: 10_000 });
      if (execution.outcome?.mutated) {
        const invalidateWithRetry = async (surface, run) => {
          let lastError = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
              const result = await run();
              if (result !== false) return null;
              lastError = new Error("invalidator returned false");
            } catch (error) {
              lastError = error;
            }
          }
          logger.error("[RACE_ADMIN_COMMAND] cache invalidation failed", {
            commandId: execution.commandId,
            raceId: execution.raceId,
            surface,
            attempts: 3,
            error: lastError?.message || String(lastError),
          });
          return surface;
        };
        const invalidationFailures = (await Promise.all([
          invalidateWithRetry("race_progress", () =>
            invalidateRaceProgress(execution.raceId)),
          ...(execution.outcome.tournamentId
            ? [invalidateWithRetry("tournament", () =>
                invalidateTournament(execution.outcome.tournamentId))]
            : []),
          ...execution.outcome.participantUserIds.map((userId) =>
            invalidateWithRetry(`race_list:${userId}`, () =>
              invalidateRaceListUser(userId))
          ),
        ])).filter(Boolean);
        if (invalidationFailures.length > 0) {
          await prisma.raceAdminCommand.updateMany({
            where: { id: execution.commandId, status: "COMPLETED" },
            data: {
              lastError: `CACHE_INVALIDATION_FAILED:${invalidationFailures.join(",")}`
                .slice(0, 2000),
            },
          });
        }
      }
      return true;
    } catch (error) {
      const attempts = Number(command.attempts) || 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      await prisma.raceAdminCommand.updateMany({
        where: { id: command.id, status: "RUNNING", leaseToken: command.lease_token },
        data: {
          status: terminal ? "FAILED" : "PENDING",
          availableAt: new Date(now().getTime() + backoffSeconds * 1000),
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: String(error?.message || error).slice(0, 2000),
        },
      });
      logger.error("[RACE_ADMIN_COMMAND] command failed", {
        commandId: command.id,
        commandType: command.command_type,
        error: error?.message || String(error),
      });
      return true;
    }
  };
}

function scheduleRaceAdminCommandRunner(dependencies = {}) {
  const run = buildRaceAdminCommandWorker(dependencies);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while (await run()) {}
    } finally {
      running = false;
    }
  };
  tick().catch((error) => (dependencies.logger || console).error(error));
  const interval = setInterval(
    () => tick().catch((error) => (dependencies.logger || console).error(error)),
    dependencies.intervalMs || POLL_INTERVAL_MS,
  );
  if (interval.unref) interval.unref();
  return { interval, run };
}

module.exports = {
  buildRaceAdminCommandWorker,
  scheduleRaceAdminCommandRunner,
  claimCommand,
  repairFixedTeamPayout,
  POLL_INTERVAL_MS,
};
