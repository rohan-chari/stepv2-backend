const assert = require('node:assert/strict');
const { test } = require('node:test');
const { standingsHit } = require('../../src/shared/observability/cacheEfficiencyMetrics');
const { coordinatedOptimizationMetrics: metrics } = require('../../src/shared/observability/coordinatedOptimizationMetrics');
// Boundary arithmetic and internal metric-label shape are not HTTP surfaces.
for (const [age, band, counterfactual] of [
  [14000, '0-15', false], [15000, '0-15', false], [16000, '15-30', true],
  [29000, '15-30', true], [30000, '15-30', true], [31000, '30-60', false],
]) {
  test(`accepted standings age ${age}ms has a bounded age/counterfactual bucket`, () => {
    metrics.reset();
    const at = Date.UTC(2026, 8, 10, 12);
    standingsHit(new Date(at - age).toISOString(), at, true);
    const counters = metrics.snapshot().counters;
    assert.equal(counters['cache_efficiency_read_total{kind=standings,outcome=hit}'], 1);
    assert.equal(counters[`cache_efficiency_age_total{kind=standings,outcome=${band}}`], 1);
    assert.equal(counters['cache_efficiency_counterfactual_total{kind=standings,outcome=15-30}'] || 0, counterfactual ? 1 : 0);
  });
}
test('age-independent paged/preview hits do not claim a counterfactual database saving', () => {
  metrics.reset();
  const at = Date.UTC(2026, 8, 10, 12);
  standingsHit(new Date(at - 20000).toISOString(), at);
  assert.equal(metrics.snapshot().counters['cache_efficiency_counterfactual_total{kind=standings,outcome=15-30}'], undefined);
});
