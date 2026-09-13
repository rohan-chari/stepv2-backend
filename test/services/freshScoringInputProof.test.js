// Proof capability provenance is an internal property unreachable from HTTP.
// Real worker/HTTP suites separately prove cold/warm scores and SELECT savings.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bindFreshScoringInputProof, takeFreshScoringInputProof } = require('../../src/modules/races/services/freshScoringInputProof');
const { captureInitialProofRead } = require('../../src/modules/races/services/historicalRawSampleCache');
const row = { userId: 'u', generation: '2', historicalRawRevision: 'r', historicalRawCompleteGeneration: '2',
  historicalRawProtectedCutoff: '2026-09-11T00:00:00Z' };
test('fresh source proof is consumed once and cannot survive fingerprint persistence or copying', () => {
  const fingerprint = { digest: 'same', inputs: [{ userId: 'u', generation: '2' }] };
  bindFreshScoringInputProof(fingerprint, [row]);
  assert.equal(takeFreshScoringInputProof(JSON.parse(JSON.stringify(fingerprint))), undefined);
  assert.equal(takeFreshScoringInputProof({ ...fingerprint }), undefined);
  const proof = takeFreshScoringInputProof(fingerprint);
  assert.deepEqual(proof.get('u'), { ...row, historicalRawProtectedCutoff: '2026-09-11T00:00:00.000Z' });
  assert.ok(Object.isFrozen(proof.get('u')));
  assert.equal(takeFreshScoringInputProof(fingerprint), undefined);
});
test('old model projections, foreign users and duplicate users never manufacture initial proof', () => {
  const attempt = {};
  assert.equal(captureInitialProofRead([{ userId: 'u', generation: 2 }], ['u'], attempt), null);
  assert.equal(captureInitialProofRead([row], ['another-user'], attempt), null);
  assert.equal(captureInitialProofRead([row, row], ['u'], attempt), null);
  assert.equal(captureInitialProofRead([row], ['u', 'u'], attempt), null);
  assert.ok(Object.isFrozen(captureInitialProofRead([row], ['u'], attempt)));
});
