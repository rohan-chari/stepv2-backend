// Real scheduler + PostgreSQL + HTTP intake/progress. SQL observation forwards
// every call unchanged; budgets measure work, not hardware-dependent timings.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { buildLocalGlobalStepEventTick } = require('../../src/modules/steps/jobs/globalStepEventScheduler');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
let server;
async function recapCount(eventId) {
  return (await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM event_recaps WHERE event_id=$1', eventId))[0].n;
}
after(async () => { if (server) await server.close(); await prisma.$disconnect(); });
const logger = { log() {}, error() {} };

async function fixture(size) {
  await cleanDatabase();
  server ||= await getSharedServer();
  const account = await createTestUser({ timezone: 'UTC' });
  const users = [account.user, ...Array.from({ length: size - 1 }, () => ({ id: randomUUID(), appleId: randomUUID(), timezone: 'UTC' }))];
  await prisma.user.createMany({ data: users.slice(1) });
  const current = new Date();
  const startedAt = new Date(+current - 3 * 3600000);
  const races = [];
  for (let i = 0; i < 2; i++) {
    const race = await prisma.race.create({ data: {
      creatorId: account.user.id, name: `End burst ${i}`, status: 'ACTIVE',
      startedAt, endsAt: new Date(+current + 86400000), targetSteps: 1000000,
      maxParticipants: Math.max(50, size), powerupsEnabled: false, timezone: 'UTC',
    } });
    await prisma.raceParticipant.createMany({ data: users.map(user => ({
      raceId: race.id, userId: user.id, status: 'ACCEPTED', joinedAt: startedAt,
    })) });
    races.push(race);
  }
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt: new Date(+current - 3600000), endsAt: new Date(+current - 1800000),
    scheduleMode: 'LOCAL_ENTITLEMENTS', multiplier: 2,
    eventDay: current.toISOString().slice(0, 10), localStartMinute: 600,
    durationMinutes: 30, schedulePolicyVersion: 1,
  } });
  await prisma.globalStepEventEntitlement.createMany({ data: users.map(user => ({
    eventId: event.id, userId: user.id, timezone: 'UTC',
    localDate: current.toISOString().slice(0, 10), startsAt: event.startsAt,
    endsAt: event.endsAt, startOutcome: 'ACTIVATED_ON_TIME', startProcessedAt: event.startsAt,
    recapRaceCount: 2, recapCountPolicyVersion: 1, recapWindowRevision: 0,
  })) });
  await prisma.globalEventRaceImpact.createMany({ data: users.flatMap(user => races.map(race => ({
    eventId: event.id, userId: user.id, raceId: race.id,
  }))) });
  const body = { date: current.toISOString().slice(0, 10), steps: 100, samples: [{
    periodStart: new Date(+current - 7200000).toISOString(),
    periodEnd: new Date(+current - 5400000).toISOString(), steps: 100,
  }] };
  const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
    token: account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' }, body,
  });
  assert.equal(response.status, 202, await response.text());
  return { account, users, races, event, current, body };
}

async function observe(t, run) {
  const queries = [];
  const original = Client.prototype.query;
  const spy = t.mock.method(Client.prototype, 'query', function (...args) {
    const config = args[0];
    queries.push(typeof config === 'string' ? config : config?.text || '');
    return original.apply(this, args);
  });
  const start = performance.now();
  try { await run(); } finally { spy.mock.restore(); }
  return { queries, elapsedMs: performance.now() - start };
}

