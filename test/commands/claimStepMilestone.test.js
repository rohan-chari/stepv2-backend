const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClaimStepMilestone,
  StepMilestoneError,
} = require("../../src/modules/steps/commands/claimStepMilestone");

function todayLocalDate() {
  return new Date().toISOString().slice(0, 10);
}

function makePrismaMock({ stepRecord = null, existingClaim = null, createThrows = null } = {}) {
  const state = {
    createdClaims: [],
    findUniqueClaimCalls: [],
    findUniqueStepCalls: [],
  };
  const mock = {
    stepMilestoneClaim: {
      async findUnique(args) {
        state.findUniqueClaimCalls.push(args);
        return existingClaim;
      },
      async create(args) {
        if (createThrows) throw createThrows;
        state.createdClaims.push(args.data);
        return { id: "claim-1", ...args.data };
      },
    },
    step: {
      async findUnique(args) {
        state.findUniqueStepCalls.push(args);
        return stepRecord;
      },
    },
  };
  return { mock, state };
}

test("claimStepMilestone — happy path awards coins and writes claim row", async () => {
  const today = todayLocalDate();
  const { mock, state } = makePrismaMock({
    stepRecord: { id: "step-1", userId: "u1", steps: 12000 },
  });
  const coinCalls = [];
  const claim = buildClaimStepMilestone({
    prisma: mock,
    awardCoins: async (params) => {
      coinCalls.push(params);
      return { awarded: true, coins: 25 };
    },
  });

  const result = await claim({ userId: "u1", localDate: today, threshold: 10000 });

  assert.equal(result.threshold, 10000);
  assert.equal(result.coins, 20);
  assert.equal(result.currentSteps, 12000);
  assert.equal(result.coinsAfter, 25);
  assert.equal(state.createdClaims.length, 1);
  assert.deepEqual(state.createdClaims[0], {
    userId: "u1",
    claimedDate: today,
    threshold: 10000,
    coins: 20,
  });
  assert.equal(coinCalls.length, 1);
  assert.equal(coinCalls[0].reason, "step_milestone");
  assert.equal(coinCalls[0].refId, `${today}:10000`);
  assert.equal(coinCalls[0].amount, 20);
});

test("claimStepMilestone — rejects invalid localDate format", async () => {
  const claim = buildClaimStepMilestone({
    prisma: makePrismaMock().mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: "not-a-date", threshold: 5000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 400
  );
});

test("claimStepMilestone — rejects localDate far from server time", async () => {
  const claim = buildClaimStepMilestone({
    prisma: makePrismaMock().mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: "2000-01-01", threshold: 5000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 400
  );
});

test("claimStepMilestone — rejects unknown threshold", async () => {
  const today = todayLocalDate();
  const claim = buildClaimStepMilestone({
    prisma: makePrismaMock().mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: today, threshold: 7777 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 400
  );
});

test("claimStepMilestone — 409 when already claimed", async () => {
  const today = todayLocalDate();
  const { mock } = makePrismaMock({
    existingClaim: {
      id: "claim-existing",
      userId: "u1",
      claimedDate: today,
      threshold: 5000,
      coins: 10,
    },
  });
  const claim = buildClaimStepMilestone({
    prisma: mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: today, threshold: 5000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 409
  );
});

test("claimStepMilestone — 400 when threshold not reached", async () => {
  const today = todayLocalDate();
  const { mock } = makePrismaMock({
    stepRecord: { id: "step-1", userId: "u1", steps: 3000 },
  });
  const claim = buildClaimStepMilestone({
    prisma: mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: today, threshold: 5000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 400
  );
});

test("claimStepMilestone — 400 when no step record exists today", async () => {
  const today = todayLocalDate();
  const { mock } = makePrismaMock({ stepRecord: null });
  const claim = buildClaimStepMilestone({
    prisma: mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: today, threshold: 5000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 400
  );
});

test("claimStepMilestone — unique-constraint race translates to 409", async () => {
  const today = todayLocalDate();
  const raceErr = Object.assign(new Error("unique"), { code: "P2002" });
  const { mock } = makePrismaMock({
    stepRecord: { id: "step-1", userId: "u1", steps: 25000 },
    createThrows: raceErr,
  });
  const claim = buildClaimStepMilestone({
    prisma: mock,
    awardCoins: async () => ({ awarded: true, coins: 0 }),
  });

  await assert.rejects(
    claim({ userId: "u1", localDate: today, threshold: 20000 }),
    (err) => err instanceof StepMilestoneError && err.statusCode === 409
  );
});

test("claimStepMilestone — supports all four documented tiers", async () => {
  const today = todayLocalDate();
  const tiers = [
    { steps: 5000, coins: 10 },
    { steps: 10000, coins: 20 },
    { steps: 15000, coins: 30 },
    { steps: 20000, coins: 50 },
  ];

  for (const tier of tiers) {
    const { mock } = makePrismaMock({
      stepRecord: { id: "step-1", userId: "u1", steps: tier.steps + 100 },
    });
    const claim = buildClaimStepMilestone({
      prisma: mock,
      awardCoins: async () => ({ awarded: true, coins: 0 }),
    });
    const result = await claim({
      userId: "u1",
      localDate: today,
      threshold: tier.steps,
    });
    assert.equal(result.threshold, tier.steps);
    assert.equal(result.coins, tier.coins);
  }
});
