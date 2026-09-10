const assert = require('node:assert/strict');
const { it } = require('node:test');
const { reelPreviewAvailable } = require('../../src/modules/powerups/services/reelPreviewAvailability');
// Pure malformed-metadata/normalization cases are structurally unreachable
// through persisted typed effects and validated config. HTTP covers live state.
const base = { participantId: 'owner', effects: [], byType: { A: 0.4, B: 0.6, C: 0 } };
it('requires a complete finite probability map and known viewer/effects', () => {
  assert.equal(reelPreviewAvailable(base), true);
  for (const byType of [undefined, null, [], {}, { A: 0 }, { A: 0.4 }, { A: 1.1 }, { A: -0.1, B: 1.1 }, { A: NaN }, { A: Infinity }, { A: '1' }]) {
    assert.equal(reelPreviewAvailable({ ...base, byType }), false, String(byType));
  }
  for (const effects of [undefined, null, {}, [null], [{ type: 'LUCKY_HORSESHOE' }]]) assert.equal(reelPreviewAvailable({ ...base, effects }), false);
  assert.equal(reelPreviewAvailable({ ...base, participantId: null }), false);
  assert.equal(reelPreviewAvailable({ ...base, byType: { A: 1 - 0.0000005 } }), true);
  assert.equal(reelPreviewAvailable({ ...base, byType: { A: 1 - 0.000002 } }), false);
});
it('uses server effect status and owner, including ACTIVE rows past expiresAt', () => {
  const effect = { type: 'LUCKY_HORSESHOE', status: 'ACTIVE', targetParticipantId: 'owner', expiresAt: new Date(0) };
  assert.equal(reelPreviewAvailable({ ...base, effects: [effect] }), false);
  assert.equal(reelPreviewAvailable({ ...base, effects: [{ ...effect, targetParticipantId: 'rival' }] }), true);
  assert.equal(reelPreviewAvailable({ ...base, effects: [{ ...effect, status: 'EXPIRED' }] }), true);
});
