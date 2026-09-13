// Database wall-clock rollback/forward cannot be induced safely through HTTP.
// Test the pure proof transition across those clocks; HTTP tests cover callers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { historicalRawProof } = require('../../src/modules/steps/services/scoringInputVersion');
const DAY = 86400000;
const cutoff = Date.parse('2026-09-11T00:00:00Z');
const state = { generation: 4n, historicalRawRevision: 'opaque-prior-token', historicalRawCompleteGeneration: 4n,
  historicalRawProtectedCutoff: new Date(cutoff), inserted: false };
test('historical proof never retreats after DB wall-clock rollback', () => {
  const next = { dbNow: new Date(cutoff + DAY) };
  const proof = historicalRawProof(state, next, true, { complete: true, earliestChangedStartMs: cutoff - 1000 });
  assert.equal(+proof.cutoff, cutoff); assert.notEqual(proof.revision, state.historicalRawRevision); assert.equal(proof.generation, '5');
});
test('forward midnight protects newly historical rows while preserving an unchanged prefix', () => {
  const proof = historicalRawProof(state, { dbNow: new Date(cutoff + 3 * DAY) }, true,
    { complete: true, earliestChangedStartMs: cutoff + 2 * DAY });
  assert.equal(+proof.cutoff, cutoff + DAY); assert.equal(proof.revision, state.historicalRawRevision);
  const corrected = historicalRawProof(state, { dbNow: new Date(cutoff + 3 * DAY) }, true,
    { complete: true, earliestChangedStartMs: cutoff + DAY - 1000 });
  assert.notEqual(corrected.revision, state.historicalRawRevision);
});
test('unknown writer followed by classified no-op rotates the opaque revision before stamping completeness', () => {
  const proof = historicalRawProof({ ...state, generation: 5n }, { dbNow: new Date(cutoff + 2 * DAY) }, false,
    { complete: true, earliestChangedStartMs: null });
  assert.notEqual(proof.revision, state.historicalRawRevision); assert.equal(proof.generation, '5');
});
test('unclassified or invalid-clock writes do not manufacture a verified proof', () => {
  assert.equal(historicalRawProof(state, {}, true, null), null);
  assert.equal(historicalRawProof(state, { dbNow: new Date(NaN) }, true, { complete: true }), null);
});
test('tighter caller budgets bypass Redis and proof reads for the canonical bounded loader', async () => {
  const { loadHistoricalRawSamples } = require('../../src/modules/races/services/historicalRawSampleCache');
  for (const budget of [{ maxRetainedSampleRowsPerUser: 2, maxHeapGrowthBytes: 32 * 1024 * 1024 },
    { maxRetainedSampleRowsPerUser: 50000, maxHeapGrowthBytes: 32 }]) {
    const bounds = [{ userId: 'budget-test', rangeStart: new Date(cutoff - 7 * DAY) }];
    const sentinel = new Map(); let calls = 0;
    const result = await loadHistoricalRawSamples({ bounds, now: new Date(cutoff + 2 * DAY), ...budget,
      load: async received => { calls++; assert.equal(received, bounds); return sentinel; },
      memoryUsage: () => { throw new Error('bypass must not allocate/cache/proof-read'); } });
    assert.equal(result, sentinel); assert.equal(calls, 1);
  }
});
