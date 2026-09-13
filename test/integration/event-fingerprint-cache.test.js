process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { before, beforeEach, after, it } = require('node:test');
const db = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(db.hostname));
assert.match(db.pathname, /_test$/);
const redisUrl = new URL(process.env.REDIS_URL);
assert.ok(['localhost', '127.0.0.1'].includes(redisUrl.hostname));
assert.equal(process.env.CACHE_ENV_PREFIX, 'event-fingerprint-test:');
const Redis = require('ioredis');
const redis = new Redis(redisUrl.toString());
const { reads } = require('./fixtures/observe-event-fingerprint.cjs');
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
let baseUrl;
let workerQueries = null;
prisma.$on('query', event => workerQueries?.push(event.query));
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(async () => {
  await cleanDatabase();
  const keys = await redis.keys('event-fingerprint-test:*');
  if (keys.length) await redis.del(...keys);
  reads.length = 0;
});
after(async () => { await redis.quit(); });
async function fixture(mode = 'LEGACY_GLOBAL', { future = false, ended = false } = {}) {
  const account = await createTestUser({ timezone: 'UTC' });
  const now = Date.now();
  const race = await prisma.race.create({ data: {
    creatorId: account.user.id, name: 'Event vector', status: 'ACTIVE', targetSteps: 100000,
    maxParticipants: 10, powerupsEnabled: true, timezone: 'UTC',
    startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
  } });
  const participant = await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: account.user.id, status: 'ACCEPTED', joinedAt: race.startedAt,
  } });
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt: new Date(now + (future ? 300000 : -5400000)),
    endsAt: new Date(now + (ended ? -600000 : 3600000)),
    scheduleMode: mode, multiplier: 2,
  } });
  let entitlement, impact;
  if (mode === 'LOCAL_ENTITLEMENTS') {
    entitlement = await prisma.globalStepEventEntitlement.create({ data: {
      eventId: event.id, userId: account.user.id, timezone: 'America/New_York',
      localDate: event.startsAt.toISOString().slice(0, 10), startsAt: event.startsAt, endsAt: event.endsAt,
      startOutcome: 'ACTIVATED_ON_TIME', startProcessedAt: event.startsAt,
    } });
    impact = await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id, raceId: race.id, userId: account.user.id,
    } });
  }
  await prisma.globalStepEventBoundaryCursor.upsert({ where: { key: 'global' },
    create: { key: 'global', boundaryAt: new Date(now), eventId: 'zz', boundaryKind: 'END' },
    update: { boundaryAt: new Date(now), eventId: 'zz', boundaryKind: 'END' } });
  return { account, race, event, participant, entitlement, impact, now };
}
async function upload(f, steps) {
  const res = await request(baseUrl, 'POST', '/steps/sync-v2', {
    token: f.account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC', 'X-Client-Features': '' },
    body: { date: new Date(f.now).toISOString().slice(0, 10), steps, samples: [{
      periodStart: new Date(f.now - 3600000).toISOString(), periodEnd: new Date(f.now - 1800000).toISOString(), steps,
    }] },
  });
  assert.equal(res.status, 202);
}
async function run(f, steps, beforeWriteTransaction) {
  await upload(f, steps);
  reads.length = 0;
  const logs = [];
  const logger = { log: v => { try { logs.push(JSON.parse(v)); } catch {} }, error: console.error, warn: console.warn };
  const queries = [];
  workerQueries = queries;
  try { assert.equal(await buildRaceResolutionWorkerV2({ bootAt: 0, logger, beforeWriteTransaction }).tick(), 1); }
  finally { workerQueries = null; }
  const captured = reads.slice();
  const res = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, {
    token: f.account.token, headers: { 'X-Client-Features': '' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const total = body.progress.participants.find(p => p.userId === f.account.user.id).totalSteps;
  assert.equal((await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.participant.id } })).totalSteps, total,
    'the worker must durably commit the score, not rely on an HTTP replay');
  return { reads: captured, logs, queries, score: total };
}
const planning = result => result.reads.find(r => !r.transaction);
// Discovery SQL is distinct from the bounded authoritative local witness,
// which is part of the roster SELECT and is explicitly counted below.
const eventQueries = read => read.queries.filter(q => !q.includes('AS "r_id"') &&
  /global_step_events|global_step_event_entitlements|global_event_race_impacts/.test(q));
const json = value => JSON.parse(JSON.stringify(value));
async function cacheKeys(kind = '*') { return redis.keys(`event-fingerprint-test:event-fingerprint:v4:${kind}:*`); }

for (const mode of ['LEGACY_GLOBAL', 'LOCAL_ENTITLEMENTS']) {
  it(`real HTTP + worker cold/warm parity and measured query budget: ${mode}`, async t => {
    const f = await fixture(mode);
    const cold = await run(f, 50);
    const warm = await run(f, 60);
    assert.equal(cold.score, 100);
    assert.equal(warm.score, 120);
    assert.deepEqual(json(planning(warm).value.globalEvents), json(planning(cold).value.globalEvents));
    assert.deepEqual(json(planning(warm).value.globalEvents), json(warm.reads.find(r => r.transaction).value.globalEvents),
      'cached rows must match the deployed recap canonical transaction row shape exactly');
    assert.equal(eventQueries(planning(warm)).length, 0, 'warm planning must reuse the complete vector with DB revision proof');
    assert.equal(planning(warm).queries.filter(q => q.includes('AS "r_id"') && q.includes('race_event_fingerprint_versions')).length, 1,
      'warm planning reads the authoritative race version in the roster statement');
    assert.equal(planning(warm).queries.length, 3, 'revisions piggyback on roster; no extra revision SELECT');
    assert.ok(warm.reads.some(r => r.transaction && eventQueries(r).some(q => q.includes('WITH race_window AS'))),
      'final PostgreSQL event fence remains in the real write transaction');
    assert.ok((await cacheKeys('global')).length);
    assert.ok((await cacheKeys('local')).length);
    t.diagnostic(JSON.stringify({ mode, coldFingerprintSelects: cold.reads.map(r => r.queries.length),
      warmFingerprintSelects: warm.reads.map(r => r.queries.length), coldEventReads: cold.reads.map(r => eventQueries(r).length),
      warmEventReads: warm.reads.map(r => eventQueries(r).length), coldWorkerRoundTrips: cold.queries.length,
      warmWorkerRoundTrips: warm.queries.length, coldRosterJsonBytes: planning(cold).rosterJsonBytes,
      warmRosterJsonBytes: planning(warm).rosterJsonBytes }));
  });
}