for (const size of [10, 40]) test(`end cohort ${size}: bounded queue writes preserve HTTP totals without recap jobs`, { timeout: 90000 }, async t => {
  const f = await fixture(size);
  const before = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: f.races.map(r => r.id) } } });
  const result = await observe(t, buildLocalGlobalStepEventTick({ now: () => f.current, logger }));
  const ended = await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } });
  assert.equal(ended, size, 'one scheduler tick finishes the bounded cohort');
  assert.equal(await recapCount(f.event.id), 0, 'end processing never calculates recaps');
  assert.ok(!result.queries.some(q => /global_event_summary_work|durable_capture_/.test(q)), 'no retired worker writes');
  const jobs = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: f.races.map(r => r.id) } } });
  const bumps = jobs.map(j => j.generation - before.find(b => b.raceId === j.raceId).generation);
  const queueWrites = result.queries.filter(q => /INSERT INTO race_resolution_jobs_v2/.test(q) && /ON CONFLICT \(race_id\) DO UPDATE/.test(q)).length;
  console.log(JSON.stringify({ experiment: 'end-cohort', size, queries: result.queries.length, queueWrites, bumps, elapsedMs: result.elapsedMs }));
  // Exercise the real resolution worker and both frozen/current HTTP contracts
  // before the performance assertions, so the red run proves correct fixtures.
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  const downstream = await observe(t, async () => { for (const race of f.races) {
    assert.ok(await worker.processRace({ raceId: race.id }));
    for (const features of ['', 'powerups2,powerups3,powerups4,powerups5']) {
      const res = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, {
        token: f.account.token, headers: { 'X-Timezone': 'UTC', 'X-Client-Features': features },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 100);
    }
  } });
  console.log(JSON.stringify({ experiment: 'end-cohort-downstream', size, queries: downstream.queries.length, elapsedMs: downstream.elapsedMs }));
  const replay = await observe(t, buildLocalGlobalStepEventTick({ now: () => f.current, logger }));
  assert.equal(replay.queries.filter(q => /INSERT INTO race_resolution_jobs_v2/.test(q) && /ON CONFLICT \(race_id\) DO UPDATE/.test(q)).length, 0);
  assert.equal(await recapCount(f.event.id), 0, 'recaps are calculated only by an eligible app open');
  assert.ok(queueWrites <= 1, `shared races need one batch enqueue, observed ${queueWrites}`);
  assert.ok(bumps.every(n => n <= 1), `at most one new generation per shared race, observed ${bumps}`);
  assert.ok(result.queries.length <= 45, `cohort work must be bounded rather than per-user: ${result.queries.length}`);
});

test('concurrent end schedulers and a fresh HTTP sync retain every participant and latest steps', { timeout: 90000 }, async t => {
  const f = await fixture(40);
  const tick = buildLocalGlobalStepEventTick({ now: () => f.current, logger });
  const result = await observe(t, async () => {
    const [, , response] = await Promise.all([tick(), tick(), request(server.baseUrl, 'POST', '/steps/sync-v2', {
      token: f.account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
      body: { ...f.body, steps: 175, samples: f.body.samples.map(s => ({ ...s, steps: 175 })) },
    })]);
    assert.equal(response.status, 202, await response.text());
  });
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } }), 40);
  assert.equal(await recapCount(f.event.id), 0, 'recaps are calculated only by an eligible app open');
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  for (const race of f.races) {
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: race.id } });
    assert.ok(job.dirtyReasons.includes('GLOBAL_EVENT_BOUNDARY'));
    assert.ok(job.dirtyReasons.includes('FULL') || f.users.every(user => job.triggeredByUserIds.includes(user.id)), 'merged scope covers the entire cohort');
    assert.ok(await worker.processRace({ raceId: race.id }));
    const response = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, { token: f.account.token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 175);
  }
  const enqueues = result.queries.filter(q => /INSERT INTO race_resolution_jobs_v2/.test(q) && /ON CONFLICT \(race_id\) DO UPDATE/.test(q)).length;
  assert.ok(enqueues <= 2, `one end batch plus one HTTP sync, not one per scheduler/user: ${enqueues}`);
});

test('failure after end stamping rolls back queue; a later scheduler retries exactly once without recap work', { timeout: 90000 }, async t => {
  const f = await fixture(10);
  const before = await prisma.raceResolutionJobV2.findMany({ where: { raceId: { in: f.races.map(r => r.id) } } });
  const original = Client.prototype.query;
  let failures = 0;
  const spy = t.mock.method(Client.prototype, 'query', function (...args) {
    const q = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    const result = original.apply(this, args);
    if (/^UPDATE\s+"public"\."global_step_event_entitlements"/.test(q) && q.includes('"end_processed_at"')) {
      return result.then(value => {
        if (value.rowCount) { failures++; throw Object.assign(new Error('injected after end stamp'), { code: '40001' }); }
        return value;
      });
    }
    return result;
  });
  try { await buildLocalGlobalStepEventTick({ now: () => f.current, logger })(); } finally { spy.mock.restore(); }
  assert.ok(failures > 0, 'fault must occur after a real successful PostgreSQL write');
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } }), 0);
  assert.equal(await recapCount(f.event.id), 0, 'recaps are calculated only by an eligible app open');
  for (const previous of before) {
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: previous.raceId } });
    assert.equal(job.generation, previous.generation, 'queue changes roll back with the end stamp');
  }
  const tick = buildLocalGlobalStepEventTick({ now: () => f.current, logger });
  await tick(); await tick();
  assert.equal(await recapCount(f.event.id), 0, 'recaps are calculated only by an eligible app open');
  for (const previous of before) {
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: previous.raceId } });
    assert.equal(job.generation, previous.generation + 1);
  }
  const response = await request(server.baseUrl, 'GET', `/home/global-event-summary-work/${randomUUID()}`, {
    token: f.account.token, headers: { 'X-Client-Features': 'impact_summaries,impact_summary_expiry_v1' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'EXPIRED_UNDELIVERED');
});

