const assert = require("node:assert/strict");
const test = require("node:test");

const {
  FUNDED_EXPOSURE_LIMIT_MILLICOINS,
  FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY,
  computeRaceExposureStamp,
  computeTournamentExposureStamp,
  fundedExposureConflict,
  loadAndHealCurrentExposure,
  loadAndHealCurrentExposureCohort,
  lockFundedExposureUsers,
  newRacePrizeStamp,
  newTournamentPrizeStamp,
  reserveFundedExposures,
} = require("../../src/modules/races/services/fundedExposure");

test("new funded competitions permanently use immutable v2 prize stamps", () => {
  assert.deepEqual(newRacePrizeStamp(), {
    prizeCalculationVersion: 2,
    prizeCoinUnit: 10,
    prizePoolMaxCoins: 8_000,
  });
  assert.deepEqual(newTournamentPrizeStamp(), {
    prizeCalculationVersion: 2,
    prizeCoinUnit: 10,
    tournamentChampionMaxCoins: 500,
  });
});

test("race exposure uses unit 10, duration points, and the stamped team multiplier", () => {
  assert.deepEqual(
    computeRaceExposureStamp({
      maxDurationDays: 7,
      prizeCoinUnit: 10,
      teamPoolMultBps: 18750,
    }),
    {
      exposureMillicoins: 75000,
      exposureRateMillicoinsPerDay: 10715,
    },
  );
});

test("race exposure rounds independent raw and rate reservations upward to a millicoin", () => {
  assert.deepEqual(
    computeRaceExposureStamp({
      maxDurationDays: 3,
      prizeCoinUnit: 10,
      teamPoolMultBps: 12345,
    }),
    {
      exposureMillicoins: 24690,
      exposureRateMillicoinsPerDay: 8230,
    },
  );
});

test("tournament exposure preserves fractional EV in millicoins", () => {
  assert.deepEqual(
    computeTournamentExposureStamp({
      bracketSize: 8,
      totalRounds: 3,
      matchupDurationDays: 3,
      prizeCoinUnit: 10,
      tournamentChampionMaxCoins: 500,
    }),
    {
      exposureMillicoins: 62500,
      exposureRateMillicoinsPerDay: 6945,
    },
  );
});

test("conflict metadata uses independent 300 raw and 40/day ceilings", () => {
  assert.equal(FUNDED_EXPOSURE_LIMIT_MILLICOINS, 300000);
  assert.equal(FUNDED_EXPOSURE_RATE_LIMIT_MILLICOINS_PER_DAY, 40000);
  const error = fundedExposureConflict({
    currentExposureMillicoins: 280000,
    requestedExposureMillicoins: 40000,
    currentRateMillicoinsPerDay: 34000,
    requestedRateMillicoinsPerDay: 7000,
  });
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "FUNDED_EXPOSURE_LIMIT");
  assert.deepEqual(error.meta, {
    limitCoins: 300,
    dailyRateLimitCoins: 40,
    currentCoins: 280,
    requestedCoins: 40,
    currentDailyRateCoins: 34,
    requestedDailyRateCoins: 7,
  });
});

function healingTx({ rereadRaceIds = ["race-a"] } = {}) {
  let raceReads = 0;
  const lockedRaceIdSets = [];
  const raceRow = (raceId) => ({
    id: `participant-${raceId}`,
    raceId,
    fundedExposureMillicoins: 10_000,
    fundedExposureRateMillicoinsPerDay: 10_000,
    race: {
      maxDurationDays: 1,
      teamPoolMultBps: null,
      prizeCoinUnit: 10,
      prizePoolMaxCoins: 8_000,
      prizeCalculationVersion: 2,
    },
  });
  return {
    lockedRaceIdSets,
    raceParticipant: {
      async findMany() {
        raceReads += 1;
        return raceReads === 1
          ? [{ raceId: "race-a" }]
          : rereadRaceIds.map(raceRow);
      },
      async update() {},
    },
    tournamentParticipant: {
      async findMany() { return []; },
      async update() {},
    },
    async $queryRawUnsafe(_sql, ids) {
      lockedRaceIdSets.push([...ids]);
      return ids.map((id) => ({ id }));
    },
  };
}

