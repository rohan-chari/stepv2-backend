const { ConflictError } = require("../../../shared/errors/AppError");
const { durationPoints } = require("../../../shared/economy/prizePool");
const { lockCompetitionRows } = require("./raceWriteFence");

const FUNDED_EXPOSURE_LIMIT_MILLICOINS = 300_000;
const FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY = 40_000;
const PRIZE_CALCULATION_VERSION_V2 = 2;
const PRIZE_COIN_UNIT_V1 = 20;
const PRIZE_COIN_UNIT_V2 = 10;
const RACE_POOL_MAX_V1 = 16_000;
const RACE_POOL_MAX_V2 = 8_000;
const TOURNAMENT_CHAMPION_MAX_V1 = 1_000;
const TOURNAMENT_CHAMPION_MAX_V2 = 500;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedDurationDays(value) {
  return Math.max(1, positiveInteger(value, 1));
}

function resolveRacePrizeStamp(race = {}) {
  const v2 = Number(race.prizeCalculationVersion) >= 2;
  return {
    prizeCalculationVersion: v2 ? PRIZE_CALCULATION_VERSION_V2 : 1,
    prizeCoinUnit: positiveInteger(
      race.prizeCoinUnit,
      v2 ? PRIZE_COIN_UNIT_V2 : PRIZE_COIN_UNIT_V1,
    ),
    prizePoolMaxCoins: positiveInteger(
      race.prizePoolMaxCoins,
      v2 ? RACE_POOL_MAX_V2 : RACE_POOL_MAX_V1,
    ),
  };
}

function resolveTournamentPrizeStamp(tournament = {}) {
  const v2 = Number(tournament.prizeCalculationVersion) >= 2;
  return {
    prizeCalculationVersion: v2 ? PRIZE_CALCULATION_VERSION_V2 : 1,
    prizeCoinUnit: positiveInteger(
      tournament.prizeCoinUnit,
      v2 ? PRIZE_COIN_UNIT_V2 : PRIZE_COIN_UNIT_V1,
    ),
    tournamentChampionMaxCoins: positiveInteger(
      tournament.tournamentChampionMaxCoins,
      v2 ? TOURNAMENT_CHAMPION_MAX_V2 : TOURNAMENT_CHAMPION_MAX_V1,
    ),
  };
}

function newRacePrizeStamp() {
  return {
    prizeCalculationVersion: PRIZE_CALCULATION_VERSION_V2,
    prizeCoinUnit: PRIZE_COIN_UNIT_V2,
    prizePoolMaxCoins: RACE_POOL_MAX_V2,
  };
}

function newTournamentPrizeStamp() {
  return {
    prizeCalculationVersion: PRIZE_CALCULATION_VERSION_V2,
    prizeCoinUnit: PRIZE_COIN_UNIT_V2,
    tournamentChampionMaxCoins: TOURNAMENT_CHAMPION_MAX_V2,
  };
}

function computeRaceExposureStamp({
  maxDurationDays,
  prizeCoinUnit,
  teamPoolMultBps,
}) {
  const durationDays = normalizedDurationDays(maxDurationDays);
  const unit = positiveInteger(prizeCoinUnit, PRIZE_COIN_UNIT_V1);
  const multiplierBps = positiveInteger(teamPoolMultBps, 10_000);
  const numerator =
    durationPoints(durationDays) * unit * 1_000 * multiplierBps;
  const exposureMillicoins = Math.ceil(numerator / 10_000);
  return {
    exposureMillicoins,
    exposureRateMillicoinsPerDay: Math.ceil(
      exposureMillicoins / durationDays,
    ),
  };
}

function computeTournamentExposureStamp({
  bracketSize,
  totalRounds,
  matchupDurationDays,
  prizeCoinUnit,
  tournamentChampionMaxCoins,
}) {
  const size = positiveInteger(bracketSize, 4);
  const pricedDays =
    positiveInteger(totalRounds, Math.ceil(Math.log2(size))) *
    normalizedDurationDays(matchupDurationDays);
  const unit = positiveInteger(prizeCoinUnit, PRIZE_COIN_UNIT_V1);
  const maxCoins = positiveInteger(
    tournamentChampionMaxCoins,
    TOURNAMENT_CHAMPION_MAX_V1,
  );
  const poolCoins = Math.min(
    size * durationPoints(pricedDays) * unit,
    maxCoins,
  );
  const exposureMillicoins = Math.ceil((poolCoins * 1_000) / size);
  return {
    exposureMillicoins,
    exposureRateMillicoinsPerDay: Math.ceil(
      exposureMillicoins / pricedDays,
    ),
  };
}

