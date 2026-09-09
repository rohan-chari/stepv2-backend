// Run after prepared-worker-queries.test.js exports PREPARED_WORKER_EVIDENCE.
// Replays only its synthetic, publicly observed SQL on a dedicated local test DB.
// Mutations are rolled back per execution; no production connection is accepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Pool, Client } = require('pg');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const selected = [...new Map(input.map(q => [q.family, q])).values()];
assert.equal(selected.length, 5);
const { installPreparedReadQueries } = require('../../src/shared/database/preparedReadQueries');
const { prisma } = require('../../src/db');
const prefix = /^\/\* steps:prepared-(read|query):v1 \*\//;
for (const q of selected) assert.match(q.query, prefix);
const rounds = 30;
const output = [];
const at = new Date();
const past = new Date(+at - 60000);
const future = new Date(+at + 3600000);
const owner = randomUUID();
const races = Array.from({ length: 1000 }, () => randomUUID());
const eventId = randomUUID();
const median = a => [...a].sort((x,y) => x-y)[Math.floor(a.length / 2)];
function normalize(rows) {
  // Placement leases are deliberately clock_timestamp()-based, not plan constants.
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'leaseExpiresAt')));
}
async function seed() {
  await prisma.user.create({ data: { id: owner, appleId: `plan-benchmark-${owner}` } });
  await prisma.race.createMany({ data: races.map(id => ({ id, creatorId: owner,
    name: 'Plan benchmark', targetSteps: 1000000, status: 'ACTIVE', startedAt: past, endsAt: future })) });
  await prisma.raceParticipant.createMany({ data: races.map(raceId => ({ raceId, userId: owner,
    status: 'ACCEPTED', joinedAt: past, buyInStatus: 'NONE' })) });
  await prisma.raceResolutionJobV2.createMany({ data: races.map(raceId => ({ raceId,
    state: 'SUCCEEDED', generation: 1, processingGeneration: 1, committedGeneration: 1,
    requestedAt: past, notBeforeAt: past, lastCompletedAt: past })) });
  await prisma.racePlacementTransitionJob.createMany({ data: races.map(raceId => ({ raceId,
    requestedGeneration: 1, requestedAt: past, observedAt: past, notBeforeAt: past })) });
  await prisma.raceResolutionPostTask.createMany({ data: races.map(raceId => ({ raceId,
    sourceGeneration: 1, dedupeKey: `plan-benchmark:${raceId}`, requestedAt: past, notBeforeAt: past,
    snapshotCommand: { raceId, timeZone: 'UTC' }, payloadBytes: 100, intentCount: 0 })) });
  await prisma.globalStepEvent.create({ data: { id: eventId, startsAt: past, endsAt: future,
    scheduleMode: 'LOCAL_ENTITLEMENTS', multiplier: 2 } });
  await prisma.globalStepEventEntitlement.create({ data: { eventId, userId: owner,
    timezone: 'UTC', localDate: at.toISOString().slice(0,10), startsAt: past, endsAt: future,
    startOutcome: 'ACTIVATED_ON_TIME' } });
  await prisma.globalEventRaceImpact.create({ data: { eventId, userId: owner,
    raceId: races[0], status: 'ENROLLED' } });
}
async function measure(q, density, scope) {
  // This explicitly named test-only pool is dedicated to the benchmark. Recycle
  // idle backends so an earlier workload's custom-plan history cannot bias the
  // next topology. No other test may run against this DB concurrently.
  const adminUrl = new URL(target); adminUrl.pathname = '/pgbouncer';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const database = target.pathname.slice(1);
    assert.match(database, /^[a-zA-Z0-9_]+_test$/);
    await admin.query(`RECONNECT ${database}`);
  } finally { await admin.end(); }
  const pool = new Pool({ connectionString: target.toString(), max: 1, options: '-c timezone=UTC' });
  installPreparedReadQueries(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query('SET LOCAL plan_cache_mode=auto');
    const eligible = density === 'empty' ? 0 : density === 'sparse' ? 1 : races.length;
    // Fixtures stay in the outer transaction. Each measured claim rolls back
    // independently, so baseline and candidate see exactly the same queue.
    await db.query("UPDATE race_resolution_jobs_v2 SET state='succeeded', generation=1,processing_generation=1,last_completed_at=$2 WHERE race_id=ANY($1::text[])", [races,past]);
    await db.query("UPDATE race_placement_transition_jobs SET state='succeeded',completed_generation=1 WHERE race_id=ANY($1::text[])", [races]);
    await db.query("UPDATE race_resolution_post_tasks SET state='succeeded' WHERE race_id=ANY($1::text[])", [races]);
    if (q.family === 'resolution-claim') {
      await db.query("UPDATE race_resolution_jobs_v2 SET state='queued' WHERE race_id=ANY($1::text[])", [races.slice(0,eligible)]);
    } else {
      await db.query("UPDATE race_placement_transition_jobs SET state='queued',completed_generation=NULL WHERE race_id=ANY($1::text[])", [races.slice(0,eligible)]);
      await db.query("UPDATE race_resolution_post_tasks SET state='queued' WHERE race_id=ANY($1::text[])", [races.slice(0,eligible)]);
    }
    for (const table of ['race_resolution_jobs_v2','race_placement_transition_jobs','race_resolution_post_tasks',
      'race_participants','global_step_event_entitlements','global_event_race_impacts']) await db.query(`ANALYZE ${table}`);
    const values = [...q.values];
    if (q.family === 'active-event-read') {
      values[0] = JSON.stringify(Array.from({length: density === 'dense' ? 256 : 1}, (_,i) => ({
        userId: eligible && i === 0 ? owner : `missing-${i}`, at: at.toISOString() })));
      values[1] = scope === 'race' ? races[0] : null;
    } else if (q.family !== 'placement-due') {
      values[0] = at;
      if (q.family !== 'placement-claim') values[1] = new Date(+at + 30000);
    }
    const baseline = q.query.replace(prefix, '');
    const times = { baseline: [], prepared: [] };
    const counters = async () => (await db.query('SELECT COALESCE(sum(generic_plans),0)::int generic,COALESCE(sum(custom_plans),0)::int custom FROM pg_prepared_statements WHERE statement=$1',[q.query])).rows[0];
    const before = await counters();
    for (let i=0;i<rounds;i++) {
      const results = {};
      for (const kind of i % 2 ? ['prepared','baseline'] : ['baseline','prepared']) {
        await db.query('SAVEPOINT sample');
        const start = performance.now();
        results[kind] = normalize((await db.query({ text: kind === 'baseline' ? baseline : q.query, values })).rows);
        times[kind].push(performance.now()-start);
        await db.query('ROLLBACK TO SAVEPOINT sample');
        await db.query('RELEASE SAVEPOINT sample');
      }
      assert.deepEqual(results.prepared, results.baseline, `${q.family}/${density}/${scope}: same result`);
      if (q.family.endsWith('claim')) assert.equal(results.prepared.length, eligible ? 1 : 0);
      if (q.family === 'active-event-read') assert.equal(results.prepared.length, eligible ? 1 : 0);
    }
    const after = await counters();
    const result = { family:q.family,density,scope,rounds,
      genericExecutions:after.generic-before.generic,customExecutions:after.custom-before.custom,
      baselineMedianMs:median(times.baseline.slice(6)),preparedMedianMs:median(times.prepared.slice(6)) };
    output.push(result);
    console.log(JSON.stringify(result));
    // auto may correctly prefer custom plans for a dense queue. Record that
    // case without forcing a generic plan; require actual reuse per family below.
    assert.equal(result.genericExecutions + result.customExecutions, rounds);
    await db.query('ROLLBACK');
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end(); }
}
(async()=>{
  assert.equal(await prisma.race.count(), 0, "benchmark requires a freshly cleaned test database");
  await seed();
  for (const q of selected) for (const density of ['empty','sparse','dense']) {
    for (const scope of q.family === 'active-event-read' ? ['all','race'] : ['queue']) await measure(q,density,scope);
  }
  assert.ok(output.some(row => row.genericExecutions > 0), 'must demonstrate actual plan reuse, not only statement naming');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  // Only this run's synthetic fixtures are removed.
  await prisma.globalEventRaceImpact.deleteMany({where:{eventId}});
  await prisma.globalStepEventEntitlement.deleteMany({where:{eventId}});
  await prisma.globalStepEvent.deleteMany({where:{id:eventId}});
  await prisma.raceResolutionPostTask.deleteMany({where:{raceId:{in:races}}});
  await prisma.race.deleteMany({where:{id:{in:races}}});
  await prisma.user.deleteMany({where:{id:owner}});
  await prisma.$disconnect();
  if (process.argv[3]) fs.writeFileSync(process.argv[3],JSON.stringify({rounds,results:output},null,2));
}).then(() => process.exit(process.exitCode || 0), error => {
  console.error(error); process.exit(1);
});
