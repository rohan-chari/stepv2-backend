const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistoricalScoringWindowCache } = require('../../src/modules/races/services/historicalScoringWindowCache');
const DAY = 86400000;
function timeline(rows) {
  return { revision: 1, forEach(fn) { rows.forEach(row => fn(...row)); } };
}
function score(rows, start, end) {
  return rows.reduce((sum, [a, b, steps]) => {
    const overlap = Math.min(b, end) - Math.max(a, start);
    return sum + (overlap > 0 && b > a ? Math.round(steps * overlap / (b - a)) : 0);
  }, 0);
}
test('reuses old windows across a new source generation, but invalidates corrections and timestamp redistribution', () => {
  const cache = createHistoricalScoringWindowCache();
  let calls = 0;
  const run = rows => cache.sum({ userId: 'u', timeline: timeline(rows), startMs: 0,
    endMs: 50, historicalBeforeMs: DAY, compute: () => { calls++; return score(rows, 0, 50); } });
  assert.equal(run([[0, 100, 100], [3 * DAY, 3 * DAY + 100, 10]]), 50);
  assert.equal(run([[0, 100, 100], [3 * DAY, 3 * DAY + 100, 20]]), 50);
  assert.equal(calls, 1);
  assert.equal(run([[0, 100, 80]]), 40);
  assert.equal(run([[50, 150, 80]]), 0);
  assert.equal(calls, 3);
});
test('preserves exact original rounding across midnight and does not share partially closed samples', () => {
  const cache = createHistoricalScoringWindowCache();
  const rows = [[DAY - 1, DAY + 1, 1]];
  let calls = 0;
  const run = (startMs, endMs, closedAtMs = null) => cache.sum({ userId: 'u', timeline: timeline(rows),
    startMs, endMs, closedAtMs, historicalBeforeMs: 3 * DAY,
    compute: () => { calls++; return closedAtMs != null && closedAtMs < DAY + 1 ? 0 : score(rows, startMs, endMs); } });
  assert.equal(run(DAY - 1, DAY + 1), 1);
  assert.equal(run(DAY - 1, DAY), 1);
  assert.equal(run(DAY, DAY + 1), 1);
  assert.equal(run(DAY - 1, DAY + 1, DAY), 0);
  assert.equal(run(DAY - 1, DAY + 1, DAY + 2), 1);
  assert.equal(run(DAY - 1, DAY + 1, DAY + 3), 1);
  assert.equal(calls, 5);
});
test('recent windows bypass cache; TTL and entry limit bound retention', () => {
  let clock = 0, calls = 0;
  const cache = createHistoricalScoringWindowCache({ maxEntries: 1, ttlMs: 10, now: () => clock });
  const t = timeline([[0, 100, 50]]);
  const run = (userId, historicalBeforeMs = 200) => cache.sum({ userId, timeline: t,
    startMs: 0, endMs: 100, historicalBeforeMs, compute: () => ++calls });
  assert.equal(run('u', 50), 1);
  assert.equal(run('u', 50), 2);
  assert.equal(run('u'), 3);
  assert.equal(run('u'), 3);
  run('other');
  assert.equal(cache.snapshot().entries, 1);
  assert.equal(run('u'), 5);
  clock = 11;
  assert.equal(run('u'), 6);
});
