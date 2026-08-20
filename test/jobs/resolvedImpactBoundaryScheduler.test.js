const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildResolvedImpactBoundaryScheduler,
  shouldResolveUmbrellaImpacts,
} = require("../../src/modules/races/jobs/resolvedImpactBoundaryScheduler");

test("due Umbrella scheduler enqueues only indexed boundary races with an immediate domain envelope", async () => {
  const enqueues = [];
  const scheduler = buildResolvedImpactBoundaryScheduler({
    prisma: {
      async $queryRawUnsafe() {
        return [{ raceId: "race-b" }, { raceId: "race-a" }];
      },
    },
    RaceResolutionJobV2: {
      async enqueueMany(input) {
        enqueues.push(input);
        return [];
      },
    },
    now: () => new Date("2026-08-19T18:00:00.000Z"),
  });

  assert.equal(await scheduler.tick(), 2);
  assert.deepEqual(enqueues[0].raceIds, ["race-a", "race-b"]);
  assert.equal(enqueues[0].bypassDebounce, true);
  for (const raceId of enqueues[0].raceIds) {
    assert.deepEqual(enqueues[0].dirtyEnvelopeByRaceId.get(raceId), {
      reason: "EFFECT_BOUNDARY",
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: ["UMBRELLA"],
      priority: "IMMEDIATE",
    });
  }
});

test("boundary scheduler is always on and performs only its indexed due read", async () => {
  let reads = 0;
  const scheduler = buildResolvedImpactBoundaryScheduler({
    // A stale injected rollout setting cannot disable the production scheduler.
    appSettings: { async getFlag() { return false; } },
    prisma: { async $queryRawUnsafe() { reads += 1; return []; } },
    RaceResolutionJobV2: { async enqueueMany() { throw new Error("unexpected"); } },
  });
  assert.equal(await scheduler.tick(), 0);
  assert.equal(reads, 1);
});

test("ordinary resolution jobs never query Umbrella sources", () => {
  assert.equal(shouldResolveUmbrellaImpacts({
    processingDirtyReasons: ["STEP_SYNC"],
    processingDirtyPowerupTypes: [],
  }), false);
  assert.equal(shouldResolveUmbrellaImpacts({
    processingDirtyReasons: ["FULL"],
    processingDirtyPowerupTypes: [],
  }), false);
  assert.equal(shouldResolveUmbrellaImpacts({
    processingDirtyReasons: ["EFFECT_BOUNDARY"],
    processingDirtyPowerupTypes: ["UMBRELLA"],
  }), true);
});
