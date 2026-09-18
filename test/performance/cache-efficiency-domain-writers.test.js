const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const IORedis = require('ioredis');
process.env.CACHE_ENV_PREFIX = 't:ce-domains:';
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6402';
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(databaseUrl.hostname) && databaseUrl.pathname.endsWith('_test'), 'Explicit local *_test DATABASE_URL required before setup');
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require('./setup');
let server, probe;
const key = (domain, identity) => `t:ce-domains:ce:v1:g:${domain}:${identity}`;
async function token(domain, identity) {
  const value = await probe.get(key(domain, identity));
  assert.match(value || '', /^[a-f0-9-]{36}$/, `${domain} marker must exist before HTTP returns`);
  return value;
}
async function ok(method, path, user, body) {
  const response = await request(server.baseUrl, method, path, { token: user.token, body });
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
describe('release A personal cache writers through real HTTP', () => {
  before(async () => {
    assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
    probe = new IORedis(process.env.REDIS_URL);
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await probe.keys('t:ce-domains:*');
    if (keys.length) await probe.del(...keys);
  });
  after(async () => { await probe.quit(); });
  it('daily ingestion, correction and milestone claim fence the same local day', async () => {
    const user = await createTestUser({ displayName: 'Milestone Cache' });
    const date = new Date().toISOString().slice(0, 10);
    const identity = `${user.user.id}:${date}`;
    await ok('POST', '/steps', user, { date, steps: 5000 });
    const first = await token('milestones', identity);
    await ok('POST', '/steps', user, { date, steps: 6000 });
    const corrected = await token('milestones', identity);
    assert.notEqual(corrected, first);
    await ok('POST', '/users/me/step-milestones/5000/claim', user, { localDate: date });
    assert.notEqual(await token('milestones', identity), corrected);
    const status = await ok('GET', `/users/me/step-milestones/today?localDate=${date}`, user);
    assert.equal(status.currentSteps, 6000);
    const beforeRejected = await token('milestones', identity);
    const rejected = await request(server.baseUrl, 'POST', '/users/me/step-milestones/5000/claim', {
      token: user.token, body: { localDate: date },
    });
    assert.equal(rejected.status, 409);
    assert.equal(await token('milestones', identity), beforeRejected);
  });
  it('discard fences slots before returning and repeated discard cannot mutate again', async () => {
    const alice = await createTestUser({ displayName: 'Slots Alice' });
    const bob = await createTestUser({ displayName: 'Slots Bob' });
    await prisma.friendship.create({ data: { requesterId: alice.user.id, addresseeId: bob.user.id, status: 'ACCEPTED' } });
    const { race } = await ok('POST', '/races', alice, {
      name: 'Slot cache', targetSteps: 500000, maxDurationDays: 7, powerupsEnabled: true,
    });
    await ok('POST', `/races/${race.id}/invite`, alice, { inviteeIds: [bob.user.id] });
    await ok('PUT', `/races/${race.id}/respond`, bob, { accept: true });
    const participant = await prisma.raceParticipant.findFirst({ where: { raceId: race.id, userId: alice.user.id } });
    const box = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: participant.id, userId: alice.user.id,
      status: 'MYSTERY_BOX', earnedAtSteps: 5000,
    } });
    const path = `/races/${race.id}/powerups/${box.id}/discard`;
    await ok('POST', path, alice);
    const marker = await token('slots', `participant:${participant.id}`);
    const retry = await request(server.baseUrl, 'POST', path, { token: alice.token });
    assert.equal(retry.status, 400);
    assert.equal(await token('slots', `participant:${participant.id}`), marker);
  });
  it('timezone reconciliation fences every race-scoped entitlement display for the user', async () => {
    const user = await createTestUser({ timezone: 'America/New_York', globalEventTimezone: 'America/New_York' });
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Entitlement Fence', targetSteps: 50000, status: 'ACTIVE', startedAt: new Date(), participants: { create: { userId: user.user.id, status: 'ACCEPTED' } } } });
    for (const zone of ['America/Los_Angeles', 'Europe/London']) {
      const before = await probe.get(key('entitlement', user.user.id));
      const beforeRace = await probe.get(key('event', race.id));
      const response = await request(server.baseUrl, 'GET', '/auth/me', {
        token: user.token, headers: { 'x-timezone': zone },
      });
      assert.equal(response.status, 200);
      assert.notEqual(await token('entitlement', user.user.id), before);
      assert.notEqual(await token('event', race.id), beforeRace);
      assert.equal((await response.json()).user.timezone, zone);
    }
  });

});
