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
      async findForStepSyncScope() {
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

// Dependency-closure spec rule 1 (merged-reason carve-out): watched races
// enqueue DISPLAY_REFRESH on a ~15s snapshot cadence, so a coalesced
// STEP_SYNC + DISPLAY_REFRESH envelope must stay eligible or most big-race step
// syncs are demoted to FULL. The display generation is served by the snapshot
// assembler, never by a second scoring pass, and artifactMatchesClaim still
// requires EXACTLY ["DISPLAY_REFRESH"] — so this widening cannot hand a merged
// envelope to the artifact path.
test("a coalesced STEP_SYNC + DISPLAY_REFRESH envelope stays eligible in either order", async () => {
  for (const reasons of [
    ["STEP_SYNC", "DISPLAY_REFRESH"],
    ["DISPLAY_REFRESH", "STEP_SYNC"],
  ]) {
    const scope = await buildRaceResolutionStepSyncScope(
      { ...job, processingDirtyReasons: reasons },
      dependencies()
    );
    assert.equal(scope.plan, "STEP_SYNC_COMMITTED", reasons.join("+"));
    assert.equal(scope.result.boxEffectiveStepsByUser.u1, 45);
  }
});

test("mixed reason, missing/stale token, membership mismatch, or active effect fails closed", async () => {
  assert.equal(await buildRaceResolutionStepSyncScope({
    ...job, processingDirtyReasons: ["STEP_SYNC", "BOX_OPEN"],
  }, dependencies()), null);
  // Every other mix stays rejected, including a superset of the admitted set.
  for (const reasons of [
    ["DISPLAY_REFRESH"],
    ["RECOVERY"],
    ["STEP_SYNC", "DISPLAY_REFRESH", "BOX_OPEN"],
    [],
  ]) {
    assert.equal(await buildRaceResolutionStepSyncScope({
      ...job, processingDirtyReasons: reasons,
    }, dependencies()), null, reasons.join("+"));
  }
  for (const participant of [
    { id: "p1", userId: "u1", status: "ACCEPTED", totalsUpdatedAt: null },
    { id: "p1", userId: "u1", status: "ACCEPTED", totalsUpdatedAt: new Date("2026-08-13T12:00:06.000Z") },
    { id: "p1", userId: "u1", status: "DECLINED", totalsUpdatedAt: new Date("2026-08-13T12:00:04.000Z") },
  ]) {
    const deps = dependencies({
      Race: { async findForStepSyncScope() { return { id: "r1", status: "ACTIVE", participants: [participant] }; } },
    });
    assert.equal(await buildRaceResolutionStepSyncScope(job, deps), null);
  }
  assert.equal(await buildRaceResolutionStepSyncScope(job, dependencies({
    RaceActiveEffect: { async findActiveForRace() { return [{ type: "LEECH" }]; } },
  })), null);
});

test("supported active effects use incremental scoring for only the dirty participant", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, dependencies({
    allowIncrementalEffects: true,
    RaceActiveEffect: {
      async findActiveForRace() { return [{ type: "RAINSTORM", targetParticipantId: "p1" }]; },
    },
  }));
  assert.equal(scope.plan, "STEP_SYNC_INCREMENTAL");
  assert.deepEqual(scope.scoreParticipantIds, ["p1"]);
});

test("team races use incremental scoring without expanding to every participant", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, dependencies({
    allowIncrementalEffects: true,
    Race: {
      async findForStepSyncScope() {
        return {
          id: "r1", status: "ACTIVE", isTeamRace: true,
          participants: [{
            id: "p1", userId: "u1", status: "ACCEPTED", rawSteps: 45,
            bonusSteps: 5, maxBonusSteps: 5,
            totalsUpdatedAt: new Date("2026-08-13T12:00:04.000Z"),
          }],
        };
      },
    },
  }));
  assert.equal(scope.plan, "STEP_SYNC_INCREMENTAL");
  assert.deepEqual(scope.scoreParticipantIds, ["p1"]);
});

test("unsupported active effects remain fail-closed", async () => {
  const scope = await buildRaceResolutionStepSyncScope(job, dependencies({
    RaceActiveEffect: {
      async findActiveForRace() { return [{ type: "LEECH", targetParticipantId: "p1" }]; },
    },
  }));
  assert.equal(scope, null);
});
