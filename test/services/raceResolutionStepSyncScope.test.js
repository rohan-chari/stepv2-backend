const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceResolutionStepSyncScope,
} = require("../../src/modules/races/services/raceResolutionStepSyncScope");

const startedAt = new Date("2026-08-13T12:00:05.000Z");
const job = {
  raceId: "r1",
  startedAt,
  processingDirtyReasons: ["STEP_SYNC"],
  processingDirtyParticipantIds: ["p1"],
  processingTriggeredByUserIds: ["u1"],
};

function dependencies(overrides = {}) {
  return {
    Race: {
      async findById() {
        return {
          id: "r1", status: "ACTIVE", powerupsEnabled: true,
          participants: [{
            id: "p1", userId: "u1", status: "ACCEPTED", totalSteps: 50,
            rawSteps: 45, bonusSteps: 5, maxBonusSteps: 5,
            totalsUpdatedAt: new Date("2026-08-13T12:00:04.000Z"),
          }],
        };
      },
    },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    ...overrides,
  };
}

test("pure STEP_SYNC reuses exact committed uploader rows without scoring", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, dependencies());
  assert.equal(scope.plan, "STEP_SYNC_COMMITTED");
  assert.deepEqual(scope.participantTokens, {
    p1: "2026-08-13T12:00:04.000Z",
  });
  // Box progress deliberately excludes additive bonus steps; it follows the
  // uploader's committed raw walked total.
  assert.equal(scope.result.boxEffectiveStepsByUser.u1, 45);
});

test("mixed reason, missing/stale token, membership mismatch, or active effect fails closed", async () => {
  assert.equal(await buildRaceResolutionStepSyncScope({
    ...job, processingDirtyReasons: ["STEP_SYNC", "BOX_OPEN"],
  }, dependencies()), null);
  for (const participant of [
    { id: "p1", userId: "u1", status: "ACCEPTED", totalsUpdatedAt: null },
    { id: "p1", userId: "u1", status: "ACCEPTED", totalsUpdatedAt: new Date("2026-08-13T12:00:06.000Z") },
    { id: "p1", userId: "u1", status: "DECLINED", totalsUpdatedAt: new Date("2026-08-13T12:00:04.000Z") },
  ]) {
    const deps = dependencies({
      Race: { async findById() { return { id: "r1", status: "ACTIVE", participants: [participant] }; } },
    });
    assert.equal(await buildRaceResolutionStepSyncScope(job, deps), null);
  }
  assert.equal(await buildRaceResolutionStepSyncScope(job, dependencies({
    RaceActiveEffect: { async findActiveForRace() { return [{ type: "LEECH" }]; } },
  })), null);
});