it('saved recap keeps ended history AND upcoming ten-minute events; delayed replacements still rescore', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS', { ended: true });
  await prisma.eventRecap.create({ data: {
    eventId: f.event.id, userId: f.account.user.id, calculationVersion: 'LEGACY_SAVED',
    raceCount: 1, extraRaceSteps: 50, settledAt: new Date(),
  } });
  const upcoming = await prisma.globalStepEvent.create({ data: {
    startsAt: new Date(f.now + 300000), endsAt: new Date(f.now + 600000), multiplier: 3,
  } });
  await run(f, 50);
  const warm = await run(f, 60);
  assert.equal(warm.score, 120);
  assert.deepEqual(planning(warm).value.globalEvents.map(e => e.id).sort(), [f.event.id, upcoming.id].sort());
  assert.equal(eventQueries(planning(warm)).length, 0);
});

for (const failure of ['malformed', 'expired', 'wrong-revision', 'partial-coverage']) {
  it(`${failure} cache data falls back without changing the HTTP score`, async () => {
    const f = await fixture();
    await run(f, 50);
    const keys = await cacheKeys('global');
    assert.ok(keys.length, 'cold worker must populate global scoring cache');
    for (const key of keys) {
      const payload = JSON.parse(await redis.get(key));
      if (failure === 'expired') { await redis.pexpire(key, 1); await delay(5); assert.equal(await redis.exists(key), 0); }
      else if (failure === 'malformed') await redis.set(key, '{bad');
      else {
        if (failure === 'wrong-revision') payload.catalogRevision = '0';
        else payload.coversThrough = f.now;
        await redis.set(key, JSON.stringify(payload), 'PX', 30000);
      }
    }
    const result = await run(f, 60);
    assert.equal(result.score, 120);
    assert.ok(eventQueries(planning(result)).length > 0);
  });
}

for (const mutation of ['catalog', 'entitlement', 'impact', 'late-impact', 'boundary', 'input']) {
  it(`old-writer ${mutation} mutation between planning and final fence cannot commit stale scoring`, async () => {
    const f = await fixture('LOCAL_ENTITLEMENTS');
    await run(f, 50);
    let changed = false;
    const result = await run(f, 60, async () => {
      if (changed) return;
      changed = true;
      if (mutation === 'catalog') await prisma.$executeRawUnsafe('UPDATE global_step_events SET multiplier=3 WHERE id=$1', f.event.id);
      if (mutation === 'entitlement') await prisma.$executeRawUnsafe("UPDATE global_step_event_entitlements SET start_outcome='PENDING', schedule_revision=schedule_revision+1 WHERE id=$1", f.entitlement.id);
      if (mutation === 'impact') await prisma.$executeRawUnsafe("UPDATE global_event_race_impacts SET id=id || '-moved' WHERE id=$1", f.impact.id);
      if (mutation === 'late-impact') await prisma.$executeRawUnsafe('DELETE FROM global_event_race_impacts WHERE id=$1', f.impact.id);
      if (mutation === 'boundary') await prisma.$executeRawUnsafe("UPDATE global_step_event_boundary_cursors SET boundary_at=boundary_at - interval '1 hour' WHERE key='global'");
      if (mutation === 'input') await upload(f, 70);
    });
    assert.equal(changed, true);
    assert.equal(result.score, mutation === 'catalog' ? 180 : ['entitlement', 'late-impact'].includes(mutation) ? 60 : mutation === 'input' ? 140 : 120);
    assert.ok(result.reads.some(r => r.transaction && eventQueries(r).length));
    const again = await run(f, 80);
    assert.equal(again.score, mutation === 'catalog' ? 240 : ['entitlement', 'late-impact'].includes(mutation) ? 80 : 160);
  });
}

it('negative local witness is invalidated by late impact; local-only miss uses one bounded set query', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  await prisma.globalEventRaceImpact.delete({ where: { id: f.impact.id } });
  await run(f, 50);
  const empty = await run(f, 60);
  assert.equal(empty.score, 60);
  assert.equal(eventQueries(planning(empty)).length, 0);
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: f.event.id, raceId: f.race.id, userId: f.account.user.id,
  } });
  const changed = await run(f, 70);
  assert.equal(changed.score, 140);
  assert.equal(eventQueries(planning(changed)).length, 1);
  assert.match(eventQueries(planning(changed))[0], /event-fingerprint:local/);
});

