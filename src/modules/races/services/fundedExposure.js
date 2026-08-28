const { ConflictError } = require("../../../shared/errors/AppError");
const { durationPoints } = require("../../../shared/economy/prizePool");
const { lockCompetitionRows } = require("./raceWriteFence");
const {
  appSettings: defaultAppSettings,
  ACTIVE_COMPETITION_LIMIT_DEFAULT,
} = require("../../../shared/config/appSettings");

// Keep the abuse guard, but allow twice the previously approved concurrent
// funded-race exposure. These values are stamped into conflict metadata only;
// existing memberships retain their original exposure reservations.
const FUNDED_EXPOSURE_LIMIT_MILLICOINS = 600_000;
const FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY = 80_000;
const PRIZE_CALCULATION_VERSION_V2 = 2;
const PRIZE_COIN_UNIT_V1 = 20;
const PRIZE_COIN_UNIT_V2 = 10;
const RACE_POOL_MAX_V1 = 16_000;
const RACE_POOL_MAX_V2 = 8_000;
const TOURNAMENT_CHAMPION_MAX_V1 = 1_000;
const TOURNAMENT_CHAMPION_MAX_V2 = 500;
const MAX_FUNDED_COMPETITION_MEMBERSHIPS = 5;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizedDurationDays(value) {
  return Math.max(1, positiveInteger(value, 1));
}

function legacyPrizeCoinUnit() {
  const parsed = Number(process.env.PRIZE_COIN_UNIT);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : PRIZE_COIN_UNIT_V1;
}

function legacyRacePoolMax() {
  const parsed = Number(process.env.PRIZE_POOL_MAX_COINS);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : RACE_POOL_MAX_V1;
}

function resolveRacePrizeStamp(race = {}) {
  const v2 = Number(race.prizeCalculationVersion) >= 2;
  return {
    prizeCalculationVersion: v2 ? PRIZE_CALCULATION_VERSION_V2 : 1,
    prizeCoinUnit: positiveInteger(
      race.prizeCoinUnit,
      v2 ? PRIZE_COIN_UNIT_V2 : legacyPrizeCoinUnit(),
    ),
    prizePoolMaxCoins: positiveInteger(
      race.prizePoolMaxCoins,
      v2 ? RACE_POOL_MAX_V2 : legacyRacePoolMax(),
    ),
  };
}

