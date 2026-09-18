const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
assert.equal(process.env.REDIS_URL, '', 'explicit unset Redis fixture');
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(async () => { await cleanDatabase(); });
test('Redis-unset independent worker preserves old/current HTTP scores with an attributed canonical load', async () => {
  const account = await createTestUser({ timezone: 'UTC' });
  const now = Date.now(), start = new Date(now - 6 * 86400000);
  const race = await prisma.race.create({ data: { creatorId: account.user.id, name: 'Redis unset history',
    status: 'ACTIVE', targetSteps: 100000, timezone: 'UTC', startedAt: start, endsAt: new Date(now + 86400000) } });
  await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id, status: 'ACCEPTED', joinedAt: start } });
  await prisma.stepSample.create({ data: { userId: account.user.id, periodStart: start,
    periodEnd: new Date(+start + 3600000), steps: 50 } });
  const sync = await request(baseUrl, 'POST', '/steps/sync-v2', { token: account.token,
    headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC', 'X-Client-Features': '' },
    body: { date: new Date(now).toISOString().slice(0, 10), steps: 100,
      samples: [{ periodStart: new Date(now - 3600000).toISOString(), periodEnd: new Date(now - 1800000).toISOString(), steps: 100 }] } });
  assert.equal(sync.status, 202);
  const child = spawn(process.execPath, ['test/integration/fixtures/historical-raw-worker.cjs'], {
    env: { ...process.env, REDIS_URL: '', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0', RACE_RESOLVE_DEBOUNCE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  const result = await new Promise((resolve, reject) => {
    let message; child.on('message', value => { message = value; }); child.on('error', reject);
    child.on('exit', code => code === 0 && message ? resolve(message) : reject(new Error(logs)));
  });
  assert.equal(result.count, 1);
  assert.equal(result.queries.filter(query => query.includes('steps:historical-raw-proof')).length, 0);
  assert.equal(result.metrics.counters['race_scoring_cache_stage_total{kind=raw,reason=redis_disabled}'], 1);
  for (const features of ['', 'tournaments']) {
    const response = await request(baseUrl, 'GET', `/races/${race.id}/progress`, { token: account.token,
      headers: { 'X-Timezone': 'UTC', 'X-Client-Features': features } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).progress.participants.find(row => row.userId === account.user.id).totalSteps, 150);
  }
});
