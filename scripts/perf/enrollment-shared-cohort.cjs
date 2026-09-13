// Synthetic local test DB only. Run independently of integration suites.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const h = require('../../test/integration/fixtures/enrollment-query/harness.cjs');
function quantile(values, q) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * q) - 1)]; }
(async () => {
  const fixture = await h.seedPerformance({ active: 1009, activeRaces: 166 });
  const parents = fixture.events.slice();
  for (let i = 0; i < 3; i++) {
    const event = await h.prisma.globalStepEvent.create({ data: {
      id: `perf-extra-parent-${i}`, scheduleMode: 'LOCAL_ENTITLEMENTS', eventDay: `2098-01-${10 + i}`,
      startsAt: fixture.events[0].startsAt, endsAt: fixture.events[0].endsAt, localStartMinute: 600, durationMinutes: 30,
    } });
    for (let first = 0; first < fixture.activeUsers.length; first += 500) await h.prisma.globalStepEventEntitlement.createMany({
      data: fixture.activeUsers.slice(first, first + 500).map(user => h.entitlement(event, user.id)) });
    parents.push(event);
  }
  await h.analyze();
  const run = await h.tick({ freezeBudget: true });
  const query = run.events.find(event => event.query.includes('parent_inputs') && event.query.includes('enrollment_candidates'));
  assert.ok(query); const parameters = JSON.parse(query.params);
  const pairs = [];
  for (let i = 0; i < 10; i++) {
    const baseline = async () => {
      const results = [];
      for (const parent of parents) results.push(await h.explain(h.candidate, [parent.id, 500, null]));
      return { buffers: results.reduce((n, row) => n + row.buffers, 0), executionMs: results.reduce((n, row) => n + row.executionMs, 0),
        planningMs: results.reduce((n, row) => n + row.planningMs, 0), cohortEvaluations: 5, statements: 5 };
    };
    const candidate = async () => ({ ...await h.explain(query.query, parameters), cohortEvaluations: 1, statements: 1 });
    const pair = i % 2 ? { candidate: await candidate(), baseline: await baseline() } : { baseline: await baseline(), candidate: await candidate() };
    pairs.push(pair);
  }
  const summary = Object.fromEntries(['baseline', 'candidate'].map(kind => [kind, {
    medianBuffers: quantile(pairs.map(pair => pair[kind].buffers), .5),
    medianExecutionMs: quantile(pairs.map(pair => pair[kind].executionMs), .5),
    p95ExecutionMs: quantile(pairs.map(pair => pair[kind].executionMs), .95),
  }]));
  const evidence = { postgres: (await h.prisma.$queryRawUnsafe('SELECT version()'))[0].version,
    dimensions: { ...fixture.dimensions, parents: 5 }, physicalTick: { elapsedMs: run.elapsedMs, queryCount: run.queryCount, counts: run.counts }, pairs, summary,
    scope: 'Alternating warm local EXPLAIN executions; full tick query counts include target-day/parent-page/retention/end scans. No CPU or whole-worker-latency claim.' };
  writeFileSync(process.env.ENROLLMENT_TEST_EVIDENCE || 'docs/evidence/db-work-reduction/enrollment-shared-cohort.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(summary));
  assert.ok(summary.candidate.medianBuffers <= summary.baseline.medianBuffers * .5, 'at least fifty percent lower aggregate discovery buffers');
  await h.resetPerformance(); await h.prisma.$disconnect();
})().catch(async error => { console.error(error); await h.prisma.$disconnect(); process.exitCode = 1; });