function resolveTournamentPrizeStamp(tournament = {}) {
  const v2 = Number(tournament.prizeCalculationVersion) >= 2;
  return {
    prizeCalculationVersion: v2 ? PRIZE_CALCULATION_VERSION_V2 : 1,
    prizeCoinUnit: positiveInteger(
      tournament.prizeCoinUnit,
      v2 ? PRIZE_COIN_UNIT_V2 : legacyPrizeCoinUnit(),
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
    "Finish or leave another funded competition before joining this one.",
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

function fundedMembershipConflict() {
  return new ConflictError(
    "Finish or leave another funded competition before joining this one.",
    "FUNDED_EXPOSURE_LIMIT",
  );
}

function activeCompetitionLimitConflict({ limit, current }) {
  return new ConflictError(
    `You can have up to ${limit} active competitions at a time.`,
    "ACTIVE_COMPETITION_LIMIT",
    { limit, current },
  );
}

async function loadUserCreatedFundedMembershipCounts(tx, userIds) {
  const ordered = [...new Set((userIds || []).filter(Boolean))].sort();
  const counts = new Map(ordered.map((userId) => [userId, 0]));
  if (ordered.length === 0) return counts;
  const raceRows = await tx.raceParticipant.findMany({
    where: {
      userId: { in: ordered },
      status: "ACCEPTED",
      finishedAt: null,
      forfeitedAt: null,
      race: {
        fundedPrize: true,
        creatorId: { not: null },
        seedId: null,
        tournamentId: null,
        status: { in: ["PENDING", "ACTIVE"] },
      },
    },
    select: { userId: true, raceId: true },
  });
  const tournamentRows = await tx.tournamentParticipant.findMany({
      where: {
        userId: { in: ordered },
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          fundedPrize: true,
          creatorId: { not: null },
          seedId: null,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
      select: { userId: true, tournamentId: true },
    });
  const keys = new Set([
    ...raceRows.map((row) => `${row.userId}\u0000race\u0000${row.raceId}`),
    ...tournamentRows.map(
      (row) => `${row.userId}\u0000tournament\u0000${row.tournamentId}`,
    ),
  ]);
  for (const key of keys) {
    const userId = key.split("\u0000", 1)[0];
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }
  return counts;
}

async function loadUserCreatedActiveMembershipCounts(tx, userIds) {
  const ordered = [...new Set((userIds || []).filter(Boolean))].sort();
  const counts = new Map(ordered.map((userId) => [userId, 0]));
  if (ordered.length === 0) return counts;
  const [raceRows, tournamentRows] = await Promise.all([
    tx.raceParticipant.findMany({
      where: {
        userId: { in: ordered },
        status: "ACCEPTED",
        finishedAt: null,
        forfeitedAt: null,
        race: {
          creatorId: { not: null },
          seedId: null,
          tournamentId: null,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
      select: { userId: true, raceId: true },
    }),
    tx.tournamentParticipant.findMany({
      where: {
        userId: { in: ordered },
        status: "ACCEPTED",
        eliminatedInRound: null,
        tournament: {
          creatorId: { not: null },
          seedId: null,
          status: { in: ["PENDING", "ACTIVE"] },
        },
      },
      select: { userId: true, tournamentId: true },
    }),
  ]);
  const keys = new Set([
    ...raceRows.map((row) => `${row.userId}\u0000race\u0000${row.raceId}`),
    ...tournamentRows.map(
      (row) => `${row.userId}\u0000tournament\u0000${row.tournamentId}`,
    ),
  ]);
  for (const key of keys) {
    const userId = key.split("\u0000", 1)[0];
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }
  return counts;
}

async function reserveActiveCompetitionMemberships({
  tx,
  reservations,
  limit = null,
  appSettings = defaultAppSettings,
}) {
  if (!tx || !Array.isArray(reservations)) {
    throw new TypeError("tx and reservations are required");
  }
  const requestedByUser = new Map();
  for (const entry of reservations) {
    if (!entry?.userId) continue;
    const requested = Number.isInteger(entry.count) && entry.count > 0
      ? entry.count
      : 1;
    requestedByUser.set(
      entry.userId,
      (requestedByUser.get(entry.userId) || 0) + requested,
    );
  }
  const userIds = [...requestedByUser.keys()].sort();
  if (userIds.length === 0) return;
  await lockFundedExposureUsers(tx, userIds);
  const configured = limit ?? await appSettings.getActiveCompetitionLimit();
  const resolvedLimit = Number.isInteger(configured) && configured > 0
    ? configured
    : ACTIVE_COMPETITION_LIMIT_DEFAULT;
  const currentByUser = await loadUserCreatedActiveMembershipCounts(tx, userIds);
  for (const userId of userIds) {
    const current = currentByUser.get(userId) || 0;
    if (current + requestedByUser.get(userId) > resolvedLimit) {
      console.warn(JSON.stringify({
        event: "active_competition_limit_v1",
        userId,
        current,
        requested: requestedByUser.get(userId),
        limit: resolvedLimit,
      }));
      throw activeCompetitionLimitConflict({ limit: resolvedLimit, current });
    }
  }
}

async function reserveActiveCompetitionMembership({
  tx,
  userId,
  count = 1,
  limit = null,
  appSettings = defaultAppSettings,
}) {
  return reserveActiveCompetitionMemberships({
    tx,
    reservations: [{ userId, count }],
    limit,
    appSettings,
  });
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
  if (ordered.length === 0) return ordered;

  // Production Prisma exposes createMany. Ensure missing guard rows in one
  // ordered insert, then acquire the whole cohort in one ORDER BY ... FOR
  // UPDATE statement. The former per-user upsert + select cost two network
  // round trips per participant (and seeded finalization calls this for fields
  // measured in hundreds), which exhausted Prisma's 5s interactive transaction
  // budget on staging. The ordered array and ordered row lock preserve the
  // universal deadlock-avoidance contract. Narrow unit doubles without
  // createMany retain the legacy loop below.
  if (typeof tx.fundedExposureGuard?.createMany === "function") {
    try {
      await tx.fundedExposureGuard.createMany({
        data: ordered.map((userId) => ({ userId })),
        skipDuplicates: true,
      });
    } catch (error) {
      if (error?.code === "P2003") throw fundedExposureDriftConflict();
      throw error;
    }
    const locked = await tx.$queryRawUnsafe(
      `SELECT user_id
       FROM funded_exposure_guards
       WHERE user_id = ANY($1::text[])
       ORDER BY user_id
       FOR UPDATE`,
      ordered,
    );
    if (locked.length !== ordered.length) throw fundedExposureDriftConflict();
    return ordered;
  }
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
        race: {
          fundedPrize: true,
          status: { in: ["PENDING", "ACTIVE"] },
          OR: [
            { seedId: null },
            { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
          ],
        },
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
        race: {
          fundedPrize: true,
          status: { in: ["PENDING", "ACTIVE"] },
          OR: [
            { seedId: null },
            { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
          ],
        },
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
      race: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { seedId: null },
          { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
        ],
      },
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

async function loadAndHealCurrentExposureCohort(
  tx,
  userIds,
  { targetRaceIds = [], targetTournamentIds = [] } = {},
) {
  const orderedUsers = [...new Set(userIds.filter(Boolean))].sort();
  const totals = new Map(
    orderedUsers.map((userId) => [
      userId,
      { exposureMillicoins: 0, exposureRateMillicoinsPerDay: 0 },
    ]),
  );
  if (orderedUsers.length === 0) return totals;

  // One discovery pair for the whole guarded cohort. This is the same
  // old-writer/null-heal protocol as loadAndHealCurrentExposure, but avoids
  // repeating six membership reads and competition locks for every seeded
  // participant in a production-sized field.
  const discoveredRaceRows = await tx.raceParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
      status: "ACCEPTED",
      finishedAt: null,
      forfeitedAt: null,
      race: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { seedId: null },
          { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
        ],
      },
    },
    select: { userId: true, raceId: true },
  });
  const discoveredTournamentRows = await tx.tournamentParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
      status: "ACCEPTED",
      eliminatedInRound: null,
      tournament: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        seedId: null,
      },
    },
    select: { userId: true, tournamentId: true },
  });
  const raceIds = [...new Set([
    ...targetRaceIds,
    ...discoveredRaceRows.map((row) => row.raceId),
  ].filter(Boolean))].sort();
  const tournamentIds = [...new Set([
    ...targetTournamentIds,
    ...discoveredTournamentRows.map((row) => row.tournamentId),
  ].filter(Boolean))].sort();

  // `race:` sorts before `tournament:` in the universal competition key, so
  // these two ordered statements preserve the exact global lock order while
  // reducing hundreds of target-row round trips to at most two.
  if (raceIds.length > 0) {
    const locked = await tx.$queryRawUnsafe(
      "SELECT id FROM races WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE",
      raceIds,
    );
    if (locked.length !== raceIds.length) throw fundedExposureDriftConflict();
  }
  if (tournamentIds.length > 0) {
    const locked = await tx.$queryRawUnsafe(
      "SELECT id FROM tournaments WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE",
      tournamentIds,
    );
    if (locked.length !== tournamentIds.length) {
      throw fundedExposureDriftConflict();
    }
  }

  const raceRows = await tx.raceParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
      status: "ACCEPTED",
      finishedAt: null,
      forfeitedAt: null,
      race: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { seedId: null },
          { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
        ],
      },
    },
    select: {
      id: true,
      userId: true,
      raceId: true,
      fundedExposureMillicoins: true,
      fundedExposureRateMillicoinsPerDay: true,
    },
  });
  const tournamentRows = await tx.tournamentParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
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
      userId: true,
      tournamentId: true,
      fundedExposureMillicoins: true,
      fundedExposureRateMillicoinsPerDay: true,
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

  const membershipRaceIds = [...new Set(raceRows.map((row) => row.raceId))];
  const membershipTournamentIds = [
    ...new Set(tournamentRows.map((row) => row.tournamentId)),
  ];
  const races = membershipRaceIds.length === 0
    ? []
    : await tx.race.findMany({
        where: { id: { in: membershipRaceIds } },
        select: {
          id: true,
          maxDurationDays: true,
          teamPoolMultBps: true,
          prizeCoinUnit: true,
          prizePoolMaxCoins: true,
          prizeCalculationVersion: true,
        },
      });
  const tournaments = membershipTournamentIds.length === 0
    ? []
    : await tx.tournament.findMany({
        where: { id: { in: membershipTournamentIds } },
        select: {
          id: true,
          bracketSize: true,
          totalRounds: true,
          matchupDurationDays: true,
          prizeCoinUnit: true,
          tournamentChampionMaxCoins: true,
          prizeCalculationVersion: true,
        },
      });
  const racesById = new Map(races.map((race) => [race.id, race]));
  const tournamentsById = new Map(
    tournaments.map((tournament) => [tournament.id, tournament]),
  );
  if (
    membershipRaceIds.some((id) => !racesById.has(id)) ||
    membershipTournamentIds.some((id) => !tournamentsById.has(id))
  ) {
    throw fundedExposureDriftConflict();
  }

  const raceHealGroups = new Map();
  const tournamentHealGroups = new Map();
  function addHeal(groups, stamp, id) {
    const key = `${stamp.exposureMillicoins}:${stamp.exposureRateMillicoinsPerDay}`;
    if (!groups.has(key)) groups.set(key, { stamp, ids: [] });
    groups.get(key).ids.push(id);
  }
  function addTotal(userId, stamp) {
    const total = totals.get(userId);
    if (!total) throw fundedExposureDriftConflict();
    total.exposureMillicoins += stamp.exposureMillicoins;
    total.exposureRateMillicoinsPerDay +=
      stamp.exposureRateMillicoinsPerDay;
  }

  for (const row of raceRows) {
    const needsHeal =
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null;
    const stamp = needsHeal
      ? raceStampForRow({ ...row, race: racesById.get(row.raceId) })
      : {
          exposureMillicoins: row.fundedExposureMillicoins,
          exposureRateMillicoinsPerDay:
            row.fundedExposureRateMillicoinsPerDay,
        };
    if (needsHeal) addHeal(raceHealGroups, stamp, row.id);
    addTotal(row.userId, stamp);
  }
  for (const row of tournamentRows) {
    const needsHeal =
      row.fundedExposureMillicoins == null ||
      row.fundedExposureRateMillicoinsPerDay == null;
    const stamp = needsHeal
      ? tournamentStampForRow({
          ...row,
          tournament: tournamentsById.get(row.tournamentId),
        })
      : {
          exposureMillicoins: row.fundedExposureMillicoins,
          exposureRateMillicoinsPerDay:
            row.fundedExposureRateMillicoinsPerDay,
        };
    if (needsHeal) addHeal(tournamentHealGroups, stamp, row.id);
    addTotal(row.userId, stamp);
  }
  for (const { stamp, ids } of raceHealGroups.values()) {
    const healed = await tx.raceParticipant.updateMany({
      where: { id: { in: ids } },
      data: {
        fundedExposureMillicoins: stamp.exposureMillicoins,
        fundedExposureRateMillicoinsPerDay:
          stamp.exposureRateMillicoinsPerDay,
      },
    });
    if (healed.count !== ids.length) throw fundedExposureDriftConflict();
  }
  for (const { stamp, ids } of tournamentHealGroups.values()) {
    const healed = await tx.tournamentParticipant.updateMany({
      where: { id: { in: ids } },
      data: {
        fundedExposureMillicoins: stamp.exposureMillicoins,
        fundedExposureRateMillicoinsPerDay:
          stamp.exposureRateMillicoinsPerDay,
      },
    });
    if (healed.count !== ids.length) throw fundedExposureDriftConflict();
  }

  const finalRaceRows = await tx.raceParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
      status: "ACCEPTED",
      finishedAt: null,
      forfeitedAt: null,
      race: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        OR: [
          { seedId: null },
          { seed: { kind: { notIn: ["DAILY_10K", "WEEKLY_50K"] } } },
        ],
      },
    },
    select: { userId: true, raceId: true },
  });
  const finalTournamentRows = await tx.tournamentParticipant.findMany({
    where: {
      userId: { in: orderedUsers },
      status: "ACCEPTED",
      eliminatedInRound: null,
      tournament: {
        fundedPrize: true,
        status: { in: ["PENDING", "ACTIVE"] },
        seedId: null,
      },
    },
    select: { userId: true, tournamentId: true },
  });
  const initialMembershipKeys = [
    ...raceRows.map((row) => `${row.userId}\u0000race\u0000${row.raceId}`),
    ...tournamentRows.map(
      (row) => `${row.userId}\u0000tournament\u0000${row.tournamentId}`,
    ),
  ].sort();
  const finalMembershipKeys = [
    ...finalRaceRows.map(
      (row) => `${row.userId}\u0000race\u0000${row.raceId}`,
    ),
    ...finalTournamentRows.map(
      (row) => `${row.userId}\u0000tournament\u0000${row.tournamentId}`,
    ),
  ].sort();
  if (
    initialMembershipKeys.length !== finalMembershipKeys.length ||
    initialMembershipKeys.some(
      (key, index) => key !== finalMembershipKeys[index],
    )
  ) {
    throw fundedExposureDriftConflict();
  }
  return totals;
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
  enforceLimits = true,
  enforceMembershipLimit = false,
}) {
  if (!tx || !userId || !stamp) {
    throw new TypeError("tx, userId, and stamp are required");
  }
  await reserveFundedExposures({
    tx,
    reservations: [
      {
        userId,
        stamp,
        competition,
        enforceMembershipLimit,
      },
    ],
    enforceLimits,
  });
  return stamp;
}

