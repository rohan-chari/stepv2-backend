process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const { prisma, cleanDatabase, createTestUser, startServer, request } = require('./setup');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
let server; let queries;
prisma.$on('query', event => queries?.push(event));
before(async () => { server = await startServer(); });
beforeEach(cleanDatabase);
after(async () => { await server.close(); await prisma.$disconnect(); });

async function fixture(joiners = 1) {
  const creator = await createTestUser({ timezone: 'UTC', globalEventTimezone: 'UTC' });
  const accounts = [];
  for (let i = 0; i < joiners; i++) accounts.push(await createTestUser({ timezone: 'UTC', globalEventTimezone: 'UTC' }));
  const now = new Date(); const start = new Date(+now - 5 * 60000);
  const race = await prisma.race.create({ data: {
    creatorId: creator.user.id, name: 'Counter regression', targetSteps: 0, timeBased: true,
    maxDurationDays: 1, maxParticipants: 10, isPublic: true, status: 'ACTIVE',
    startedAt: new Date(+now - 3600000), endsAt: new Date(+now + 86400000),
  } });
  await prisma.raceParticipant.create({ data: { raceId: race.id, userId: creator.user.id, status: 'ACCEPTED', joinedAt: race.startedAt } });
  const event = await prisma.globalStepEvent.create({ data: {
    eventDay: start.toISOString().slice(0, 10), scheduleMode: 'LOCAL_ENTITLEMENTS',
    localStartMinute: start.getUTCHours() * 60 + start.getUTCMinutes(), durationMinutes: 30,
    startsAt: start, endsAt: new Date(+now + 30 * 60000), multiplier: 2,
  } });
  return { race, event, accounts };
}
const counterWrites = list => list.filter(e => /(?:INSERT INTO|UPDATE)\s+"?(?:public"?\.)?"?global_step_event_operational_counters/i.test(e.query));
async function counters() {
  return Object.fromEntries((await prisma.globalStepEventOperationalCounter.findMany()).map(r => [r.metric, r.value.toString()]));
}

test('HTTP late enrollment atomically persists multiple counters with one SQL write', async () => {
  const { race, event, accounts: [account] } = await fixture();
  queries = [];
  const response = await request(server.baseUrl, 'POST', `/races/${race.id}/join`, { token: account.token });
  const captured = queries; queries = null;
  assert.equal(response.status, 201, JSON.stringify(await response.json()));
  const entitlement = await prisma.globalStepEventEntitlement.findUnique({ where: { eventId_userId: { eventId: event.id, userId: account.user.id } } });
  assert.ok(entitlement);
  const values = await counters();
  assert.equal(values.entitlementsCreated, '1');
  assert.equal(values.lateEntitlementsCreated, '1');
  const writes = counterWrites(captured);
  console.log(JSON.stringify({ experiment: 'HTTP late-enrollment counters', writes: writes.length, values }));
  assert.equal(writes.length, 1, 'one atomic record call must batch its nonzero metrics');
  const again = await request(server.baseUrl, 'POST', `/races/${race.id}/join`, { token: account.token });
  assert.equal(again.status, 400);
  assert.match(JSON.stringify(await again.json()), /already in this race/);
  assert.deepEqual(await counters(), values, 'duplicate enrollment must not count creation again');
});

test('concurrent HTTP enrollments preserve every durable counter increment', async () => {
  const { race, accounts } = await fixture(3);
  const results = await Promise.all(accounts.map(account => request(server.baseUrl, 'POST', `/races/${race.id}/join`, { token: account.token })));
  for (const response of results) assert.equal(response.status, 201, JSON.stringify(await response.json()));
  const values = await counters();
  assert.equal(values.entitlementsCreated, '3');
  assert.equal(values.lateEntitlementsCreated, '3');
});

test('HTTP enrollment rolls back every counter and entitlement when a counter write fails', async () => {
  const { race, event, accounts: [account] } = await fixture();
  await prisma.$executeRawUnsafe(`CREATE FUNCTION cpu_test_reject_counter() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.metric='lateEntitlementsCreated' THEN RAISE EXCEPTION 'test counter failure'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER cpu_test_counter_failure AFTER INSERT OR UPDATE ON global_step_event_operational_counters FOR EACH ROW EXECUTE FUNCTION cpu_test_reject_counter()`);
  try {
    const response = await request(server.baseUrl, 'POST', `/races/${race.id}/join`, { token: account.token });
    assert.equal(response.status, 500);
    assert.deepEqual(await counters(), {});
    assert.equal(await prisma.globalStepEventEntitlement.count({ where: { eventId: event.id, userId: account.user.id } }), 0);
    assert.equal(await prisma.raceParticipant.count({ where: { raceId: race.id, userId: account.user.id } }), 0);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER cpu_test_counter_failure ON global_step_event_operational_counters');
    await prisma.$executeRawUnsafe('DROP FUNCTION cpu_test_reject_counter()');
  }
});
