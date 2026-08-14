const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRaceProgressPostCommit,
} = require("../../src/modules/races/services/raceProgressSideEffects");

test("a superseded worker keeps the newer snapshot invalidation intact", async () => {
  let expiryRuns = 0;
  let snapshotBuilds = 0;
  const onCommitted = buildRaceProgressPostCommit({
    redisStandingsEnabled: true,
    async expireEffects() {
      expiryRuns += 1;
    },
    getRaceProgress: {
      async computePersistedSnapshot() {
        snapshotBuilds += 1;
        return { raceId: "race-1" };
      },
    },
    raceProgressSnapshot: {
      async writeSnapshot() {
        assert.fail("a superseded run must not republish stale totals");
      },
    },
  });

  await onCommitted({
    raceId: "race-1",
    superseded: true,
    result: {
      race: { id: "race-1", powerupsEnabled: false, participants: [] },
      baseAdjustedByParticipantId: {},
    },
  });

  assert.equal(expiryRuns, 1, "non-snapshot post-commit work still runs");
  assert.equal(snapshotBuilds, 0);
});

test("deferred mode finishes stateful decisions and returns only an allowlisted snapshot command", async () => {
  const calls = [];
  const onCommitted = buildRaceProgressPostCommit({
    redisStandingsEnabled: true,
    async expireEffects() { calls.push("expire"); },
    async evaluateHighMultiplierAlert() { calls.push("alert"); },
    RaceActiveEffect: { async findActiveForRace() { return []; } },
    GlobalStepEvent: { async findActiveInRange() { return []; } },
    getRaceProgress: {
      async computePersistedSnapshot() {
        calls.push("build-snapshot");
        return { raceId: "race-1" };
      },
    },
    raceProgressSnapshot: {
      async writeSnapshot() { calls.push("publish"); return true; },
    },
  });

  const outcome = await onCommitted({
    raceId: "race-1",
    job: { processingTimeZone: "America/New_York" },
    deferSnapshot: true,
    result: {
      race: {
        id: "race-1",
        powerupsEnabled: true,
        startedAt: new Date("2026-08-13T00:00:00.000Z"),
        participants: [],
      },
      baseAdjustedByParticipantId: {},
    },
  });

  assert.deepEqual(calls, ["expire"]);
  assert.deepEqual(outcome, {
    snapshotCommand: { raceId: "race-1", timeZone: "America/New_York" },
  });
  assert.deepEqual(
    Object.keys(outcome.snapshotCommand).sort(),
    ["raceId", "timeZone"]
  );
});