function spawnTick(extraEnv = {}) {
  let logs = '';
  const child = spawn(process.execPath, ['test/integration/fixtures/event-fingerprint-worker.cjs'], {
    env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', bytes => { logs += bytes; });
  child.stderr.on('data', bytes => { logs += bytes; });
  const result = new Promise((resolve, reject) => {
    let result;
    child.on('message', message => { result = message; });
    child.on('exit', code => code === 0 && result ? resolve(result) : reject(new Error(logs)));
    child.on('error', reject);
  });
  return { child, result };
}
async function score(f, headers = { 'X-Client-Features': '' }) {
  const res = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.account.token, headers });
  assert.equal(res.status, 200);
  return (await res.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps;
}

for (const failedCommands of [['MGET'], ['SET']]) {
  it(`real Redis command failure ${failedCommands} retains worker and old/current HTTP parity`, async () => {
    const { startRedisFailProxy } = require('./helpers/redisFailProxy');
    const proxy = await startRedisFailProxy(redisUrl.toString());
    try {
      const f = await fixture();
      if (failedCommands[0] === 'MGET') await run(f, 50);
      await upload(f, 60);
      proxy.arm(failedCommands);
      const result = await spawnTick({ REDIS_URL: proxy.url }).result;
      assert.equal(result.count, 1);
      assert.ok(proxy.failedCount() > 0);
      assert.ok(eventQueries(planning(result)).length >= 1);
      assert.ok(result.reads.some(r => r.transaction && eventQueries(r).length === 1));
      assert.equal(await score(f), 120);
      assert.equal(await score(f, { 'X-Client-Features': 'team_races,team_races_10v10_v1' }), 120);
      if (failedCommands[0] === 'SET') assert.equal((await cacheKeys()).length, 0);
    } finally { proxy.disarm(); await proxy.close(); }
  });
}

for (const pauseCommand of ['MGET', 'SET']) {
  it(`event mutation while a separate worker's ${pauseCommand} is in flight cannot install current stale proof`, async () => {
    const { holdRedisCommand } = require('./helpers/holdRedisCommand');
    const f = await fixture();
    await upload(f, 50);
    const proxy = await holdRedisCommand({ target: redisUrl.toString(), matches: args =>
      args[0].toUpperCase() === pauseCommand && args.some(a => a.includes('event-fingerprint:v4:')) });
    const worker = spawnTick({ REDIS_URL: proxy.url });
    try {
      await Promise.race([proxy.waiting, delay(5000).then(() => { throw new Error('cache command was never observed'); })]);
      await prisma.$executeRawUnsafe('UPDATE global_step_events SET multiplier=3 WHERE id=$1', f.event.id);
      proxy.release();
      const result = await worker.result;
      assert.equal(result.count, 1);
      assert.equal(await score(f), 150);
      const warm = await run(f, 60);
      assert.equal(warm.score, 180);
      assert.equal(planning(warm).value.globalEvents.find(e => e.id === f.event.id).multiplier, 3);
      assert.ok(result.reads.some(r => r.transaction && eventQueries(r).length));
    } finally { proxy.release(); if (worker.child.exitCode === null) worker.child.kill('SIGTERM'); await proxy.close(); }
  });
}

it('microsecond event, race, and cursor timestamps conservatively retain exact SQL', async () => {
  for (const table of ['global_step_events', 'races', 'global_step_event_boundary_cursors']) {
    await cleanDatabase();
    const column = table === 'global_step_events' ? 'starts_at' : table === 'races' ? 'started_at' : 'boundary_at';
    // Shipped columns have millisecond precision. Widen only this disposable
    // fixture to exercise a future/imported sub-ms value through the real DB.
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE timestamp(6)`);
    try {
    const f = await fixture();
    if (table === 'global_step_events') await prisma.$executeRawUnsafe("UPDATE global_step_events SET starts_at=starts_at + interval '1 microsecond' WHERE id=$1", f.event.id);
    if (table === 'races') await prisma.$executeRawUnsafe("UPDATE races SET started_at=started_at + interval '1 microsecond' WHERE id=$1", f.race.id);
    if (table === 'global_step_event_boundary_cursors') await prisma.$executeRawUnsafe("UPDATE global_step_event_boundary_cursors SET boundary_at=boundary_at + interval '1 microsecond' WHERE key='global'");
    await upload(f, 50);
    const result = await spawnTick().result;
    assert.equal(await score(f), 100);
    assert.ok(eventQueries(planning(result)).length >= 1);
    await upload(f, 60);
    const second = await spawnTick().result;
    assert.ok(eventQueries(planning(second)).length >= 1);
    assert.equal(await score(f), 120);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE timestamp(3)`); }
  }
});

it('SQL text collation, duplicate IDs, and impact history for inactive members survive cache reuse', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const other = await createTestUser();
  await prisma.raceParticipant.create({ data: { raceId: f.race.id, userId: other.user.id, status: 'DECLINED', joinedAt: f.race.startedAt } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: f.event.id, userId: other.user.id, timezone: 'UTC', localDate: '2026-09-11',
    startsAt: f.event.startsAt, endsAt: f.event.endsAt, startOutcome: 'ACTIVATED_ON_TIME',
  } });
  await prisma.globalEventRaceImpact.create({ data: { eventId: f.event.id, raceId: f.race.id, userId: other.user.id } });
  const tied = await prisma.globalStepEvent.createMany({ data: ['é_event', 'Z_event', 'a_event'].map(id => ({
    id, startsAt: new Date(f.now + 300000), endsAt: new Date(f.now + 400000),
  })) });
  assert.equal(tied.count, 3);
  const cold = await run(f, 50);
  const warm = await run(f, 60);
  assert.equal(warm.score, 120);
  assert.equal(planning(cold).queries.length, 4, 'cold tied windows populate the canonical cache');
  assert.equal(planning(warm).queries.length, 3, 'warm tied windows reuse the canonical cache');
  assert.deepEqual(json(planning(warm).value.globalEvents), json(planning(cold).value.globalEvents));
  assert.equal(planning(warm).value.globalEvents.filter(e => e.id === f.event.id).length, 2);
  assert.ok(planning(warm).value.globalEvents.some(e => e.userId === other.user.id));
  assert.equal(eventQueries(planning(warm)).length, 0, 'unique entitlement/impact keys resolve tied event windows');
  assert.deepEqual(json(planning(warm).value.globalEvents), json(warm.reads.find(r => r.transaction).value.globalEvents));
});

