const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createRaceLaunchAuxiliaryBatch,
} = require("../../src/modules/races/services/raceLaunchAuxiliaryBatch");

test("review opportunities collapse concurrent race-list viewers", async () => {
  let calls = 0;
  const prisma = { appReviewPromptAttempt: { async findMany() {
    calls += 1;
    return [
      { userId: "u1", opportunityId: "o1", raceId: "r1", expiresAt: new Date("2026-09-02") },
      { userId: "u2", opportunityId: "o2", raceId: "r2", expiresAt: new Date("2026-09-02") },
    ];
  } } };
  const batch = createRaceLaunchAuxiliaryBatch();
  const [one, two] = await Promise.all([
    batch.loadReviewOpportunities({ prisma, userId: "u1", raceIds: ["r1"] }),
    batch.loadReviewOpportunities({ prisma, userId: "u2", raceIds: ["r2"] }),
  ]);
  assert.deepEqual(one.map((row) => row.opportunityId), ["o1"]);
  assert.deepEqual(two.map((row) => row.opportunityId), ["o2"]);
  assert.equal(calls, 1);
});
