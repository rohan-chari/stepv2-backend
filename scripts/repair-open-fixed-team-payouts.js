#!/usr/bin/env node
const crypto = require("node:crypto");
const { prisma } = require("../src/db");
const {
  evaluateOpenTeamPayoutRepair,
} = require("../src/modules/races/services/teamPayoutRepair");

const ENQUEUE_CONFIRMATION = "FIXED_TEAM_PAYOUT_REPAIR_V1";
const EXECUTION_CONFIRMATION = "FIXED_TEAM_PAYOUT_EXECUTION_V1";
const EXECUTION_HOLD_AT = new Date("9999-12-31T23:59:59.999Z");

function args(argv) {
  return {
    enqueue: argv.includes("--enqueue"),
    authorizeExecution: argv.includes("--authorize-execution"),
    confirmation: argv.find((value) => value.startsWith("--confirm-enqueue="))
      ?.slice("--confirm-enqueue=".length),
    executionConfirmation: argv.find((value) =>
      value.startsWith("--confirm-execution="))
      ?.slice("--confirm-execution=".length),
    reportDigest: argv.find((value) => value.startsWith("--report-digest="))
      ?.slice("--report-digest=".length),
  };
}

async function loadCandidates() {
  const rows = await loadRepairScope();
  return rows.filter(
    (race) => race.teamPayoutVersion == null && race.teamWinnerRewardCoins == null,
  );
}