for (const corrupt of ['event-null', 'boundary-null']) {
  it(`checksummed ${corrupt} cache corruption fails closed through worker HTTP`, async () => {
    const f = await fixture();
    await run(f, 50);
    const key = (await cacheKeys('global'))[0];
    assert.ok(key);
    const { checksum, ...payload } = JSON.parse(await redis.get(key));
    if (corrupt === 'event-null') payload.events = [null];
    else payload.pendingBoundaries = [null];
    payload.checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await redis.set(key, JSON.stringify(payload), 'PX', 30000);
    const result = await run(f, 60);
    assert.equal(result.score, 120);
    assert.ok(planning(result));
    assert.ok(eventQueries(planning(result)).length > 0);
  });
}

for (const model of ['globalEventRaceImpact', 'globalStepEventEntitlement']) {
  it(`${model} same-ID delete/reinsert cannot reuse an ABA witness`, async () => {
    const f = await fixture('LOCAL_ENTITLEMENTS');
    await run(f, 50);
    const id = model === 'globalEventRaceImpact' ? f.impact.id : f.entitlement.id;
    const old = await prisma[model].findUniqueOrThrow({ where: { id } });
    await prisma[model].delete({ where: { id } });
    await prisma[model].create({ data: { ...old,
      ...(model === 'globalEventRaceImpact' ? {} : { startOutcome: 'PENDING' }),
    } });
    const result = await run(f, 60);
    assert.ok(eventQueries(planning(result)).length > 0, 'reinsert must invalidate at planning, before the raw transaction fence');
    assert.equal(result.score, model === 'globalEventRaceImpact' ? 120 : 60);
    const fresh = await prisma[model].findUniqueOrThrow({ where: { id } });
    assert.notEqual(fresh.fingerprintIncarnation, old.fingerprintIncarnation);
    assert.ok(fresh.fingerprintIncarnation);
  });
}

it('maintained witness count and version bytes do not grow with impact history', async t => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const more = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), appleId: randomUUID(), displayName: 'Witness '+i }));
  await prisma.user.createMany({ data: more });
  await prisma.raceParticipant.createMany({ data: more.map(u => ({ raceId: f.race.id, userId: u.id, status: 'ACCEPTED', joinedAt: f.race.startedAt })) });
  await prisma.globalEventRaceImpact.createMany({ data: more.map(u => ({ eventId: f.event.id, raceId: f.race.id, userId: u.id })) });
  const first = await run(f, 50);
  const observed = planning(first);
  assert.equal(observed.witnesses[0].count, 101);
  assert.match(observed.witnesses[0].incarnation, /^[0-9a-f-]{36}$/);
  assert.match(observed.witnesses[0].revision, /^\d+$/);
  assert.ok(observed.witnessJsonBytes < 110 * 101, 'returned witness is a fixed digest/count, not impact_count × participant_count');
  assert.ok(observed.witnesses.every(w => !Array.isArray(w)));
  t.diagnostic(JSON.stringify({ participants: 101, impacts: 101, rosterJsonBytes: observed.rosterJsonBytes,
    witnessJsonBytes: observed.witnessJsonBytes }));
});

it('local triggers are transactional and race scoped, including persisted relocation and bulk changes', async () => {
  const a = await fixture('LOCAL_ENTITLEMENTS');
  const b = await fixture('LOCAL_ENTITLEMENTS');
  await run(a, 50);
  await run(b, 50);
  const revisions = () => prisma.$queryRawUnsafe('SELECT id, fingerprint_revision::text AS revision FROM global_step_event_entitlements ORDER BY id');
  const before = await revisions();
  const [catalog] = await prisma.$queryRawUnsafe('SELECT revision::text FROM event_catalog_revision WHERE id=1');
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("UPDATE global_step_event_entitlements SET timezone='Pacific/Auckland', schedule_revision=schedule_revision+1 WHERE id=$1", a.entitlement.id);
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(await revisions(), before);
  await prisma.$executeRawUnsafe("UPDATE global_step_event_entitlements SET timezone='Pacific/Auckland', local_date='2026-11-01', schedule_revision=schedule_revision+1 WHERE id=$1", a.entitlement.id);
  const after = await revisions();
  assert.ok(BigInt(after.find(r => r.id === a.entitlement.id).revision) > BigInt(before.find(r => r.id === a.entitlement.id).revision));
  assert.equal(after.find(r => r.id === b.entitlement.id).revision, before.find(r => r.id === b.entitlement.id).revision);
  assert.deepEqual((await prisma.$queryRawUnsafe('SELECT revision::text FROM event_catalog_revision WHERE id=1'))[0], catalog,
    'local writes cannot contend on a shared catalog revision');
  assert.equal((await run(a, 60)).score, 120, 'persisted entitlement timestamps stay authoritative after timezone change');
});