test('batched end preserves saved recaps and leaves expired, unknown and zero-race candidates uncalculated', { timeout: 90000 }, async () => {
  const f = await fixture(10);
  const [expiredUser, unknownUser, emptyUser, existingUser] = f.users;
  await prisma.globalStepEventEntitlement.update({ where: { eventId_userId: { eventId: f.event.id, userId: expiredUser.id } },
    data: { localDate: new Date(+f.current - 86400000).toISOString().slice(0, 10) } });
  await prisma.globalStepEventEntitlement.update({ where: { eventId_userId: { eventId: f.event.id, userId: unknownUser.id } },
    data: { recapRaceCount: null, recapCountPolicyVersion: null, recapWindowRevision: null } });
  await prisma.globalStepEventEntitlement.update({ where: { eventId_userId: { eventId: f.event.id, userId: emptyUser.id } },
    data: { recapRaceCount: 0 } });
  await prisma.globalEventRaceImpact.deleteMany({ where: { eventId: f.event.id, userId: emptyUser.id } });
  const savedId = randomUUID();
  await prisma.$executeRawUnsafe(`INSERT INTO event_recaps
    (id,event_id,user_id,calculation_version,raw_steps,race_count,extra_race_steps,settled_at,expires_at,suppressed)
    VALUES($1,$2,$3,'SIMPLE_RAW_V1',50,2,100,$4,$5,false)`,
    savedId,f.event.id,existingUser.id,f.current,new Date(+f.current+3600000));
  await buildLocalGlobalStepEventTick({ now: () => f.current, logger })();
  assert.equal(await prisma.globalStepEventEntitlement.count({where:{eventId:f.event.id,endProcessedAt:{not:null}}}),10);
  assert.equal(await recapCount(f.event.id),1,'scheduler neither replaces saved recap nor computes other candidates');
  const [saved] = await prisma.$queryRawUnsafe('SELECT id,extra_race_steps FROM event_recaps WHERE event_id=$1',f.event.id);
  assert.equal(saved.id,savedId); assert.equal(saved.extra_race_steps,100);
  const response = await request(server.baseUrl,'GET','/home/event-recap',{token:f.account.token});
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{state:'none'});
  assert.equal((await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM job_runs WHERE starts_with(job_name,'global_event_summary:')"))[0].n,0);
});

test('failed batch still isolates and retries after consuming the original tick budget', { timeout: 30000 }, async t => {
  const f = await fixture(10);
  const original = Client.prototype.query;
  let injected = false;
  const spy = t.mock.method(Client.prototype, 'query', function (...args) {
    const q = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
    const result = original.apply(this, args);
    if (!injected && /^UPDATE\s+"public"\."global_step_event_entitlements"/.test(q) && q.includes('"end_processed_at"')) {
      injected = true;
      return result.then(async value => {
        assert.equal(value.rowCount, 10);
        await delay(5100); // exceed the real five-second scheduler budget
        throw Object.assign(new Error('slow failed batch'), { code: '40001' });
      });
    }
    return result;
  });
  try { await buildLocalGlobalStepEventTick({ now: () => f.current, logger })(); } finally { spy.mock.restore(); }
  assert.ok(injected);
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } }), 10,
    'healthy rows must not remain blocked after batch budget exhaustion');
});

