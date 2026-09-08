// Local PostgreSQL 18 only. Run with explicit DATABASE_URL, NODE_ENV=test and REDIS_URL=.
// Optional --output <path> retains sanitized evidence; --phase labels the real SQL revision.
const assert = require('node:assert/strict');
const { writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const hash = value => createHash('sha256').update(value).digest('hex');
const { execFileSync } = require('node:child_process');
const h = require('../../test/integration/fixtures/enrollment-query/harness.cjs');
const option = name => process.argv[process.argv.indexOf(name) + 1];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function run() {
  const [{ version }] = await h.prisma.$queryRawUnsafe('SELECT version()');
  assert.match(version, /^PostgreSQL 18\./, 'performance acceptance requires PostgreSQL 18');
  const settings = await h.prisma.$queryRawUnsafe(`SELECT name,setting,unit FROM pg_settings
    WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost',
      'seq_page_cost','max_parallel_workers_per_gather','lc_collate') ORDER BY name`);
  const report = { phase: process.argv.includes('--phase') ? option('--phase') : 'unspecified',
    recordedAt: new Date().toISOString(), version, settings,
    sourceSha256: hash(readFileSync(join(__dirname, '../../src/modules/steps/services/globalStepEventEntitlement.js'))),
    baselineSqlSha256: hash(h.baseline), candidateSqlSha256: hash(h.candidate),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    measurement: 'root shared hits + reads; EXPLAIN execution is not CPU; 1 warmup + 5 alternating pairs',
    cases: [], failures: [] };
  const workloads = [
    { name: 'historical-empty', history: 30000, active: 1000, missing: 0 },
    { name: 'historical-10x-empty', history: 300000, active: 1000, missing: 0 },
    { name: 'sparse', history: 30000, active: 1000, missing: 25 },
    { name: 'full', history: 30000, active: 1000, missing: 1000 },
    { name: 'large-active', history: 30000, active: 10000, missing: 10000 },
    { name: 'small-active-empty', history: 30000, active: 1000, missing: 0, activeRaces: 3, historicalRaceSize: 100 },
    { name: 'small-active-full', history: 30000, active: 1000, missing: 1000, activeRaces: 3, historicalRaceSize: 100 },
    { name: 'small-active-large-population', history: 30000, active: 10000, missing: 10000, activeRaces: 3, historicalRaceSize: 100 },
  ];
  for (const workload of workloads.filter(item => !process.argv.includes('--workload') || item.name === option('--workload'))) {
    const shape = { activeRaces: 160, historicalRaceSize: 50, ...workload };
    const fixture = await h.seedPerformance(shape);
    // Capture real scheduled-work SQL and write behavior BEFORE supplementary plan probes.
    const real = await h.tick();
    assert.equal(real.result, true);
    assert.ok(real.pages.length >= 2);
    const productionSQL = real.pages[0].query;
    const compact = sql => sql.replace(/\s+/g, '').replace(/;$/, '');
    const isBaseline = compact(productionSQL) === compact(h.baseline);
    const isApproved = compact(productionSQL) === compact(h.candidate);
    assert.ok(isBaseline || isApproved, 'captured live SQL must match a measured comparison');
    if (report.phase === 'baseline') assert.ok(isBaseline, 'baseline measurements must execute baseline production SQL');
    if (report.phase === 'after') assert.ok(isApproved, 'after measurements must execute approved production SQL');
    const runtime = { elapsedMs: real.elapsedMs, queryCount: real.queryCount, leadingSqlVerbs: real.counts,
      capturedSqlSha256: hash(productionSQL),
      pages: real.pages.map(q => ({ params: JSON.parse(q.params), durationMs: q.duration })),
      firstTickEntitlements: await h.prisma.globalStepEventEntitlement.count(),
      firstTickObligations: await h.prisma.domainEventOutbox.count({ where: {
        eventType: 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1' } }),
      budgetExceeded: real.elapsedMs > 5000,
      candidateSelectExceededBudget: real.pages.some(q => q.duration > 5000) };
    runtime.firstTickParentCounts = await h.prisma.globalStepEventEntitlement.groupBy({
      by: ['eventId'], _count: { _all: true }, orderBy: { eventId: 'asc' },
    });
    runtime.followupTicks = [];
    runtime.finalEntitlements = runtime.firstTickEntitlements;
    runtime.cumulativeElapsedMs = runtime.elapsedMs;
    runtime.cumulativeQueryCount = runtime.queryCount;
    // Real budget stays enabled. If one tick cannot finish, measure bounded real
    // subsequent ticks and assert eventual identical durable work, not equal elapsed work.
    for (let index = 0; runtime.finalEntitlements < workload.active * 2 && index < 10; index += 1) {
      const followup = await h.tick();
      runtime.followupTicks.push({ elapsedMs: followup.elapsedMs, queryCount: followup.queryCount,
        leadingSqlVerbs: followup.counts, candidatePages: followup.pages.length });
      runtime.cumulativeElapsedMs += followup.elapsedMs;
      runtime.cumulativeQueryCount += followup.queryCount;
      runtime.finalEntitlements = await h.prisma.globalStepEventEntitlement.count();
    }
    runtime.finalObligations = await h.prisma.domainEventOutbox.count({ where: {
      eventType: 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1' } });
    runtime.finalParentCounts = await h.prisma.globalStepEventEntitlement.groupBy({
      by: ['eventId'], _count: { _all: true }, orderBy: { eventId: 'asc' },
    });
    assert.equal(runtime.finalEntitlements, workload.active * 2, 'scheduler converges across real-budget ticks');
    assert.equal(runtime.finalObligations, workload.missing * 2, 'same durable obligations after convergence');
    // Restore precisely the same pre-tick fixture. Never compare against newly enrolled state.
    const stable = await h.seedPerformance(shape);
    const result = { name: workload.name, dimensions: stable.dimensions, runtime, comparisons: [] };
    for (const pageSize of [100, 500]) {
      for (const cursor of [null, stable.activeUsers[Math.floor(workload.active / 2)].id]) {
        const params = [stable.events[0].id, pageSize, cursor];
        const expected = await h.prisma.$queryRawUnsafe(h.baseline, ...params);
        for (const sql of [h.candidate, productionSQL]) {
          assert.deepEqual(await h.prisma.$queryRawUnsafe(sql, ...params), expected);
        }
        await h.explain(h.baseline, params); await h.explain(h.candidate, params);
        const samples = [];
        for (let i = 0; i < 5; i += 1) {
          let baseline, candidate;
          if (i % 2 === 0) { baseline = await h.explain(h.baseline, params); candidate = await h.explain(h.candidate, params); }
          else { candidate = await h.explain(h.candidate, params); baseline = await h.explain(h.baseline, params); }
          samples.push({ baseline, candidate });
        }
        const baselineBuffers = median(samples.map(s => s.baseline.buffers));
        const candidateBuffers = median(samples.map(s => s.candidate.buffers));
        const ratio = candidateBuffers / baselineBuffers;
        const limit = workload.name.startsWith('historical-') ? 0.25 : 1.2;
        const pass = ratio <= limit;
        if (!pass) report.failures.push(`${workload.name} page=${pageSize} cursor=${cursor}: buffer ratio ${ratio.toFixed(3)} > ${limit}`);
        const newTempSpill = samples.some(s => s.candidate.tempWritten > s.baseline.tempWritten);
        if (newTempSpill) report.failures.push(`${workload.name} page=${pageSize}: new temporary I/O requires review`);
        result.comparisons.push({ pageSize, cursor, rows: expected.length, pass, ratio,
          median: { baselineBuffers, candidateBuffers,
            baselineExecutionMs: median(samples.map(s => s.baseline.executionMs)),
            candidateExecutionMs: median(samples.map(s => s.candidate.executionMs)),
            baselinePlanningMs: median(samples.map(s => s.baseline.planningMs)),
            candidatePlanningMs: median(samples.map(s => s.candidate.planningMs)) }, samples });
      }
    }
    result.runtime.queryShape = isBaseline ? 'baseline' : 'approved';
    report.cases.push(result);
    console.log(JSON.stringify({ workload: workload.name, runtime, comparisons: result.comparisons.map(({ samples, ...rest }) => rest) }));
    if (process.argv.includes('--output')) writeFileSync(option('--output'), JSON.stringify(report, null, 2) + '\n');
  }
  await h.resetPerformance();
  console.log(JSON.stringify({ failures: report.failures }));
  return report.failures.length === 0 ? 0 : 1;
}

run().then(async code => { await h.prisma.$disconnect(); process.exit(code); })
  .catch(async error => { console.error(error); await h.prisma.$disconnect(); process.exit(1); });
