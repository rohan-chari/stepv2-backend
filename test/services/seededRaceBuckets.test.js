const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSeededRaceBuckets,
  planBuckets,
} = require("../../src/modules/races/services/seededRaceBuckets");

function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `user-${String(index).padStart(2, "0")}`,
    matchSteps: index * 100,
  }));
}

test("bucket plan is permutation-independent, capped, and rebalances a trailing singleton", () => {
  const people = candidates(16);
  const forward = planBuckets(people, []).map((bucket) => bucket.map((row) => row.userId));
  const reverse = planBuckets([...people].reverse(), []).map((bucket) => bucket.map((row) => row.userId));
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward.map((bucket) => bucket.length), [8, 8]);
});

test("direct accepted friends co-locate only when their step totals fit the skill band", () => {
  const people = [
    { userId: "a", matchSteps: 1000 },
    { userId: "b", matchSteps: 2500 },
    { userId: "c", matchSteps: 10000 },
  ];
  const within = planBuckets(people, [{ userAId: "a", userBId: "b" }]);
  assert.ok(within.some((bucket) => bucket.some((row) => row.userId === "a") && bucket.some((row) => row.userId === "b")));
  const outside = planBuckets(people, [{ userAId: "a", userBId: "c" }]);
  assert.deepEqual(
    outside.map((bucket) => bucket.map((row) => row.userId)),
    planBuckets(people, []).map((bucket) => bucket.map((row) => row.userId)),
    "out-of-band friendship creates no placement constraint"
  );
});

test("staging-shaped funded finalization uses real C0 and exposure helpers within the 5s transaction budget", async () => {
  // Staging exposed P2028 after roughly five seconds with a 450-person field:
  // the old finalizer issued three writes per person, in addition to its lock
  // work. This deterministic fake gives the transaction the equivalent of 240
  // database round trips before expiring. A production-sized plan must stay
  // below that budget and must never fall back to per-person durable writes.
  const elected = candidates(450).map(({ userId }) => ({ userId }));
  const participants = [];
  const calls = new Map();
  let inTransaction = false;
  let transactionCalls = 0;
  let raceSequence = 0;
  let bucketSequence = 0;
  let participantSequence = 0;

  function record(name) {
    calls.set(name, (calls.get(name) || 0) + 1);
    if (inTransaction && ++transactionCalls > 240) {
      const error = new Error("Transaction already closed: timeout 5000ms");
      error.code = "P2028";
      throw error;
    }
  }

  const tx = {
    async $executeRaw() { record("$executeRaw"); },
    async $executeRawUnsafe() { record("$executeRawUnsafe"); return 0; },
    async $queryRawUnsafe(sql, ...params) {
      record("$queryRawUnsafe");
      const ids = Array.isArray(params[0]) ? params[0] : [];
      if (/funded_exposure_guards/.test(sql)) {
        return ids.map((user_id) => ({ user_id }));
      }
      if (/FROM races|FROM tournaments/.test(sql)) {
        return ids.map((id) => ({ id }));
      }
      return [];
    },
    fundedExposureGuard: {
      async createMany() { record("guard.createMany"); },
    },
    seededRaceWindowModeRecord: {
      async findUnique() { record("mode.findUnique"); return { mode: "BUCKET" }; },
    },
    seededRaceWindowMembership: {
      async findMany() { record("membership.findMany"); return elected; },
      async update() { record("membership.update"); },
      async updateMany() { record("membership.updateMany"); return { count: 15 }; },
    },
    seededRaceBucket: {
      async findMany() { record("bucket.findMany"); return []; },
      async create({ data }) {
        record("bucket.create");
        return { id: `bucket-${++bucketSequence}`, ...data };
      },
      async createMany({ data }) { record("bucket.createMany"); bucketSequence += data.length; return { count: data.length }; },
    },
    stepSample: { async findMany() { record("samples.findMany"); return []; } },
    step: { async findMany() { record("steps.findMany"); return []; } },
    friendship: { async findMany() { record("friendship.findMany"); return []; } },
    race: {
      async create({ data }) {
        record("race.create");
        return { id: `race-${++raceSequence}`, ...data };
      },
      async createMany({ data }) { record("race.createMany"); raceSequence += data.length; return { count: data.length }; },
      async findMany() { record("race.findMany"); return []; },
      async update() { record("race.update"); },
    },
    raceParticipant: {
      async create({ data }) {
        record("participant.create");
        const row = { id: `participant-${++participantSequence}`, ...data };
        participants.push(row);
        return row;
      },
      async createMany({ data }) {
        record("participant.createMany");
        for (const value of data) participants.push({ id: `participant-${++participantSequence}`, ...value });
        return { count: data.length };
      },
      async findMany({ where }) {
        record("participant.findMany");
        return participants.filter((row) => where.raceId?.in?.includes(row.raceId));
      },
      async updateMany() { record("participant.updateMany"); },
    },
    tournamentParticipant: {
      async findMany() { record("tournamentParticipant.findMany"); return []; },
      async updateMany() { record("tournamentParticipant.updateMany"); },
    },
    tournament: { async findMany() { record("tournament.findMany"); return []; } },
    seededRaceBucketAssignment: {
      async create() { record("assignment.create"); },
      async createMany({ data }) { record("assignment.createMany"); return { count: data.length }; },
    },
  };
  const prisma = {
    ...tx,
    async $transaction(callback) {
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    },
  };
  const matcher = buildSeededRaceBuckets({
    prisma,
    now: () => new Date("2026-08-20T03:58:00.000Z"),
    appSettings: {
      async getFlag(key) { return key === "fundedPrizePoolsEnabled"; },
    },
  });
  const seed = {
    id: "daily-seed",
    cadence: "DAILY",
    name: "Daily 10K",
    targetSteps: 10_000,
    powerupsEnabled: false,
    timeBased: false,
  };
  const windowStart = new Date("2026-08-20T04:00:00.000Z");
  const windowEnd = new Date("2026-08-21T04:00:00.000Z");

  const previousPrizeV2 = process.env.FUNDED_PRIZE_V2_ENABLED;
  const previousEnforcement = process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED;
  process.env.FUNDED_PRIZE_V2_ENABLED = "true";
  process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = "true";
  let buckets;
  try {
    buckets = await matcher.finalise({ seed, windowStart, windowEnd });
  } finally {
    if (previousPrizeV2 === undefined) delete process.env.FUNDED_PRIZE_V2_ENABLED;
    else process.env.FUNDED_PRIZE_V2_ENABLED = previousPrizeV2;
    if (previousEnforcement === undefined) {
      delete process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED;
    } else {
      process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = previousEnforcement;
    }
  }

  assert.equal(buckets.length, 30);
  assert.ok(transactionCalls <= 240, `used ${transactionCalls} transaction round trips`);
  assert.equal(calls.get("participant.create") || 0, 0);
  assert.equal(calls.get("assignment.create") || 0, 0);
  assert.equal(calls.get("membership.update") || 0, 0);
  assert.equal(calls.get("participant.createMany"), 1);
  assert.equal(calls.get("assignment.createMany"), 1);
  assert.equal(calls.get("guard.createMany"), 1);
  assert.ok((calls.get("$queryRawUnsafe") || 0) >= 62, "all 30 real C0 fences ran");
});