test('a cohort larger than one page progresses without processing another timezone early', { timeout: 90000 }, async t => {
  const f = await fixture(121);
  const futureUser = f.users.at(-1);
  await prisma.globalStepEventEntitlement.update({ where: { eventId_userId: { eventId: f.event.id, userId: futureUser.id } }, data: {
    timezone: 'Pacific/Auckland', startsAt: new Date(+f.current + 11 * 3600000),
    endsAt: new Date(+f.current + 12 * 3600000), startProcessedAt: null, startOutcome: 'PENDING',
  } });
  const tick = buildLocalGlobalStepEventTick({ now: () => f.current, logger });
  const first = await observe(t, tick);
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } }), 100);
  const second = await observe(t, tick);
  assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: f.event.id, endProcessedAt: { not: null } } }), 120);
  assert.equal(await recapCount(f.event.id), 0, 'recaps are calculated only by an eligible app open');
  const future = await prisma.globalStepEventEntitlement.findUniqueOrThrow({ where: { eventId_userId: { eventId: f.event.id, userId: futureUser.id } } });
  assert.equal(future.endProcessedAt, null);
  for (const result of [first, second]) {
    assert.ok(result.queries.length <= 45, `bounded page SQL: ${result.queries.length}`);
    assert.equal(result.queries.filter(q => /INSERT INTO race_resolution_jobs_v2/.test(q) && /ON CONFLICT \(race_id\) DO UPDATE/.test(q)).length, 1);
  }
});

test('in-challenge HTTP samples retain 2x scoring through end batching without summary capture', { timeout: 90000 }, async () => {
  const f = await fixture(10);
  await buildLocalGlobalStepEventTick({ now: () => f.current, logger })();
  const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
    token: f.account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
    body: { ...f.body, steps: 160, samples: [...f.body.samples, {
      periodStart: new Date(+f.event.startsAt + 60000).toISOString(),
      periodEnd: new Date(+f.event.endsAt - 60000).toISOString(), steps: 60,
    }] },
  });
  assert.equal(response.status, 202, await response.text());
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  let totals = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const race of f.races) await worker.processRace({ raceId: race.id });
    totals = await prisma.raceParticipant.findMany({ where: { userId: f.account.user.id }, select: { totalSteps: true } });
    if (totals.every(p => p.totalSteps === 220)) break;
  }
  assert.ok(totals.every(p => p.totalSteps === 220), `100 outside + 60 doubled: ${JSON.stringify(totals)}`);
  for (const race of f.races) for (const features of ['', 'powerups2,powerups3,powerups4,powerups5']) {
    const result = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, {
      token: f.account.token, headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' },
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 220);
  }
});

test('bounded concurrent end drains and timezone travel retain late-upload historical 2x for frozen and current clients', { timeout: 90000 }, async () => {
  const f = await fixture(10);
  const { scheduleGlobalStepEvents } = require('../../src/modules/steps/jobs/globalStepEventScheduler');
  const first=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{},logger});
  const second=scheduleGlobalStepEvents({maybeStartGlobalEvent:async()=>{},logger});
  try {
    const changed=request(server.baseUrl,'GET','/auth/me',{token:f.account.token,headers:{'X-Timezone':'America/Los_Angeles'}});
    await Promise.all([first.tick(),second.tick()]);
    assert.equal((await changed).status,200);
  } finally {await first.stop();await second.stop();}
  assert.equal(await prisma.globalStepEventEntitlement.count({where:{eventId:f.event.id,endProcessedAt:{not:null}}}),10);
  assert.ok((await prisma.globalStepEventEntitlement.findMany({where:{eventId:f.event.id}})).every(row=>row.timezone==='UTC'));

  const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
    token: f.account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
    body: { ...f.body, steps: 160, samples: [...f.body.samples, {
      periodStart: new Date(+f.event.startsAt + 60000).toISOString(),
      periodEnd: new Date(+f.event.endsAt - 60000).toISOString(), steps: 60,
    }] },
  });
  assert.equal(response.status, 202, await response.text());
  const worker = buildRaceResolutionWorkerV2({ bootAt: 0 });
  let totals = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const race of f.races) await worker.processRace({ raceId: race.id });
    totals = await prisma.raceParticipant.findMany({ where: { userId: f.account.user.id }, select: { totalSteps: true } });
    if (totals.every(p => p.totalSteps === 220)) break;
  }
  assert.ok(totals.every(p => p.totalSteps === 220), `100 outside + 60 doubled: ${JSON.stringify(totals)}`);
  for (const race of f.races) for (const features of ['', 'powerups2,powerups3,powerups4,powerups5']) {
    const result = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, {
      token: f.account.token, headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' },
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 220);
  }
});