it('empty local split executes zero parent-table scans, measured by the real query plan', async t => {
  const f = await fixture();
  await run(f, 50);
  const keys = await cacheKeys('local');
  await redis.del(...keys);
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  const statement = planning(result).statements.find(s => s.sql.includes('event-fingerprint:local'));
  assert.ok(statement);
  const [explain] = await prisma.$queryRawUnsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + statement.sql, ...statement.params);
  const plan = explain['QUERY PLAN'][0];
  const nodes = [];
  function visit(node) { nodes.push(node); for (const child of node.Plans || []) visit(child); }
  visit(plan.Plan);
  const parentScans = nodes.filter(n => n['Relation Name'] === 'global_step_events');
  assert.ok(parentScans.every(n => n['Actual Loops'] === 0));
  t.diagnostic(JSON.stringify({ emptyLocalParentScanLoops: parentScans.map(n => n['Actual Loops']),
    localSplitExecutionMs: plan['Execution Time'], sharedHitBlocks: plan.Plan['Shared Hit Blocks'] }));
});

it('database epoch separates matching revision numbers from an unrelated cache namespace', async () => {
  const f = await fixture();
  await run(f, 50);
  const [old] = await prisma.$queryRawUnsafe('SELECT epoch::text FROM event_catalog_revision WHERE id=1');
  await prisma.$executeRawUnsafe('UPDATE event_catalog_revision SET epoch=gen_random_uuid() WHERE id=1');
  const [fresh] = await prisma.$queryRawUnsafe('SELECT epoch::text FROM event_catalog_revision WHERE id=1');
  assert.notEqual(fresh.epoch, old.epoch);
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  assert.equal(eventQueries(planning(result)).length, 1);
  const keys = await cacheKeys('global');
  assert.ok(keys.some(k => k.includes(old.epoch)));
  assert.ok(keys.some(k => k.includes(fresh.epoch)));
});

it('DB tuple accounting includes trigger costs: local stamp updates no other row; parent mutation updates one catalog row', async t => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const reports = [];
  const tupleStats = async () => (await client.query(`SELECT relname,n_tup_ins::int,n_tup_upd::int,n_tup_del::int
    FROM pg_stat_xact_user_tables WHERE relname IN ('global_event_race_impacts','global_step_event_entitlements',
      'global_step_events','event_catalog_revision') ORDER BY relname`)).rows;
  try {
    for (const kind of ['impact', 'entitlement', 'catalog']) {
      await client.query('BEGIN');
      const before = await tupleStats();
      const statement = kind === 'impact' ? ["UPDATE global_event_race_impacts SET id=id || '-moved' WHERE id=$1", f.impact.id] :
        kind === 'entitlement' ? ["UPDATE global_step_event_entitlements SET schedule_revision=schedule_revision+1 WHERE id=$1", f.entitlement.id] :
          ['UPDATE global_step_events SET multiplier=3 WHERE id=$1', f.event.id];
      const result = await client.query('EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ' + statement[0], [statement[1]]);
      const stats = (await tupleStats()).map(row => ({ relname: row.relname,
        ...Object.fromEntries(['n_tup_ins','n_tup_upd','n_tup_del'].map(k =>
          [k, row[k] - before.find(b => b.relname === row.relname)[k]])) }));
      const catalog = stats.find(r => r.relname === 'event_catalog_revision');
      assert.equal(catalog.n_tup_upd, kind === 'catalog' ? 1 : 0);
      const localTable = kind === 'impact' ? 'global_event_race_impacts' : 'global_step_event_entitlements';
      if (kind !== 'catalog') assert.equal(stats.find(r => r.relname === localTable).n_tup_upd, 1,
        'BEFORE trigger stamps the original tuple rather than issuing an extra UPDATE');
      const plan = result.rows[0]['QUERY PLAN'][0];
      reports.push({ kind, tupleWrites: stats, executionMs: plan['Execution Time'], triggers: plan.Triggers });
      await client.query('ROLLBACK');
    }
  } finally { await client.query('ROLLBACK'); await client.end(); }
  t.diagnostic(JSON.stringify(reports));
});

it('tied local events reuse a canonical cache vector through sync, refresh, and final scoring', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const other = await createTestUser({ timezone: 'UTC' });
  await prisma.raceParticipant.create({ data: {
    raceId: f.race.id, userId: other.user.id, status: 'ACCEPTED', joinedAt: f.race.startedAt,
  } });
  await prisma.globalStepEventEntitlement.create({ data: {
    eventId: f.event.id, userId: other.user.id, timezone: 'UTC',
    localDate: f.event.startsAt.toISOString().slice(0, 10), startsAt: f.event.startsAt,
    endsAt: f.event.endsAt, startOutcome: 'ACTIVATED_ON_TIME',
  } });
  await prisma.globalEventRaceImpact.create({ data: {
    eventId: f.event.id, raceId: f.race.id, userId: other.user.id,
  } });
  const cold = await run(f, 50);
  const warm = await run(f, 60);
  assert.equal(cold.score, 100);
  assert.equal(warm.score, 120);
  assert.equal(eventQueries(planning(warm)).length, 0, 'tied participants must hit the event cache');
  assert.equal(planning(warm).queries.length, 3);
  assert.equal(planning(warm).value.globalEvents.length, 2);
  assert.deepEqual(json(planning(warm).value.globalEvents), json(warm.reads.find(r => r.transaction).value.globalEvents));
  const expected = await prisma.$queryRawUnsafe(`SELECT entitlement.id AS "entitlementId"
    FROM global_step_event_entitlements entitlement
    JOIN global_event_race_impacts impact ON impact.event_id=entitlement.event_id AND impact.user_id=entitlement.user_id
    WHERE impact.race_id=$1 ORDER BY entitlement.starts_at,entitlement.event_id,
      entitlement.id,impact.id,entitlement.user_id`, f.race.id);
  assert.deepEqual(planning(warm).value.globalEvents.map(e => e.entitlementId), expected.map(e => e.entitlementId));
  await redis.del(...await cacheKeys('local'));
  const refreshed = await run(f, 70);
  assert.equal(refreshed.score, 140);
  assert.equal(eventQueries(planning(refreshed)).length, 1);
  assert.match(eventQueries(planning(refreshed))[0], /event-fingerprint:local/);
  assert.deepEqual(json(planning(refreshed).value.globalEvents), json(refreshed.reads.find(r => r.transaction).value.globalEvents));
  let changed = false;
  const raced = await run(f, 80, async () => {
    if (changed) return;
    changed = true;
    await prisma.$executeRawUnsafe('UPDATE global_step_events SET multiplier=3 WHERE id=$1', f.event.id);
  });
  assert.equal(changed, true);
  assert.equal(raced.score, 240, 'the final fence must reject the old cached multiplier');
  assert.equal(await score(f, { 'X-Client-Features': 'race-display-clock-v1' }), 240);
});