async function loadRepairScope() {
  return prisma.race.findMany({
    where: {
      status: { in: ["PENDING", "ACTIVE"] },
      fundedPrize: true,
      isTeamRace: true,
      creatorId: { not: null },
      seedId: null,
      tournamentId: null,
      buyInAmount: 0,
    },
    include: { participants: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

function buildReport(races) {
  const repairCandidates = races.filter(
    (race) => race.teamPayoutVersion == null && race.teamWinnerRewardCoins == null,
  );
  const skippedPartialOrMalformed = races
    .filter((race) =>
      !(race.teamPayoutVersion == null && race.teamWinnerRewardCoins == null) &&
      !(race.teamPayoutVersion === 1 &&
        Number.isInteger(race.teamWinnerRewardCoins) &&
        race.teamWinnerRewardCoins > 0),
    )
    .map((race) => ({
      raceId: race.id,
      name: race.name,
      status: race.status,
      teamPayoutVersion: race.teamPayoutVersion,
      teamWinnerRewardCoins: race.teamWinnerRewardCoins,
      reason: "PARTIAL_OR_MALFORMED_STAMP_REQUIRES_MANUAL_REVIEW",
    }));
  const report = repairCandidates.map((race) => ({
    raceId: race.id,
    name: race.name,
    status: race.status,
    durationDays: race.maxDurationDays,
    ...evaluateOpenTeamPayoutRepair(race),
  }));
  const upward = report.filter((row) => row.increasesProjection);
  const nonUpward = report.filter((row) => !row.increasesProjection);
  const digestRows = report.map((row) => ({
    raceId: row.raceId,
    status: row.status,
    durationDays: row.durationDays,
    rewardCoins: row.rewardCoins,
    currentProjectionCoins: row.currentProjectionCoins,
    repairedProjectionCoins: row.repairedProjectionCoins,
    sideALiabilityCoins: row.sideALiabilityCoins,
    sideBLiabilityCoins: row.sideBLiabilityCoins,
    deltaCoins: row.deltaCoins,
    increasesProjection: row.increasesProjection,
  }));
  const reportDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ digestRows, skippedPartialOrMalformed }))
    .digest("hex");
  return {
    candidateCount: report.length,
    upwardCount: upward.length,
    skippedNonUpwardCount: nonUpward.length,
    skippedPartialOrMalformedCount: skippedPartialOrMalformed.length,
    reportDigest,
    upward,
    skippedNonUpward: nonUpward,
    skippedPartialOrMalformed,
  };
}

async function authorizeExecution(options) {
  if (options.executionConfirmation !== EXECUTION_CONFIRMATION) {
    throw new Error(
      "Execution authorization refused. Re-run with --authorize-execution " +
      `--confirm-execution=${EXECUTION_CONFIRMATION} --report-digest=<reviewed digest> ` +
      "only after enqueue has separate production authorization.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(options.reportDigest || "")) {
    throw new Error("Execution authorization refused: a reviewed report digest is required.");
  }
  const authorizedAt = new Date();
  const authorizedCount = await prisma.$transaction(async (tx) => {
    const commands = await tx.raceAdminCommand.findMany({
      where: {
        commandType: ENQUEUE_CONFIRMATION,
        status: "PENDING",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const cohort = commands.filter(
      (command) =>
        command.payload?.repairReportDigest === options.reportDigest,
    );
    const expectedCounts = new Set(
      cohort.map((command) => command.payload?.expectedUpwardCount),
    );
    if (
      cohort.length === 0 ||
      expectedCounts.size !== 1 ||
      !expectedCounts.has(cohort.length)
    ) {
      throw new Error(
        "Execution authorization refused: the held command cohort is incomplete.",
      );
    }
    let count = 0;
    for (const command of cohort) {
      if (command.payload?.executionAuthorized === true) continue;
      const updated = await tx.raceAdminCommand.updateMany({
        where: {
          id: command.id,
          status: "PENDING",
          availableAt: EXECUTION_HOLD_AT,
        },
        data: {
          payload: {
            ...command.payload,
            executionAuthorized: true,
            executionAuthorizedAt: authorizedAt.toISOString(),
          },
          availableAt: authorizedAt,
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          "Execution authorization refused: held command cohort changed.",
        );
      }
      count += 1;
    }
    return count;
  });
  return {
    mode: "authorize-execution",
    reportDigest: options.reportDigest,
    authorizedCount,
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.enqueue && options.authorizeExecution) {
    throw new Error("Choose either --enqueue or --authorize-execution, not both.");
  }
  if (options.authorizeExecution) {
    const result = await authorizeExecution(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.enqueue && options.confirmation !== ENQUEUE_CONFIRMATION) {
    throw new Error(
      `Enqueue refused. Re-run with --enqueue --confirm-enqueue=${ENQUEUE_CONFIRMATION} ` +
      "--report-digest=<reviewed digest> only after the dry-run report has " +
      "separate production authorization.",
    );
  }
  const report = buildReport(await loadRepairScope());
  if (options.enqueue && options.reportDigest !== report.reportDigest) {
    throw new Error(
      `Enqueue refused: candidate report changed since dry-run. Current digest ${report.reportDigest}.`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    mode: options.enqueue ? "enqueue" : "dry-run",
    ...report,
  }, null, 2)}\n`);
  if (!options.enqueue) return;
  await prisma.$transaction(async (tx) => {
    for (const row of report.upward) {
      const dedupeKey = `fixed-team-payout-v1:${row.raceId}`;
      const payload = {
        raceId: row.raceId,
        teamPayoutVersion: 1,
        teamWinnerRewardCoins: row.rewardCoins,
        dryRunDurationDays: row.durationDays,
        dryRunCurrentProjectionCoins: row.currentProjectionCoins,
        dryRunRepairedProjectionCoins: row.repairedProjectionCoins,
        dryRunSideALiabilityCoins: row.sideALiabilityCoins,
        dryRunSideBLiabilityCoins: row.sideBLiabilityCoins,
        repairReportDigest: report.reportDigest,
        expectedUpwardCount: report.upwardCount,
        executionAuthorized: false,
      };
      const existing = await tx.raceAdminCommand.findUnique({
        where: { dedupeKey },
      });
      if (!existing) {
        await tx.raceAdminCommand.create({
          data: {
          raceId: row.raceId,
          commandType: ENQUEUE_CONFIRMATION,
          dedupeKey,
          payload,
          availableAt: EXECUTION_HOLD_AT,
          },
        });
        continue;
      }
      // A reviewed snapshot can legitimately become stale before the fenced
      // command runs (for example, a participant joins). That terminal command
      // made no mutation, so a fresh reviewed digest may safely re-arm it. A
      // successful command has lastError NULL and is deliberately never reset.
      await tx.raceAdminCommand.updateMany({
        where: {
          id: existing.id,
          status: "COMPLETED",
          lastError: "REPAIR_SNAPSHOT_MISMATCH",
        },
        data: {
          payload,
          status: "PENDING",
          availableAt: EXECUTION_HOLD_AT,
          attempts: 0,
          completedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
    }
  });
}

if (require.main === module) {
  main()
    .then(async () => {
      await prisma.$disconnect();
      // The Prisma pg adapter owns a separate pool whose idle handles outlive
      // `$disconnect()`. This is a bounded one-shot CLI, so terminate only
      // after all report/enqueue work and disconnect have completed.
      process.exit(0);
    })
    .catch(async (error) => {
      console.error(error);
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    });
}

module.exports = {
  args,
  authorizeExecution,
  buildReport,
  loadCandidates,
  loadRepairScope,
  main,
};