async function reserveFundedExposures({
  tx,
  reservations,
  enforceLimits = true,
}) {
  if (!tx || !Array.isArray(reservations)) {
    throw new TypeError("tx and reservations are required");
  }
  const ordered = [...reservations]
    .filter((entry) => entry?.userId && entry?.stamp)
    .sort((a, b) => a.userId.localeCompare(b.userId));
  await lockFundedExposureUsers(tx, ordered.map(({ userId }) => userId));
  const currentByUser = await loadAndHealCurrentExposureCohort(
    tx,
    ordered.map(({ userId }) => userId),
    {
      targetRaceIds: ordered.map((entry) => entry.competition?.raceId),
      targetTournamentIds: ordered.map(
        (entry) => entry.competition?.tournamentId,
      ),
    },
  );
  const requestedByUser = new Map();
  for (const { userId, stamp } of ordered) {
    const requested = requestedByUser.get(userId) || {
      exposureMillicoins: 0,
      exposureRateMillicoinsPerDay: 0,
    };
    requested.exposureMillicoins += stamp.exposureMillicoins;
    requested.exposureRateMillicoinsPerDay +=
      stamp.exposureRateMillicoinsPerDay;
    requestedByUser.set(userId, requested);
  }
  const membershipReservations = ordered.filter(
    (entry) => entry.enforceMembershipLimit === true,
  );
  if (membershipReservations.length > 0) {
    const membershipCounts = await loadUserCreatedFundedMembershipCounts(
      tx,
      membershipReservations.map((entry) => entry.userId),
    );
    const requestedMemberships = new Map();
    for (const entry of membershipReservations) {
      requestedMemberships.set(
        entry.userId,
        (requestedMemberships.get(entry.userId) || 0) + 1,
      );
    }
    for (const [userId, requestedCount] of requestedMemberships) {
      if (
        (membershipCounts.get(userId) || 0) + requestedCount >
        MAX_FUNDED_COMPETITION_MEMBERSHIPS
      ) {
        console.warn(JSON.stringify({
          event: "funded_exposure_limit_v1",
          currentMemberships: membershipCounts.get(userId) || 0,
          requestedMemberships: requestedCount,
          limit: MAX_FUNDED_COMPETITION_MEMBERSHIPS,
        }));
        throw fundedMembershipConflict();
      }
    }
  }
  for (const [userId, requested] of requestedByUser) {
    const current = currentByUser.get(userId);
    if (enforceLimits) {
      const exceedsRaw =
        current.exposureMillicoins + requested.exposureMillicoins >
        FUNDED_EXPOSURE_LIMIT_MILLICOINS;
      const exceedsRate =
        current.exposureRateMillicoinsPerDay +
          requested.exposureRateMillicoinsPerDay >
        FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY;
      if (exceedsRaw || exceedsRate) {
        throw fundedExposureConflict({
          currentExposureMillicoins: current.exposureMillicoins,
          requestedExposureMillicoins: requested.exposureMillicoins,
          currentRateMillicoinsPerDay: current.exposureRateMillicoinsPerDay,
          requestedRateMillicoinsPerDay:
            requested.exposureRateMillicoinsPerDay,
        });
      }
    }
  }
  return ordered.map(({ stamp }) => stamp);
}

module.exports = {
  FUNDED_EXPOSURE_LIMIT_MILLICOINS,
  FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY,
  MAX_FUNDED_COMPETITION_MEMBERSHIPS,
  PRIZE_CALCULATION_VERSION_V2,
  PRIZE_COIN_UNIT_V2,
  RACE_POOL_MAX_V2,
  TOURNAMENT_CHAMPION_MAX_V2,
  auditLiveFundedExposure,
  activeCompetitionLimitConflict,
  backfillLiveFundedExposure,
  computeRaceExposureStamp,
  computeTournamentExposureStamp,
  fundedExposureConflict,
  fundedMembershipConflict,
  loadUserCreatedActiveMembershipCounts,
  loadUserCreatedFundedMembershipCounts,
  resolveRacePrizeStamp,
  resolveTournamentPrizeStamp,
  loadAndHealCurrentExposure,
  loadAndHealCurrentExposureCohort,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  newTournamentPrizeStamp,
  reserveFundedExposure,
  reserveFundedExposures,
  reserveActiveCompetitionMembership,
  reserveActiveCompetitionMemberships,
  resolveRacePrizeStamp,
  resolveTournamentPrizeStamp,
};