it('versioned event ordering ignores old cache vectors even with valid checksums', async () => {
  const f = await fixture();
  await run(f, 50);
  const keys = await cacheKeys();
  assert.ok(keys.length);
  for (const key of keys) {
    const { checksum, ...payload } = JSON.parse(await redis.get(key));
    assert.equal(payload.schema, 4, 'race-version proofs require an isolated cache schema');
    payload.schema = 2;
    payload.events = payload.events.map(row => ({ ...row, multiplier: 99 }));
    payload.checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await redis.set(key.replace('event-fingerprint:v4:', 'event-fingerprint:v2:'), JSON.stringify(payload), 'PX', 30000);
    await redis.del(key);
  }
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  assert.ok(eventQueries(planning(result)).length > 0, 'the v2 namespace must not warm v4');
  assert.ok((await cacheKeys()).every(key => key.includes('event-fingerprint:v4:')));
});


it('warm event proof reads one durable race version without traversing impacts or entitlements', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  await run(f, 50);
  const warm = await run(f, 60);
  assert.equal(warm.score, 120);
  const roster = planning(warm).queries.find(q => q.includes('AS "r_id"'));
  assert.match(roster, /race_event_fingerprint_versions/);
  assert.doesNotMatch(roster, /global_event_race_impacts|global_step_event_entitlements|jsonb_agg|sha256/);
  assert.equal(planning(warm).queries.length, 3);
  assert.ok(warm.reads.some(r => r.transaction && eventQueries(r).length === 1));
});


const raceVersion = async raceId => (await prisma.$queryRawUnsafe(
  'SELECT incarnation::text,revision::text,impact_count::int AS count FROM race_event_fingerprint_versions WHERE race_id=$1', raceId))[0];

it('bulk impact writes advance each race once, maintain counts, and ignore lease/no-op changes', async t => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const users = Array.from({ length: 25 }, () => ({ id: randomUUID(), appleId: randomUUID(), displayName: 'Version '+randomUUID() }));
  await prisma.user.createMany({ data: users });
  const before = await raceVersion(f.race.id);
  await prisma.globalEventRaceImpact.createMany({ data: users.map(u => ({ eventId: f.event.id, raceId: f.race.id, userId: u.id })) });
  const after = await raceVersion(f.race.id);
  assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
  assert.equal(after.count, 26);
  await prisma.$executeRawUnsafe('UPDATE global_event_race_impacts SET updated_at=CURRENT_TIMESTAMP WHERE race_id=$1', f.race.id);
  await prisma.$executeRawUnsafe('UPDATE global_step_event_entitlements SET updated_at=CURRENT_TIMESTAMP WHERE event_id=$1', f.event.id);
  assert.deepEqual(await raceVersion(f.race.id), after);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('DELETE FROM global_event_race_impacts WHERE race_id=$1', f.race.id);
    throw new Error('version rollback');
  }), /version rollback/);
  assert.deepEqual(await raceVersion(f.race.id), after);
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  t.diagnostic(JSON.stringify({ bulkImpacts: 25, raceVersionUpdates: 1, pairGuardWrites: 25 }));
});

it('impact relocation invalidates both races and maintains their exact counts', async () => {
  const a = await fixture('LOCAL_ENTITLEMENTS');
  const b = await fixture('LOCAL_ENTITLEMENTS');
  await run(a, 50);
  await run(b, 50);
  const beforeA = await raceVersion(a.race.id), beforeB = await raceVersion(b.race.id);
  await prisma.$executeRawUnsafe('UPDATE global_event_race_impacts SET race_id=$1 WHERE id=$2', b.race.id, a.impact.id);
  assert.equal((await raceVersion(a.race.id)).count, 0);
  assert.equal((await raceVersion(b.race.id)).count, 2);
  assert.equal(BigInt((await raceVersion(a.race.id)).revision), BigInt(beforeA.revision) + 1n);
  assert.equal(BigInt((await raceVersion(b.race.id)).revision), BigInt(beforeB.revision) + 1n);
  const result = await run(a, 60);
  assert.equal(result.score, 60);
  assert.equal(eventQueries(planning(result)).length, 1);
});

it('missing race-version state falls back to SQL and never treats a missing version as an empty event vector', async () => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  await run(f, 50);
  await prisma.$executeRawUnsafe('DELETE FROM race_event_fingerprint_versions WHERE race_id=$1', f.race.id);
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  assert.equal(eventQueries(planning(result)).length, 1);
});