function displayCoins(millicoins) {
  return Math.ceil(Math.max(0, Number(millicoins) || 0) / 1_000);
}

function fundedExposureConflict({
  currentExposureMillicoins,
  requestedExposureMillicoins,
  currentRateMillicoinsPerDay,
  requestedRateMillicoinsPerDay,
}) {
  return new ConflictError(
    "Finish or leave another funded race before joining this one.",
    "FUNDED_EXPOSURE_LIMIT",
    {
      limitCoins: FUNDED_EXPOSURE_LIMIT_MILLICOINS / 1_000,
      dailyRateLimitCoins:
        FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY / 1_000,
      currentCoins: displayCoins(currentExposureMillicoins),
      requestedCoins: displayCoins(requestedExposureMillicoins),
      currentDailyRateCoins: displayCoins(currentRateMillicoinsPerDay),
      requestedDailyRateCoins: displayCoins(
        requestedRateMillicoinsPerDay,
      ),
    },
  );
}

function isExposureEnforcementEnabled(env = process.env) {
  return env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED === "true";
}

function isFundedPrizeV2Enabled(env = process.env) {
  return env.FUNDED_PRIZE_V2_ENABLED === "true";
}

async function lockUserGuard(tx, userId) {
  try {
    await tx.fundedExposureGuard.upsert({
      where: { userId },
      create: { userId },
      update: { updatedAt: new Date() },
    });
  } catch (error) {
    // Account deletion may win after an admission's optimistic auth read. Do
    // not expose the guard FK as a 500; the admission is safely retryable and
    // its transaction has not written membership state.
    if (error?.code === "P2003") throw fundedExposureDriftConflict();
    throw error;
  }
  await tx.$queryRaw`
    SELECT user_id
    FROM funded_exposure_guards
    WHERE user_id = ${userId}
    FOR UPDATE
  `;
}

async function lockFundedExposureUsers(tx, userIds) {
  if (!tx || !Array.isArray(userIds)) {
    throw new TypeError("tx and userIds are required");
  }
  const ordered = [...new Set(userIds.filter(Boolean))].sort();
  for (const userId of ordered) await lockUserGuard(tx, userId);
  return ordered;
}

function raceStampForRow(row) {
  const prize = resolveRacePrizeStamp(row.race);
  return computeRaceExposureStamp({
    maxDurationDays: row.race.maxDurationDays,
    prizeCoinUnit: prize.prizeCoinUnit,
    teamPoolMultBps: row.race.teamPoolMultBps,
  });
}

function tournamentStampForRow(row) {
  const prize = resolveTournamentPrizeStamp(row.tournament);
  return computeTournamentExposureStamp({
    bracketSize: row.tournament.bracketSize,
    totalRounds: row.tournament.totalRounds,
    matchupDurationDays: row.tournament.matchupDurationDays,
    prizeCoinUnit: prize.prizeCoinUnit,
    tournamentChampionMaxCoins: prize.tournamentChampionMaxCoins,
  });
}

function fundedExposureDriftConflict() {
  return new ConflictError(
    "Funded race membership changed while checking exposure. Please retry.",
    "FUNDED_EXPOSURE_RETRY",
  );
}

