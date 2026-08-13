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