test("mixed-null healing locks the reservation target together with discovered races", async () => {
  const tx = healingTx();
  await loadAndHealCurrentExposure(tx, "user-1", {
    targetRaceIds: ["race-target"],
  });
  assert.deepEqual(tx.lockedRaceIdSets[0], ["race-a", "race-target"]);
});

test("mixed-null healing fails closed when the reread contains an unlocked old-writer membership", async () => {
  const tx = healingTx({ rereadRaceIds: ["race-a", "race-drift"] });
  await assert.rejects(
    loadAndHealCurrentExposure(tx, "user-1", {
      targetRaceIds: ["race-target"],
    }),
    (error) => error?.code === "FUNDED_EXPOSURE_RETRY",
  );
});

test("obsolete caller input cannot bypass enforcement or target competition locks", async () => {
  const calls = [];
  const tx = {
    fundedExposureGuard: {
      async upsert({ where }) { calls.push(`guard:${where.userId}`); },
    },
    raceParticipant: {
      async findMany() { return []; },
      async updateMany() { return { count: 0 }; },
    },
    tournamentParticipant: {
      async findMany() { return []; },
      async updateMany() { return { count: 0 }; },
    },
    async $queryRaw() { calls.push("guard-row"); return []; },
    async $queryRawUnsafe(sql, ids) {
      const type = sql.includes("tournaments") ? "tournament" : "race";
      for (const id of ids) calls.push(`${type}:${id}`);
      return ids.map((id) => ({ id }));
    },
  };

  await reserveFundedExposures({
    tx,
    enforce: false,
    reservations: [
      { userId: "user-b", stamp: { exposureMillicoins: 1 }, competition: { raceId: "race-b" } },
      { userId: "user-a", stamp: { exposureMillicoins: 1 }, competition: { tournamentId: "tournament-a" } },
      { userId: "user-a", stamp: { exposureMillicoins: 1 }, competition: { raceId: "race-a" } },
    ],
  });

  assert.deepEqual(calls.slice(0, 4), [
    "guard:user-a",
    "guard-row",
    "guard:user-b",
    "guard-row",
  ]);
  assert.deepEqual(calls.slice(4), [
    "race:race-a",
    "race:race-b",
    "tournament:tournament-a",
  ]);
});

test("production Prisma locks a sorted user cohort with one guard insert and one row lock", async () => {
  const calls = [];
  const tx = {
    fundedExposureGuard: {
      async createMany({ data, skipDuplicates }) {
        calls.push({ type: "insert", ids: data.map((row) => row.userId), skipDuplicates });
      },
    },
    async $queryRawUnsafe(sql, ids) {
      calls.push({ type: "lock", sql, ids: [...ids] });
      return ids.map((userId) => ({ user_id: userId }));
    },
  };

  await lockFundedExposureUsers(tx, ["user-c", "user-a", "user-b", "user-a"]);

  assert.deepEqual(calls.map((call) => call.type), ["insert", "lock"]);
  assert.deepEqual(calls[0].ids, ["user-a", "user-b", "user-c"]);
  assert.equal(calls[0].skipDuplicates, true);
  assert.deepEqual(calls[1].ids, ["user-a", "user-b", "user-c"]);
  assert.match(calls[1].sql, /ORDER BY user_id\s+FOR UPDATE/);
});

test("bulk user guarding fails closed when account deletion removes a requested guard", async () => {
  const tx = {
    fundedExposureGuard: { async createMany() {} },
    async $queryRawUnsafe() {
      return [{ user_id: "user-a" }];
    },
  };

  await assert.rejects(
    lockFundedExposureUsers(tx, ["user-a", "user-deleted"]),
    (error) => error?.code === "FUNDED_EXPOSURE_RETRY",
  );
});