async function loadAndHealCurrentExposure(
  tx,
  userId,
  { targetRaceIds = [], targetTournamentIds = [] } = {},
) {
  // Discover the touched competitions only after the caller holds the user
  // guard, then lock every race/tournament in lexical kind/id order. Reread
  // below the locks: the discovery rows are never used as healing authority.
  const discoveredRaceRows = await tx.raceParticipant.findMany({
      where: {
        userId,
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
      },
      select: {
        raceId: true,
      },
    });
  const discoveredTournamentRows = await tx.tournamentParticipant.findMany({
      where: {
        userId,
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          fundedPrize: true,
          status: { in: ["PENDING", "ACTIVE"] },
          seedId: null,
        },
      },
      select: { tournamentId: true },
    });
  const raceIds = [...new Set([
    ...discoveredRaceRows.map((row) => row.raceId),
    ...targetRaceIds,
  ].filter(Boolean))].sort();
  const tournamentIds = [
    ...new Set([
      ...discoveredTournamentRows.map((row) => row.tournamentId),
      ...targetTournamentIds,
    ].filter(Boolean)),
  ].sort();
  if (raceIds.length > 0) {
    await tx.$queryRawUnsafe(
      "SELECT id FROM races WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE",
      raceIds,
    );
  }
  if (tournamentIds.length > 0) {
    await tx.$queryRawUnsafe(
      "SELECT id FROM tournaments WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE",
      tournamentIds,
    );
  }

  const raceRows = await tx.raceParticipant.findMany({
      where: {
        userId,
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
      },
      select: {
        id: true,
        raceId: true,
        fundedExposureMillicoins: true,
        fundedExposureRateMillicoinsPerDay: true,
        race: {
          select: {
            maxDurationDays: true,
            teamPoolMultBps: true,
            prizeCoinUnit: true,
            prizePoolMaxCoins: true,
            prizeCalculationVersion: true,
          },
        },
      },
    });
  const tournamentRows = await tx.tournamentParticipant.findMany({
      where: {
        userId,
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          fundedPrize: true,
          status: { in: ["PENDING", "ACTIVE"] },
          seedId: null,
        },
      },
      select: {
        id: true,
        tournamentId: true,
        fundedExposureMillicoins: true,
        fundedExposureRateMillicoinsPerDay: true,
        tournament: {
          select: {
            bracketSize: true,
            totalRounds: true,
            matchupDurationDays: true,
            prizeCoinUnit: true,
            tournamentChampionMaxCoins: true,
            prizeCalculationVersion: true,
          },
        },
      },
    });

  const lockedRaceIds = new Set(raceIds);
  const lockedTournamentIds = new Set(tournamentIds);
  if (
    raceRows.some((row) => !lockedRaceIds.has(row.raceId)) ||
    tournamentRows.some((row) => !lockedTournamentIds.has(row.tournamentId))
  ) {
    throw fundedExposureDriftConflict();
  }

  let exposureMillicoins = 0;
  let exposureRateMillicoinsPerDay = 0;
  for (const row of raceRows) {
    const stamp =
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null
        ? raceStampForRow(row)
        : {
            exposureMillicoins: row.fundedExposureMillicoins,
            exposureRateMillicoinsPerDay:
              row.fundedExposureRateMillicoinsPerDay,
          };
    if (
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null
    ) {
      await tx.raceParticipant.update({
        where: { id: row.id },
        data: {
          fundedExposureMillicoins: stamp.exposureMillicoins,
          fundedExposureRateMillicoinsPerDay:
            stamp.exposureRateMillicoinsPerDay,
        },
      });
    }
    exposureMillicoins += stamp.exposureMillicoins;
    exposureRateMillicoinsPerDay += stamp.exposureRateMillicoinsPerDay;
  }
  for (const row of tournamentRows) {
    const stamp =
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null
        ? tournamentStampForRow(row)
        : {
            exposureMillicoins: row.fundedExposureMillicoins,
            exposureRateMillicoinsPerDay:
              row.fundedExposureRateMillicoinsPerDay,
          };
    if (
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null
    ) {
      await tx.tournamentParticipant.update({
        where: { id: row.id },
        data: {
          fundedExposureMillicoins: stamp.exposureMillicoins,
          fundedExposureRateMillicoinsPerDay:
            stamp.exposureRateMillicoinsPerDay,
        },
      });
    }
    exposureMillicoins += stamp.exposureMillicoins;
    exposureRateMillicoinsPerDay += stamp.exposureRateMillicoinsPerDay;
  }

  // An old binary/worker may not know about the guard yet. Recheck after the
  // heal writes and fail the whole transaction if it inserted a membership in
  // a competition outside the locked discovery+target union.
  const finalRaceRows = await tx.raceParticipant.findMany({
    where: {
      userId,
      status: "ACCEPTED",
      finishedAt: null,
      forfeitedAt: null,
      race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
    },
    select: { raceId: true },
  });
  const finalTournamentRows = await tx.tournamentParticipant.findMany({
    where: {
      userId,
      status: "ACCEPTED",
      eliminatedInRound: null,
      tournament: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        seedId: null,
      },
    },
    select: { tournamentId: true },
  });
  if (
    finalRaceRows.some((row) => !lockedRaceIds.has(row.raceId)) ||
    finalTournamentRows.some(
      (row) => !lockedTournamentIds.has(row.tournamentId),
    )
  ) {
    throw fundedExposureDriftConflict();
  }
  return { exposureMillicoins, exposureRateMillicoinsPerDay };
}

async function auditLiveFundedExposure(prisma) {
  const raceNulls = await prisma.raceParticipant.count({
      where: {
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
        OR: [
          { fundedExposureMillicoins: null },
          { fundedExposureRateMillicoinsPerDay: null },
        ],
      },
    });
  const tournamentNulls = await prisma.tournamentParticipant.count({
      where: {
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          fundedPrize: true,
          seedId: null,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        OR: [
          { fundedExposureMillicoins: null },
          { fundedExposureRateMillicoinsPerDay: null },
        ],
      },
    });
  return { raceNulls, tournamentNulls, totalNulls: raceNulls + tournamentNulls };
}

