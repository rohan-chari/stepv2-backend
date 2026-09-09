const assert = require('node:assert/strict');
const { before, after, beforeEach, test } = require('node:test');
const { writeFileSync } = require('node:fs');
const h = require('./fixtures/enrollment-query/harness.cjs');
const { startServer, request, createTestUser } = require('./setup');
const { buildGlobalEventBoundaryDrain } = require('../../src/modules/steps');
let server;
before(async () => { server = await startServer(); });
beforeEach(async () => { await h.resetPerformance(); });
after(async () => { await h.resetPerformance(); await server.close(); await h.prisma.$disconnect(); });

const id = i => `user-${String(i).padStart(6, '0')}`;
async function seedUsers(count) {
  await h.prisma.user.createMany({ data: Array.from({ length: count }, (_, i) => ({
    id: id(i), globalEventTimezone: 'UTC', timezone: 'UTC',
  })) });
  const race = await h.prisma.race.create({ data: {
    id: 'enrollment-active-race', name: 'Enrollment integration', status: 'ACTIVE', targetSteps: 100000,
    startedAt: new Date(+h.NOW - 3600_000), endsAt: new Date(+h.NOW + 7 * 86400000),
  } });
  await h.prisma.raceParticipant.createMany({ data: Array.from({ length: count }, (_, i) => ({
    raceId: race.id, userId: id(i), status: 'ACCEPTED', joinedAt: race.startedAt,
  })) });
  return race;
}
async function enrolled(event) {
  return h.prisma.globalStepEventEntitlement.findMany({ where: { eventId: event.id }, orderBy: { userId: 'asc' } });
}
async function obligations(count) {
  assert.equal(await h.prisma.domainEventOutbox.count({ where: {
    eventType: 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1' } }), count);
  const rows = await h.prisma.$queryRawUnsafe(`SELECT e.id FROM global_step_event_entitlements e
    LEFT JOIN domain_event_outbox o ON o.event_key =
      'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:' || e.id || ':' || e.schedule_revision
    WHERE o.id IS NULL`);
  assert.equal(rows.length, 0, 'every entitlement has its durable scheduled obligation');
}

test('scheduler excludes every race/membership state, deduplicates users and respects event-local entitlements', async () => {
  const race = await seedUsers(12);
  const events = await h.parents(); await h.readyGeneration();
  for (const [i, status] of [[1, 'INVITED'], [2, 'DECLINED']]) {
    await h.prisma.raceParticipant.updateMany({ where: { userId: id(i) }, data: { status } });
  }
  await h.prisma.raceParticipant.updateMany({ where: { userId: id(3) }, data: { finishedAt: h.NOW } });
  await h.prisma.raceParticipant.updateMany({ where: { userId: id(4) }, data: { forfeitedAt: h.NOW } });
  for (const [i, status] of [[5, 'PENDING'], [6, 'COMPLETED'], [7, 'CANCELLED']]) {
    const other = await h.prisma.race.create({ data: { name: status, status, targetSteps: 10 } });
    await h.prisma.raceParticipant.updateMany({ where: { userId: id(i) }, data: { raceId: other.id } });
  }
  const duplicate = await h.prisma.race.create({ data: { name: 'Duplicate', status: 'ACTIVE', targetSteps: 10 } });
  await h.prisma.raceParticipant.create({ data: { raceId: duplicate.id, userId: id(0), status: 'ACCEPTED' } });
  await h.prisma.globalStepEventEntitlement.create({ data: h.entitlement(events[0], id(8), { startOutcome: 'SKIPPED_STALE' }) });
  const unrelated = await h.prisma.globalStepEvent.create({ data: { startsAt: h.NOW, endsAt: h.NOW } });
  await h.prisma.globalStepEventEntitlement.create({ data: h.entitlement({ ...events[0], id: unrelated.id }, id(9)) });
  const run = await h.tick({ freezeBudget: true });
  assert.equal(run.result, true);
  assert.equal(run.pages.length, 2);
  assert.deepEqual((await enrolled(events[0])).map(x => x.userId), [0, 8, 9, 10, 11].map(id));
  assert.deepEqual((await enrolled(events[1])).map(x => x.userId), [0, 8, 9, 10, 11].map(id));
  assert.equal(await h.prisma.domainEventOutbox.count({ where: { eventType: 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1' } }), 9);
  const again = await h.tick({ freezeBudget: true });
  assert.equal(again.pages.length, 2);
  assert.equal(await h.prisma.globalStepEventEntitlement.count(), 11);
  assert.ok(race.id);
});

for (const count of [500, 601]) {
  test(`scheduler drains ${count} distinct candidates, terminal page, retry and newly eligible lower ID`, async () => {
    const race = await seedUsers(count);
    const events = await h.parents(); await h.readyGeneration();
    const first = await h.tick({ freezeBudget: true });
    const pages = first.pages.filter(q => JSON.parse(q.params)[0] === events[0].id);
    assert.deepEqual(pages.map(q => JSON.parse(q.params)), [
      [events[0].id, 500, null], [events[0].id, 500, id(499)],
    ]);
    assert.deepEqual((await enrolled(events[0])).map(x => x.userId), Array.from({ length: count }, (_, i) => id(i)));
    await obligations(count * 2);
    await h.tick({ freezeBudget: true }); await obligations(count * 2);
    await h.prisma.user.create({ data: { id: '000-newly-eligible', globalEventTimezone: 'UTC' } });
    await h.prisma.raceParticipant.create({ data: { raceId: race.id, userId: '000-newly-eligible', status: 'ACCEPTED' } });
    const next = await h.tick({ freezeBudget: true });
    assert.ok(next.pages.every(q => JSON.parse(q.params)[2] === null));
    assert.equal((await enrolled(events[0]))[0].userId, '000-newly-eligible');
    await obligations((count + 1) * 2);
  });
}

test('zero-created full pages advance past exact-start/elapsed users to future timezone users', async () => {
  await seedUsers(502);
  const boundaryNow = new Date('2098-01-01T10:00:00Z');
  await h.parents(boundaryNow); await h.readyGeneration(boundaryNow);
  const event = await h.prisma.globalStepEvent.create({ data: {
    id: 'boundary-event', eventDay: '2098-01-01', scheduleMode: 'LOCAL_ENTITLEMENTS',
    startsAt: new Date('2097-12-31T20:00:00Z'), endsAt: new Date('2098-01-02T00:00:00Z'),
    localStartMinute: 600, durationMinutes: 30, summaryAttributionVersion: 2,
  } });
  await h.prisma.user.update({ where: { id: id(500) }, data: { globalEventTimezone: 'America/New_York', timezone: 'America/New_York' } });
  await h.prisma.user.update({ where: { id: id(501) }, data: { globalEventTimezone: 'invalid-zone', timezone: 'invalid-zone' } });
  const run = await h.tick({ now: boundaryNow, freezeBudget: true });
  const pages = run.pages.filter(q => JSON.parse(q.params)[0] === event.id);
  assert.equal(pages.length, 2, 'zero inserted in a full first page is not exhaustion');
  assert.equal(JSON.parse(pages[1].params)[2], id(499));
  const rows = await enrolled(event);
  assert.deepEqual(rows.map(r => r.userId), [id(500), id(501)]);
  assert.ok(rows.every(r => r.timezone === 'America/New_York'));
  assert.ok(rows.every(r => r.startsAt.toISOString() === '2098-01-01T15:00:00.000Z'));
});

test('concurrent public scheduler producers retain unique entitlements and scheduled event obligations', async () => {
  await seedUsers(30); const events = await h.parents(); await h.readyGeneration();
  // Capture instrumentation is process-global, so run the two public jobs directly here.
  const { buildLocalGlobalStepEventTick } = require('../../src/modules/steps');
  const job = () => buildLocalGlobalStepEventTick({ now: () => h.NOW, logger: { log() {}, error() {} } })();
  const outcomes = await Promise.allSettled([job(), job()]);
  assert.ok(outcomes.some(result => result.status === 'fulfilled' && result.value === true));
  for (const result of outcomes) {
    if (result.status === 'rejected') assert.equal(result.reason.message,
      'set-based entitlement materialization found conflicting immutable facts');
  }
  // Existing statement-snapshot loser may reject; the public retry must converge.
  assert.equal(await job(), true);
  assert.equal((await enrolled(events[0])).length, 30);
  await obligations(60);
});

test('generation not ready still enrolls but emits no generation-two obligations', async () => {
  await seedUsers(2); const events = await h.parents();
  await h.tick({ freezeBudget: true });
  assert.equal((await enrolled(events[0])).length, 2);
  assert.equal(await h.prisma.domainEventOutbox.count(), 0);
});

test('legacy/current HTTP progress expose the same active event after the real scheduled lifecycle', async () => {
  const current = new Date();
  // Keep the local schedule inside the allowed 08:00–22:00 window at any UTC hour.
  const offset = current.getUTCHours() - 12;
  const timezone = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '+' : ''}${offset}`;
  const { user, token } = await createTestUser({ globalEventTimezone: timezone, timezone });
  const start = new Date(current); start.setUTCSeconds(0, 0);
  const beforeStart = new Date(+start - 1);
  const race = await h.prisma.race.create({ data: {
    creatorId: user.id, name: 'HTTP enrollment contract', status: 'ACTIVE', targetSteps: 10000,
    startedAt: new Date(+start - 3600_000), endsAt: new Date(+start + 86400000),
  } });
  await h.prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.id, status: 'ACCEPTED', joinedAt: race.startedAt } });
  await h.parents(beforeStart); await h.readyGeneration(beforeStart);
  const event = await h.prisma.globalStepEvent.create({ data: {
    scheduleMode: 'LOCAL_ENTITLEMENTS', eventDay: start.toISOString().slice(0, 10),
    localStartMinute: 720 + start.getUTCMinutes(), durationMinutes: 30,
    startsAt: new Date(+start - 14 * 3600_000), endsAt: new Date(+start + 14 * 3600_000),
    summaryAttributionVersion: 2,
  } });
  await h.tick({ now: beforeStart, freezeBudget: true });
  await buildGlobalEventBoundaryDrain({ now: () => current }).runUntilIdle();
  const stored = await enrolled(event);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].startOutcome, 'ACTIVATED_ON_TIME');
  for (const features of ['', 'tournaments']) {
    const response = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, {
      token, headers: { 'X-Client-Features': features },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['progress']);
    assert.equal(body.progress.participants[0].currentMultiplier, 2);
    assert.deepEqual(body.progress.globalEvent, {
      active: true, multiplier: 2, endsAt: new Date(+start + 30 * 60000).toISOString(),
    });
  }
});

test('PG18 historical empty-page database work stays below the pre-implementation 8000-buffer budget', { timeout: 180000 }, async () => {
  const [{ version }] = await h.prisma.$queryRawUnsafe('SELECT version()');
  assert.match(version, /^PostgreSQL 18\./);
  const fixture = await h.seedPerformance({ activeRaces: 160, historicalRaceSize: 50 });
  const run = await h.tick();
  assert.equal(run.result, true);
  assert.equal(run.pages.length, 2);
  assert.equal(await h.prisma.globalStepEventEntitlement.count(), 2000);
  const query = run.pages[0];
  const params = JSON.parse(query.params);
  const actual = await h.explain(query.query, params);
  const baseline = await h.explain(h.baseline, params);
  const evidence = { version, dimensions: fixture.dimensions,
    tick: { elapsedMs: run.elapsedMs, queryCount: run.queryCount, counts: run.counts }, actual, baseline };
  console.log(JSON.stringify({ enrollmentWorkRegression: evidence }));
  if (process.env.ENROLLMENT_TEST_EVIDENCE) writeFileSync(process.env.ENROLLMENT_TEST_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  assert.ok(actual.buffers <= 8000,
    `candidate SELECT used ${actual.buffers} root shared-buffer accesses; fixed pre-change budget is 8000`);
  assert.ok(actual.buffers <= baseline.buffers * 0.25, 'at least 75% lower buffer work than frozen baseline');
});


test('scheduler uses authoritative phone timezone when legacy stable metadata disagrees', async()=>{
  await seedUsers(1);
  await h.prisma.user.update({where:{id:id(0)},data:{timezone:'UTC',globalEventTimezone:'America/Los_Angeles'}});
  const events=await h.parents();await h.readyGeneration();
  await h.tick({freezeBudget:true});
  for(const event of events){
    const rows=await enrolled(event);assert.equal(rows.length,1);assert.equal(rows[0].timezone,'UTC');
  }
});
