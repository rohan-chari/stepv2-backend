const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const frozenBaseline = require('./fixtures/enrollment-query/parent-maintenance-baseline.json');
const h = require('./fixtures/enrollment-query/harness.cjs');
const { startServer } = require('./setup');
const INDEX = 'global_step_event_entitlements_pending_parent_idx';
let server;
before(async () => { server = await startServer(); });
after(async () => { await h.resetPerformance(); await server.close(); await h.prisma.$disconnect(); });

test('pending parent concurrent migration is exact, valid, ready and replayable', async () => {
  const definition = async () => (await h.prisma.$queryRawUnsafe(`SELECT i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i WHERE i.indexrelid=to_regclass($1)`, INDEX))[0];
  const index = await definition();
  assert.ok(index, 'required pending-parent partial index is absent');
  assert.equal(index.indisvalid, true); assert.equal(index.indisready, true);
  assert.match(index.definition, /USING btree \(event_id\) WHERE \(\(start_processed_at IS NULL\) OR \(end_processed_at IS NULL\)\)/);
  execFileSync('npx',['prisma','migrate','deploy'],{env:process.env,stdio:'pipe'});
  assert.deepEqual(await definition(),index);
});

// This schema/plan property is not observable in an HTTP payload. The SQL is
// captured from the exported real scheduler; no private model helper is called.
test('actual scheduler parent SQL preserves lifecycle rows while skipping drained history', { timeout: 180000 }, async () => {
  await h.resetPerformance();
  const futureParents = await h.parents();
  const historyUsers = process.env.PARENT_INDEX_HISTORY_SCALE === '10' ? 10000 : 1000;
  await h.prisma.user.createMany({ data: Array.from({ length: historyUsers }, (_, i) => ({ id: `parent-index-user-${i}` })) });
  const ended = new Date(+h.NOW - 3600000);
  const dimensions = { parents: 27, entitlements: 25 * historyUsers + 2000, pending: 2003 };
  await h.prisma.globalStepEvent.createMany({ data: Array.from({ length: 25 }, (_, i) => ({
    id: `parent-index-${String(i).padStart(2, '0')}`, scheduleMode: 'LOCAL_ENTITLEMENTS',
    startsAt: new Date(+ended - 3600000 - i * 60000), endsAt: ended,
  })) });
  for (let parent = 0; parent < 25; parent++) for (let first = 0; first < historyUsers; first += 1000) {
    await h.prisma.globalStepEventEntitlement.createMany({ data: Array.from({ length: 1000 }, (_, ordinal) => { const user = first + ordinal; return ({
      eventId: `parent-index-${String(parent).padStart(2, '0')}`, userId: `parent-index-user-${user}`,
      timezone: 'UTC', localDate: '2097-12-31', startsAt: new Date(+ended - 1800000), endsAt: ended,
      startProcessedAt: user === 0 && parent < 2 ? null : ended,
      endProcessedAt: user === 0 && (parent === 0 || parent === 2) ? null : ended,
    }); }) });
  }
  await h.prisma.globalStepEvent.createMany({ data: [
    { id: 'parent-index-equal-drained', scheduleMode: 'LOCAL_ENTITLEMENTS', startsAt: ended, endsAt: h.NOW },
    { id: 'parent-index-legacy', scheduleMode: 'LEGACY_GLOBAL', startsAt: ended, endsAt: new Date(+h.NOW + 3600000) },
  ] });
  for (const event of futureParents) {
    await h.prisma.globalStepEventEntitlement.createMany({ data: Array.from({ length: 1000 }, (_, i) => h.entitlement(event, `parent-index-user-${i}`)) });
  }
  await h.analyze();
  // Skip boundary processing so all pending lifecycle combinations remain present.
  const { buildLocalGlobalStepEventTick } = require('../../src/modules/steps');
  const events = [];
  h.prisma.$on('query', event => events.push(event));
  await buildLocalGlobalStepEventTick({ now: () => h.NOW, skipEndBoundaries: true,
    cleanupExpiredEntitlements: async () => 0, logger: { log() {}, error() {} } })();
  const query = events.find(e => e.query.includes('"public"."global_step_events"') &&
    e.query.includes('start_processed_at') && e.query.startsWith('SELECT'));
  assert.ok(query, 'captured real scheduler maintenance query');
  const params = JSON.parse(query.params).map(value => typeof value === 'string' && /^2098-/.test(value) ? new Date(value) : value);
  const rowsBefore = await h.prisma.$queryRawUnsafe(query.query, ...params);
  const ids = rowsBefore.map(row => row.id);
  for (const i of ['00', '01', '02']) assert.ok(ids.includes(`parent-index-${i}`));
  assert.ok(!ids.includes('parent-index-equal-drained'));
  assert.ok(!ids.includes('parent-index-legacy'));
  const explain = async (sql, parameters) => {
    const result = (await h.prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${sql}`, ...parameters))[0]['QUERY PLAN'][0];
    return { buffers: (result.Plan['Shared Hit Blocks'] || 0) + (result.Plan['Shared Read Blocks'] || 0),
      planningMs: result['Planning Time'], executionMs: result['Execution Time'], rows: result.Plan['Actual Rows'] };
  };
  const baselineParams = frozenBaseline.params.map(value => typeof value === 'string' && /^2098-/.test(value) ? new Date(value) : value);
  assert.deepEqual((await h.prisma.$queryRawUnsafe(frozenBaseline.query, ...baselineParams)).map(row => row.id), ids);
  const runs = [];
  for (let i = 0; i < 10; i++) {
    await h.prisma.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
    const baseline = await explain(frozenBaseline.query, baselineParams);
    await h.prisma.$executeRawUnsafe(`CREATE INDEX ${INDEX} ON global_step_event_entitlements(event_id) WHERE start_processed_at IS NULL OR end_processed_at IS NULL`);
    const candidate = await explain(query.query, params);
    runs.push({ baseline, candidate });
  }
  assert.deepEqual((await h.prisma.$queryRawUnsafe(query.query, ...params)).map(row => row.id), ids);

  console.log(JSON.stringify({ parentMaintenanceRuns: runs }));
  assert.ok(runs.every(run => run.candidate.buffers <= run.baseline.buffers * .2), 'at least80percent lower root buffer work on the mostly-drained fixture');
  const indexBytes = Number((await h.prisma.$queryRawUnsafe('SELECT pg_relation_size($1::regclass)::bigint AS bytes', INDEX))[0].bytes);
  const evidence = { dimensions, runs, indexBytes, candidate: 'bounded parent query with pending-parent index',
    additionalFixtureEvidence: 'parent-paginated-index.json', note: 'Alternating warm plans, frozen baseline SQL captured from the real baseline scheduler. No host CPU claim.' };
  console.log(JSON.stringify({ parentMaintenanceBenchmark: evidence }));
  if (process.env.PARENT_INDEX_EVIDENCE) writeFileSync(process.env.PARENT_INDEX_EVIDENCE, JSON.stringify(evidence, null, 2));
});