for (const first of ['impact', 'entitlement']) {
  it(`concurrent ${first}-first mutation cannot miss race invalidation during pair discovery`, async () => {
    const { Client } = require('pg');
    const f = await fixture('LOCAL_ENTITLEMENTS');
    await prisma.globalEventRaceImpact.delete({ where: { id: f.impact.id } });
    await run(f, 50);
    const clients = [new Client({ connectionString: process.env.DATABASE_URL }), new Client({ connectionString: process.env.DATABASE_URL })];
    await Promise.all(clients.map(c => c.connect()));
    const statements = {
      impact: ['INSERT INTO global_event_race_impacts (id,event_id,race_id,user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,now(),now())', [randomUUID(), f.event.id, f.race.id, f.account.user.id]],
      entitlement: ["UPDATE global_step_event_entitlements SET start_outcome='PENDING' WHERE id=$1", [f.entitlement.id]],
    };
    let pending;
    try {
      await clients[0].query('BEGIN'); await clients[1].query('BEGIN');
      await clients[0].query(...statements[first]);
      const [pid] = (await clients[1].query('SELECT pg_backend_pid() AS pid')).rows;
      pending = clients[1].query(...statements[first === 'impact' ? 'entitlement' : 'impact']);
      let blocked = false;
      for (let i=0; i<100; i++) {
        const [state] = await prisma.$queryRawUnsafe('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', pid.pid);
        if (state.wait_event_type === 'Lock') { blocked = true; break; }
        await delay(10);
      }
      assert.ok(blocked, 'the overlapping pair must serialize, not silently miss an uncommitted impact');
      await clients[0].query('COMMIT');
      await pending;
      const beforeSecondCommit = await raceVersion(f.race.id);
      await clients[1].query('COMMIT');
      assert.ok(BigInt((await raceVersion(f.race.id)).revision) > BigInt(beforeSecondCommit.revision));
      assert.equal((await raceVersion(f.race.id)).count, 1);
      const result = await run(f, 60);
      assert.equal(result.score, 60);
      assert.equal(eventQueries(planning(result)).length, 1, 'planning must invalidate, not merely rely on the final fence');
    } finally {
      await clients[0].query('ROLLBACK');
      await pending?.catch(() => {});
      await clients[1].query('ROLLBACK');
      await Promise.all(clients.map(c => c.end()));
    }
  });
}


it('repeatable-read pair discovery fails with serialization conflict rather than missing a committed impact', async () => {
  const { Client } = require('pg');
  const f = await fixture('LOCAL_ENTITLEMENTS');
  await prisma.globalEventRaceImpact.delete({ where: { id: f.impact.id } });
  const a = new Client({ connectionString: process.env.DATABASE_URL });
  const b = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([a.connect(), b.connect()]);
  try {
    await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await b.query('SELECT count(*) FROM global_event_race_impacts');
    await a.query('INSERT INTO global_event_race_impacts (id,event_id,race_id,user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,now(),now())', [randomUUID(),f.event.id,f.race.id,f.account.user.id]);
    await assert.rejects(b.query("UPDATE global_step_event_entitlements SET start_outcome='PENDING' WHERE id=$1", [f.entitlement.id]), { code: '40001' });
    await b.query('ROLLBACK');
    await b.query("UPDATE global_step_event_entitlements SET start_outcome='PENDING' WHERE id=$1", [f.entitlement.id]);
    const result = await run(f, 60);
    assert.equal(result.score, 60);
  } finally { await b.query('ROLLBACK'); await Promise.all([a.end(), b.end()]); }
});

it('set-based entitlement changes account for pair guards and exactly one version update per affected race', async t => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const { Client } = require('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const stats = async () => (await c.query("SELECT relname,n_tup_ins::int AS ins,n_tup_upd::int AS upd FROM pg_stat_xact_user_tables WHERE relname IN ('global_step_event_entitlements','event_fingerprint_pair_versions','race_event_fingerprint_versions') ORDER BY relname")).rows;
    const before = await stats();
    const plan = (await c.query('EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) UPDATE global_step_event_entitlements SET schedule_revision=schedule_revision+1 WHERE id=$1', [f.entitlement.id])).rows[0]['QUERY PLAN'][0];
    const delta = (await stats()).map((r,i) => ({ table:r.relname, inserts:r.ins-before[i].ins, updates:r.upd-before[i].upd }));
    assert.deepEqual(delta.map(r => r.updates), [1,1,1]);
    t.diagnostic(JSON.stringify({ writeCost: delta, executionMs: plan['Execution Time'], triggers: plan.Triggers }));
  } finally { await c.query('ROLLBACK'); await c.end(); }
});

