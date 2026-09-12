// Read-only microbenchmark of the real timeline and cache admission. No DB.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const source = fs.readFileSync(path.join(__dirname, '../../src/modules/races/services/raceScoringPrefetch.js'), 'utf8');
// Extract the pure timeline/admission to avoid involving IO/source loading in
// this calculation benchmark. Fail visibly if their source layout changes.
const classStart = source.indexOf('class CompactSampleTimeline');
const classEnd = source.indexOf('// Exceptional histories');
const admissionStart = source.indexOf('const admitHistoricalBatch =');
const admissionEnd = source.indexOf('const historicalSum =');
if ([classStart, classEnd, admissionStart, admissionEnd].some(value => value < 0)) throw Error('benchmark source layout changed');
const Timeline = new Function(source.slice(classStart, classEnd) + '; return CompactSampleTimeline;')();
const admitFactory = new Function('historicalBeforeMs', 'historicalWindowDemand',
  source.slice(admissionStart, admissionEnd) + 'return admitHistoricalBatch;');
const { createHistoricalScoringWindowCache } = require('../../src/modules/races/services/historicalScoringWindowCache');
const { coordinatedOptimizationMetrics: metrics } = require('../../src/shared/observability/coordinatedOptimizationMetrics');
const DAY = 86400000, base = Date.UTC(2026, 8, 1), historicalBeforeMs = base + 5 * DAY, batches = 240;
function make(generation) {
  const timeline = new Timeline();
  timeline.append(Array.from({ length: 2016 }, (_, i) => ({
    start: new Date(base + i * 300000), end: new Date(base + (i + 1) * 300000),
    steps: i === 2015 ? 10 + generation : 10,
  })));
  Object.freeze(timeline.segments);
  return Object.freeze(timeline);
}
const shared = make(0), fresh = Array.from({ length: batches }, (_, i) => make(i));
for (let i = 0; i < 2000; i++) shared.sum(base, base + 900000);
for (const scenario of ['fresh', 'shared']) for (const count of [1, 5, 20, 100]) {
  const timelines = scenario === 'fresh' ? fresh : Array(batches).fill(shared);
  const windows = Array.from({ length: count }, (_, i) => ({
    startMs: base + (i % 100) * 300000 + i, endMs: base + (i % 100) * 300000 + i + 900000,
  }));
  const plain = [], cached = [];
  let last;
  for (let round = 0; round < 3; round++) {
    let checksum = 0, begin = performance.now();
    for (const timeline of timelines) for (const window of windows) checksum += timeline.sum(window.startMs, window.endMs);
    plain.push(performance.now() - begin);
    const cache = createHistoricalScoringWindowCache({ metrics });
    const admit = admitFactory(historicalBeforeMs, new WeakMap());
    let actual = 0;
    begin = performance.now();
    for (const timeline of timelines) {
      const eligible = admit(timeline, windows);
      for (const window of windows) actual += eligible ? cache.sum({
        userId: 'benchmark-user', timeline, ...window, historicalBeforeMs,
        compute: () => timeline.sum(window.startMs, window.endMs),
      }) : timeline.sum(window.startMs, window.endMs);
    }
    cached.push(performance.now() - begin);
    if (actual !== checksum) throw Error('score mismatch');
    last = cache.snapshot();
  }
  const plainMs = plain.sort((a, b) => a - b)[1], cacheMs = cached.sort((a, b) => a - b)[1];
  console.log(JSON.stringify({ scenario, windows: count, plainMs: +plainMs.toFixed(2),
    cacheMs: +cacheMs.toFixed(2), ratio: +(cacheMs / plainMs).toFixed(2), ...last }));
}