async function backfillLiveFundedExposure(tx) {
  const raceUsers = await tx.raceParticipant.findMany({
      where: {
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
        OR: [
          { fundedExposureMillicoins: null },
          { fundedExposureRateMillicoinsPerDay: null },
        ],
      },
      distinct: ["userId"],
      select: { userId: true },
    });
  const tournamentUsers = await tx.tournamentParticipant.findMany({
      where: {
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          fundedPrize: true,
          seedId: null,
          status: { in: ["PENDING", "ACTIVE"] },
        },
        OR: [
          { fundedExposureMillicoins: null },
          { fundedExposureRateMillicoinsPerDay: null },
        ],
      },
      distinct: ["userId"],
      select: { userId: true },
    });
  const userIds = [...new Set([...raceUsers, ...tournamentUsers].map((row) => row.userId))]
    .sort();
  await lockFundedExposureUsers(tx, userIds);

  for (const userId of userIds) await loadAndHealCurrentExposure(tx, userId);
  const audit = await auditLiveFundedExposure(tx);
  if (audit.totalNulls !== 0) {
    throw new Error(`Funded exposure catch-up left ${audit.totalNulls} live null stamp(s)`);
  }
  return { usersBackfilled: userIds.length, ...audit };
}

async function reserveFundedExposure({
  tx,
  userId,
  stamp,
  competition = null,
  enforce = isExposureEnforcementEnabled(),
}) {
  if (!tx || !userId || !stamp) {
    throw new TypeError("tx, userId, and stamp are required");
  }
  await reserveFundedExposures({
    tx,
    reservations: [{ userId, stamp, competition }],
    enforce,
  });
  return stamp;
}

async function reserveFundedExposures({
  tx,
  reservations,
  enforce = isExposureEnforcementEnabled(),
}) {
  if (!tx || !Array.isArray(reservations)) {
    throw new TypeError("tx and reservations are required");
  }
  const ordered = [...reservations]
    .filter((entry) => entry?.userId && entry?.stamp)
    .sort((a, b) => a.userId.localeCompare(b.userId));
  await lockFundedExposureUsers(tx, ordered.map(({ userId }) => userId));
  if (!enforce) {
    await lockCompetitionRows(tx, {
      raceIds: ordered.map((entry) => entry.competition?.raceId),
      tournamentIds: ordered.map(
        (entry) => entry.competition?.tournamentId,
      ),
    });
    return ordered.map(({ stamp }) => stamp);
  }
  for (const { userId, stamp } of ordered) {
    const owned = ordered.filter((entry) => entry.userId === userId);
    const current = await loadAndHealCurrentExposure(tx, userId, {
      targetRaceIds: owned.map((entry) => entry.competition?.raceId),
      targetTournamentIds: owned.map(
        (entry) => entry.competition?.tournamentId,
      ),
    });
    const exceedsRaw =
      current.exposureMillicoins + stamp.exposureMillicoins >
      FUNDED_EXPOSURE_LIMIT_MILLICOINS;
    const exceedsRate =
      current.exposureRateMillicoinsPerDay +
        stamp.exposureRateMillicoinsPerDay >
      FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY;
    if (exceedsRaw || exceedsRate) {
      throw fundedExposureConflict({
        currentExposureMillicoins: current.exposureMillicoins,
        requestedExposureMillicoins: stamp.exposureMillicoins,
        currentRateMillicoinsPerDay: current.exposureRateMillicoinsPerDay,
        requestedRateMillicoinsPerDay:
          stamp.exposureRateMillicoinsPerDay,
      });
    }
  }
  return ordered.map(({ stamp }) => stamp);
}

module.exports = {
  FUNDED_EXPOSURE_LIMIT_MILLICOINS,
  FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY,
  PRIZE_CALCULATION_VERSION_V2,
  PRIZE_COIN_UNIT_V2,
  RACE_POOL_MAX_V2,
  TOURNAMENT_CHAMPION_MAX_V2,
  auditLiveFundedExposure,
  backfillLiveFundedExposure,
  computeRaceExposureStamp,
  computeTournamentExposureStamp,
  fundedExposureConflict,
  isExposureEnforcementEnabled,
  isFundedPrizeV2Enabled,
  loadAndHealCurrentExposure,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  newTournamentPrizeStamp,
  reserveFundedExposure,
  reserveFundedExposures,
  resolveRacePrizeStamp,
  resolveTournamentPrizeStamp,
};
