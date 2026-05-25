const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetStepMilestonesToday,
} = require("../../src/queries/getStepMilestonesToday");

function makePrismaMock({ stepRecord = null, claims = [] } = {}) {
  return {
    step: {
      async findUnique() {
        return stepRecord;
      },
    },
    stepMilestoneClaim: {
      async findMany() {
        return claims;
      },
    },
  };
}

test("getStepMilestonesToday — returns all four milestones with locked state when no steps", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock({ stepRecord: null, claims: [] }),
  });
  const result = await query({ userId: "u1", localDate: "2026-05-25" });

  assert.equal(result.currentSteps, 0);
  assert.equal(result.totalCoinsClaimed, 0);
  assert.equal(result.milestones.length, 4);
  for (const m of result.milestones) {
    assert.equal(m.claimed, false);
    assert.equal(m.claimable, false);
  }
});

test("getStepMilestonesToday — marks claimable when steps reach a threshold", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock({
      stepRecord: { steps: 12000 },
      claims: [],
    }),
  });
  const result = await query({ userId: "u1", localDate: "2026-05-25" });

  assert.equal(result.currentSteps, 12000);
  const byThreshold = Object.fromEntries(
    result.milestones.map((m) => [m.threshold, m])
  );
  assert.equal(byThreshold[5000].claimable, true);
  assert.equal(byThreshold[10000].claimable, true);
  assert.equal(byThreshold[15000].claimable, false);
  assert.equal(byThreshold[20000].claimable, false);
});

test("getStepMilestonesToday — marks claimed and reports totalCoinsClaimed", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock({
      stepRecord: { steps: 12000 },
      claims: [{ threshold: 5000 }, { threshold: 10000 }],
    }),
  });
  const result = await query({ userId: "u1", localDate: "2026-05-25" });

  const byThreshold = Object.fromEntries(
    result.milestones.map((m) => [m.threshold, m])
  );
  assert.equal(byThreshold[5000].claimed, true);
  assert.equal(byThreshold[5000].claimable, false); // already claimed → not claimable
  assert.equal(byThreshold[10000].claimed, true);
  assert.equal(byThreshold[15000].claimed, false);
  assert.equal(byThreshold[20000].claimed, false);
  assert.equal(result.totalCoinsClaimed, 30); // 10 + 20
});

test("getStepMilestonesToday — daily cap reached when all four claimed", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock({
      stepRecord: { steps: 25000 },
      claims: [
        { threshold: 5000 },
        { threshold: 10000 },
        { threshold: 15000 },
        { threshold: 20000 },
      ],
    }),
  });
  const result = await query({ userId: "u1", localDate: "2026-05-25" });

  assert.equal(result.totalCoinsClaimed, 110);
  for (const m of result.milestones) {
    assert.equal(m.claimed, true);
    assert.equal(m.claimable, false);
  }
});

test("getStepMilestonesToday — rejects invalid localDate", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock(),
  });
  await assert.rejects(
    query({ userId: "u1", localDate: "not-a-date" }),
    (err) => err.statusCode === 400
  );
});

test("getStepMilestonesToday — echoes the requested localDate", async () => {
  const query = buildGetStepMilestonesToday({
    prisma: makePrismaMock({ stepRecord: { steps: 100 }, claims: [] }),
  });
  const result = await query({ userId: "u1", localDate: "2026-05-25" });
  assert.equal(result.localDate, "2026-05-25");
});
