const assert = require("node:assert/strict");
const test = require("node:test");

const {
  lockScoringInputState,
  readCanonicalSampleInput,
  persistScoringInputState,
} = require("../../src/modules/steps/services/scoringInputVersion");

test("scoring-input state is materialized and locked in one database round trip", async () => {
  const calls = [];
  const client = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [{
        generation: 3n,
        sourceQueueSemanticsGeneration: 2n,
        scoringWatermark: "watermark",
        nextSampleBoundaryAt: null,
        dbNowMs: 1_700_000_000_000,
        inserted: false,
      }];
    },
  };

  const state = await lockScoringInputState(client, "user-1");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO user_scoring_input_versions/);
  assert.match(calls[0].sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.equal(state.generation, 3n);
  assert.equal(state.inserted, false);
  assert.equal(state.dbNow.toISOString(), "2023-11-14T22:13:20.000Z");
});

test("persisting scoring state can stamp queue ownership in the same update", async () => {
  const calls = [];
  const client = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 1;
    },
  };

  await persistScoringInputState(
    client,
    "user-1",
    { inserted: false },
    { scoringWatermark: "next", nextSampleBoundaryAt: null },
    true,
    { sourceQueueSemanticsGeneration: 4n },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /source_queue_semantics_generation/);
  assert.equal(calls[0].params.at(-1), "4");
});

test("canonical sample input reads rows and database time in one round trip", async () => {
  const calls = [];
  const client = {
    async $queryRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return [{ dbNowMs: 1_700_000_000_000, periodStartMs: null }];
    },
  };

  const canonical = await readCanonicalSampleInput(client, "user-1");

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /clock_timestamp/);
  assert.equal(canonical.canonicalCoverageThrough, null);
  assert.equal(canonical.dbNow.toISOString(), "2023-11-14T22:13:20.000Z");
});