it('matched roster plans eliminate history-dependent buffer accesses while preserving the HTTP score', async t => {
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const users = Array.from({ length: 512 }, () => ({ id: randomUUID(), appleId: randomUUID(), displayName: randomUUID() }));
  await prisma.user.createMany({ data: users });
  await prisma.globalEventRaceImpact.createMany({ data: users.map(u => ({ eventId:f.event.id, raceId:f.race.id, userId:u.id })) });
  await run(f, 50);
  const result = await run(f, 60);
  assert.equal(result.score, 120);
  const statement = planning(result).statements.find(s => s.sql.includes('AS "r_id"'));
  const oldCte = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/event-fingerprint-legacy-proof.sql'), 'utf8');
  const oldSql = 'WITH '+oldCte+' '+statement.sql.slice(statement.sql.indexOf('SELECT race.id AS "r_id"'));
  const plans = {};
  for (const [kind,sql] of [['legacy',oldSql],['version',statement.sql]]) {
    const [row] = await prisma.$queryRawUnsafe('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql, ...statement.params);
    const plan = row['QUERY PLAN'][0];
    plans[kind] = { executionMs:plan['Execution Time'], buffers:plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks'] };
  }
  assert.ok(plans.version.buffers < plans.legacy.buffers, 'the new read must actually access fewer blocks');
  t.diagnostic(JSON.stringify({ impacts:513, rosterParticipants:1, matchedProofRead:plans }));
});

for (const parent of ['races','global_step_events','users']) {
  it(`parent ${parent} identity relocation preserves guard discovery and exact race counts`, async () => {
    const f = await fixture('LOCAL_ENTITLEMENTS');
    await run(f, 50);
    const previous = parent === 'races' ? f.race.id : parent === 'users' ? f.account.user.id : f.event.id;
    const replacement = randomUUID();
    if (parent !== 'global_step_events') {
      // Existing immutable-source FK contracts already reject these identities.
      const before = await raceVersion(f.race.id);
      await assert.rejects(prisma.$executeRawUnsafe(`UPDATE ${parent} SET id=$1 WHERE id=$2`, replacement, previous),
        error => error.message.includes(parent === 'races' ? 'race_accepted_participant_counts_race_id_fkey' : 'user_scoring_input_versions_user_id_fkey'));
      assert.deepEqual(await raceVersion(f.race.id), before);
      assert.equal((await run(f, 60)).score, 120);
      return;
    }
    await prisma.$executeRawUnsafe(`UPDATE ${parent} SET id=$1 WHERE id=$2`, replacement, previous);
    if (parent === 'races') f.race.id = replacement;
    if (parent === 'global_step_events') f.event.id = replacement;
    if (parent === 'users') {
      // The old authentication subject is intentionally invalid after identity
      // relocation. Verify the database invariant, then restore for HTTP proof.
      await prisma.$executeRawUnsafe('UPDATE users SET id=$1 WHERE id=$2', previous, replacement);
    }
    assert.equal((await raceVersion(f.race.id)).count, 1);
    const result = await run(f, 60);
    assert.equal(result.score, 120);
  });
}

for (const table of ['global_event_race_impacts','global_step_event_entitlements']) {
  it(`${table} maintenance truncation invalidates warm vectors`, async () => {
    const f = await fixture('LOCAL_ENTITLEMENTS');
    await run(f, 50);
    const before = await raceVersion(f.race.id);
    await prisma.$executeRawUnsafe(`TRUNCATE ${table} CASCADE`);
    const after = await raceVersion(f.race.id);
    assert.ok(BigInt(after.revision) > BigInt(before.revision));
    assert.equal(after.count, table === 'global_event_race_impacts' ? 0 : 1);
    const result = await run(f, 60);
    assert.equal(result.score, 60);
    assert.equal(eventQueries(planning(result)).length, 1);
  });
}

it('account deletion cleans only its pair guards and leaves another account cache usable', async () => {
  const a = await fixture('LOCAL_ENTITLEMENTS'), b = await fixture('LOCAL_ENTITLEMENTS');
  await run(a, 50); await run(b, 50);
  const beforeB = await raceVersion(b.race.id);
  const deleted = await request(baseUrl, 'DELETE', '/auth/account', { token:a.account.token });
  assert.equal(deleted.status, 204);
  assert.deepEqual(await prisma.$queryRawUnsafe('SELECT user_id FROM event_fingerprint_pair_versions WHERE user_id=$1', a.account.user.id), []);
  assert.equal((await raceVersion(a.race.id)).count, 0);
  assert.deepEqual(await raceVersion(b.race.id), beforeB);
  const result = await run(b, 60);
  assert.equal(result.score, 120);
  assert.equal(eventQueries(planning(result)).length, 0);
});

it('overlapping impact deletion and entitlement change recover from a real database deadlock without version drift', async () => {
  const { Client } = require('pg');
  const f = await fixture('LOCAL_ENTITLEMENTS');
  const a = new Client({ connectionString:process.env.DATABASE_URL }), b = new Client({ connectionString:process.env.DATABASE_URL });
  await Promise.all([a.connect(),b.connect()]);
  let second;
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query("SET LOCAL deadlock_timeout='100ms'"); await b.query("SET LOCAL deadlock_timeout='100ms'");
    await a.query('DELETE FROM global_event_race_impacts WHERE id=$1', [f.impact.id]);
    const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    second = b.query("UPDATE global_step_event_entitlements SET start_outcome='PENDING' WHERE id=$1", [f.entitlement.id]).then(() => null, e => e);
    let blocked = false;
    for (let i=0;i<100;i++) {
      const [state] = await prisma.$queryRawUnsafe('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', pid);
      if (state.wait_event_type === 'Lock') { blocked=true; break; }
      await delay(10);
    }
    assert.ok(blocked);
    const firstError = await a.query('DELETE FROM global_step_event_entitlements WHERE id=$1',[f.entitlement.id]).then(() => null, e => e);
    await a.query(firstError ? 'ROLLBACK' : 'COMMIT');
    const secondError = await second;
    await b.query(secondError ? 'ROLLBACK' : 'COMMIT');
    assert.equal([firstError,secondError].filter(Boolean).length,1);
    assert.equal((firstError || secondError).code,'40P01');
    if (firstError) {
      await a.query('BEGIN');
      await a.query('DELETE FROM global_event_race_impacts WHERE id=$1',[f.impact.id]);
      await a.query('DELETE FROM global_step_event_entitlements WHERE id=$1',[f.entitlement.id]);
      await a.query('COMMIT');
    }
    assert.equal((await raceVersion(f.race.id)).count,0);
    assert.equal((await run(f,60)).score,60);
  } finally {
    await a.query('ROLLBACK'); await second;
    await b.query('ROLLBACK'); await Promise.all([a.end(),b.end()]);
  }
});
