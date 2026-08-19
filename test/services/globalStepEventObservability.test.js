const assert = require("node:assert/strict");
const test = require("node:test");

const {
  captureOperationalSnapshot,
} = require("../../src/modules/steps/services/globalStepEventObservability");

test("durable operational snapshot aggregates queue, invariants, and exposure", async () => {
  let persisted;
  const client = {
    async $queryRawUnsafe(sql) {
      assert.match(sql, /stale_pending_starts/);
      assert.match(sql, /exposure_multiple_races/);
      assert.match(sql, /WHERE r\.started_at IS NOT NULL/);
      assert.match(sql, /rp\.status = 'accepted'::"RaceParticipantStatus"/);
      assert.match(sql, /participant_exposure/);
      assert.match(sql, /duration_bucket/);
      assert.match(sql, /offset_separation_bucket/);
      return [{
        due_starts: 2n,
        due_ends: 3n,
        stale_pending_starts: 1n,
        invalid_local_parents: 0n,
        active_parents: 1n,
        active_entitlements: 19n,
        exposure_zero_races: 4n,
        exposure_one_races: 5n,
        exposure_multiple_races: 6n,
        exposure_buckets: { "lt_24h:wide": { zero: 4, one: 5, multiple: 6 } },
        entitlements_by_offset: { "utc_minus_12_to_6": 19 },
        rollout_counters: { startClaims: 10, scoringQueries: 4, scoringLatencyMs: 12 },
      }];
    },
    globalStepEventOperationalSnapshot: {
      async create({ data }) { persisted = data; return data; },
    },
  };
  const result = await captureOperationalSnapshot({
    client,
    now: new Date("2026-08-19T00:00:00Z"),
  });
  assert.equal(result.dueStarts, 2);
  assert.equal(result.exposureMultipleRaces, 6);
  assert.deepEqual(result.exposureBuckets, {
    "lt_24h:wide": { zero: 4, one: 5, multiple: 6 },
  });
  assert.equal(result.rolloutCounters.scoringQueries, 4);
  assert.equal(result.healthy, false);
  assert.equal(persisted.observedAt.toISOString(), "2026-08-19T00:00:00.000Z");
});
