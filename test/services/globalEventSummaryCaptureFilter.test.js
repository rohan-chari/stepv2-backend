const assert = require("node:assert/strict");
const test = require("node:test");
const {
  persistCapturedSummaryImpactsForRace,
} = require("../../src/modules/steps/services/globalEventSummaryCapture");

test("race post-processing hydrates artifacts only for actionable summary work", async () => {
  let artifactWhere;
  const tx = {
    globalEventCaptureArtifact: {
      async findMany(input) {
        artifactWhere = input.where;
        return [];
      },
    },
    globalEventRaceImpact: { async updateMany() { return { count: 0 }; } },
    async $queryRawUnsafe() { return []; },
    async $executeRawUnsafe() { return 0; },
  };

  await persistCapturedSummaryImpactsForRace(tx, {
    raceId: "race-1",
    sourceResolutionGeneration: 1,
  });

  assert.deepEqual(artifactWhere, {
    raceId: "race-1",
    work: {
      status: { in: ["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"] },
    },
  });
});