test("enforced exposure validates a 450-user cohort with bounded bulk reads and locks", async () => {
  let guardInserts = 0;
  let membershipReads = 0;
  let competitionLocks = 0;
  const tx = {
    fundedExposureGuard: {
      async createMany() { guardInserts += 1; },
    },
    raceParticipant: {
      async findMany() { membershipReads += 1; return []; },
      async updateMany() {},
    },
    tournamentParticipant: {
      async findMany() { membershipReads += 1; return []; },
      async updateMany() {},
    },
    race: { async findMany() { return []; } },
    tournament: { async findMany() { return []; } },
    async $queryRawUnsafe(sql, ids) {
      if (/funded_exposure_guards/.test(sql)) {
        return ids.map((user_id) => ({ user_id }));
      }
      if (/FROM races|FROM tournaments/.test(sql)) competitionLocks += 1;
      return ids.map((id) => ({ id }));
    },
  };
  const reservations = Array.from({ length: 450 }, (_, index) => ({
    userId: `user-${String(index).padStart(3, "0")}`,
    stamp: {
      exposureMillicoins: 10_000,
      exposureRateMillicoinsPerDay: 10_000,
    },
    competition: { raceId: `race-${String(index % 30).padStart(2, "0")}` },
  }));

  await reserveFundedExposures({ tx, reservations });

  assert.equal(guardInserts, 1);
  assert.ok(membershipReads <= 6, `used ${membershipReads} membership reads`);
  assert.ok(competitionLocks <= 2, `used ${competitionLocks} competition locks`);
});

test("cohort healing rejects per-user drift into a competition already locked for another user", async () => {
  let raceRead = 0;
  const initial = [
    {
      id: "participant-a-r1",
      userId: "user-a",
      raceId: "race-1",
      fundedExposureMillicoins: 10_000,
      fundedExposureRateMillicoinsPerDay: 10_000,
    },
    {
      id: "participant-b-r2",
      userId: "user-b",
      raceId: "race-2",
      fundedExposureMillicoins: 10_000,
      fundedExposureRateMillicoinsPerDay: 10_000,
    },
  ];
  const drifted = [
    ...initial,
    {
      id: "old-worker-a-r2",
      userId: "user-a",
      raceId: "race-2",
      fundedExposureMillicoins: 10_000,
      fundedExposureRateMillicoinsPerDay: 10_000,
    },
  ];
  const tx = {
    raceParticipant: {
      async findMany() {
        raceRead += 1;
        if (raceRead === 1) {
          return initial.map(({ userId, raceId }) => ({ userId, raceId }));
        }
        return raceRead === 2 ? initial : drifted.map(({ userId, raceId }) => ({ userId, raceId }));
      },
      async updateMany() { return { count: 0 }; },
    },
    tournamentParticipant: {
      async findMany() { return []; },
      async updateMany() { return { count: 0 }; },
    },
    race: {
      async findMany() {
        return ["race-1", "race-2"].map((id) => ({
          id,
          maxDurationDays: 1,
          teamPoolMultBps: null,
          prizeCoinUnit: 10,
          prizePoolMaxCoins: 8_000,
          prizeCalculationVersion: 2,
        }));
      },
    },
    tournament: { async findMany() { return []; } },
    async $queryRawUnsafe(_sql, ids) {
      return ids.map((id) => ({ id }));
    },
  };

  await assert.rejects(
    loadAndHealCurrentExposureCohort(tx, ["user-a", "user-b"]),
    (error) => error?.code === "FUNDED_EXPOSURE_RETRY",
  );
});

test("cohort null healing fails closed when a bulk heal misses any discovered row", async () => {
  let raceRead = 0;
  const nullRow = {
    id: "participant-a-r1",
    userId: "user-a",
    raceId: "race-1",
    fundedExposureMillicoins: null,
    fundedExposureRateMillicoinsPerDay: null,
  };
  const tx = {
    raceParticipant: {
      async findMany() {
        raceRead += 1;
        if (raceRead === 1) return [{ userId: "user-a", raceId: "race-1" }];
        return raceRead === 2 ? [nullRow] : [{ userId: "user-a", raceId: "race-1" }];
      },
      async updateMany() { return { count: 0 }; },
    },
    tournamentParticipant: {
      async findMany() { return []; },
      async updateMany() { return { count: 0 }; },
    },
    race: {
      async findMany() {
        return [{
          id: "race-1",
          maxDurationDays: 1,
          teamPoolMultBps: null,
          prizeCoinUnit: 10,
          prizePoolMaxCoins: 8_000,
          prizeCalculationVersion: 2,
        }];
      },
    },
    tournament: { async findMany() { return []; } },
    async $queryRawUnsafe(_sql, ids) {
      return ids.map((id) => ({ id }));
    },
  };

  await assert.rejects(
    loadAndHealCurrentExposureCohort(tx, ["user-a"]),
    (error) => error?.code === "FUNDED_EXPOSURE_RETRY",
  );
});
