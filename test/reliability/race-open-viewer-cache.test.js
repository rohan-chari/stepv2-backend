process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, beforeEach, after, describe, it } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IORedis = require('ioredis');
const { holdRedisCommand } = require('./helpers/holdRedisCommand');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6402';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
process.env.CACHE_ENV_PREFIX = 't:race-open-viewer:';
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require('./setup');
let server, sibling, child, redis, observed, bootstrapSetting;
prisma.$on('query', event => { if (observed) observed.push(event.query); });
const headers = { 'X-Client-Features': 'recurring_races_v1,race_participants_paging,api_payload_compact_v1,team_races,race_leave' };
async function call(base, user, method, path, body, extra = {}) {
  const response = await request(base, method, path, { token: user.token, headers: { ...headers, ...extra }, body });
  const data = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function detail(user, raceId) { return call(server.baseUrl, user, 'GET', `/races/${raceId}`); }
async function fixture({ recurring = false } = {}) {
  const owner = await createTestUser({ displayName: 'Viewer owner' });
  const member = await createTestUser({ displayName: 'Viewer member' });
  const race = await prisma.race.create({ data: {
    creatorId: owner.user.id, name: 'Viewer cache', targetSteps: 50000, maxDurationDays: 2,
    maxParticipants: 10, status: 'COMPLETED', completedAt: new Date(), powerupsEnabled: false,
    participants: { create: [owner, member].map(user => ({ userId: user.user.id, status: 'ACCEPTED' })) },
  } });
  let series;
  if (recurring) {
    series = await prisma.raceSeries.create({ data: { creatorId: owner.user.id, currentRaceId: race.id,
      settings: {}, subscriptions: { create: [owner, member].map(user => ({ userId: user.user.id, active: true })) } } });
    await prisma.race.update({ where: { id: race.id }, data: { seriesId: series.id, seriesGeneration: 0 } });
  }
  return { owner, member, race, series };
}
describe('race-open viewer state cache over HTTP', () => {
  before(async () => {
    redis = new IORedis(process.env.REDIS_URL);
    bootstrapSetting = await prisma.appSetting.findUnique({ where: { key: 'apiRaceBootstrapV1Enabled' } });
    await prisma.appSetting.upsert({ where: { key: 'apiRaceBootstrapV1Enabled' }, create: { key: 'apiRaceBootstrapV1Enabled', value: true }, update: { value: true } });
    server = await getSharedServer();
    child = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    sibling = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sibling API did not start')), 10000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Sibling exited ${code}`)); });
      child.stdout.on('data', bytes => { const match = String(bytes).match(/LISTENING (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
  });
  beforeEach(async () => {
    observed = null;
    await cleanDatabase();
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  });
  after(async () => {
    await prisma.appSetting.deleteMany({ where: { key: 'apiRaceBootstrapV1Enabled' } });
    if (bootstrapSetting) await prisma.appSetting.create({ data: bootstrapSetting });
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
    if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
  });
  it('warm details and bootstrap omit the rematch/series SQL and preserve viewer isolation', async () => {
    const { owner, member, race, series } = await fixture({ recurring: true });
    const cold = await detail(owner, race.id);
    assert.deepEqual(cold.series, { id: series.id, enabled: true, subscribed: true, canManage: true });
    observed = [];
    const warm = await detail(owner, race.id);
    const bootstrap = await call(server.baseUrl, owner, 'GET', `/races/${race.id}/bootstrap`);
    const queries = observed; observed = null;
    assert.deepEqual(warm, cold);
    assert.deepEqual(bootstrap.race.series, cold.series);
    assert.equal(queries.filter(sql => sql.includes('AS "hasLiveRematch"')).length, 0, 'warm response must eliminate viewer-overlay query');
    assert.equal((await detail(member, race.id)).series.canManage, false);
  });
  it('another worker opting out and stopping recurrence immediately changes warm properties', async () => {
    const { owner, member, race, series } = await fixture({ recurring: true });
    assert.equal((await detail(member, race.id)).series.subscribed, true);
    await detail(owner, race.id);
    await call(sibling, member, 'PUT', `/race-series/${series.id}/subscription`, { active: false });
    assert.equal((await detail(member, race.id)).series.subscribed, false);
    assert.equal((await detail(owner, race.id)).series.subscribed, true);
    await call(sibling, owner, 'PUT', `/race-series/${series.id}`, { enabled: false });
    const stopped = await detail(owner, race.id);
    assert.equal(stopped.series.enabled, false);
    assert.equal(stopped.series.subscribed, false);
    assert.equal(stopped.rematchEligible, true);
  });
  it('another worker creating then canceling a rematch invalidates the source lineage', async () => {
    const { owner, race } = await fixture();
    assert.equal((await detail(owner, race.id)).rematchEligible, true);
    const rematch = await call(sibling, owner, 'POST', `/races/${race.id}/rematch`, {}, { 'Idempotency-Key': randomUUID() });
    assert.equal((await detail(owner, race.id)).rematchEligible, false);
    await call(sibling, owner, 'DELETE', `/races/${rematch.race.id}`);
    assert.equal((await detail(owner, race.id)).rematchEligible, true);
  });
  it('malformed and evicted viewer fragments fall back to correct SQL state', async () => {
    const { owner, race } = await fixture();
    assert.equal((await detail(owner, race.id)).rematchEligible, true);
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:viewer-state:*`);
    assert.equal(keys.length, 1, 'viewer state must actually be cached');
    await redis.set(keys[0], '{broken', 'EX', 30);
    assert.equal((await detail(owner, race.id)).rematchEligible, true);
    await redis.del(...keys);
    assert.equal((await detail(owner, race.id)).rematchEligible, true);
  });
  it('a historical race without a creator still caches its viewer overlay', async () => {
    const { owner, race } = await fixture();
    await prisma.race.update({ where: { id: race.id }, data: { creatorId: null } });
    const first = await detail(owner, race.id);
    assert.equal(first.creator, null);
    observed = [];
    const warm = await detail(owner, race.id);
    const queries = observed; observed = null;
    assert.deepEqual(warm, first);
    assert.equal(queries.filter(sql => sql.includes('AS "hasLiveRematch"')).length, 0);
  });
  it('a rolled-back subscription write leaves the cached committed value intact', async () => {
    const { owner, race, series } = await fixture({ recurring: true });
    assert.equal((await detail(owner, race.id)).series.subscribed, true);
    await prisma.$executeRawUnsafe("CREATE FUNCTION race_open_reject_subscription() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test subscription rollback'; END $$");
    await prisma.$executeRawUnsafe('CREATE TRIGGER race_open_reject_subscription BEFORE UPDATE ON race_series_subscriptions FOR EACH ROW EXECUTE FUNCTION race_open_reject_subscription()');
    try {
      const response = await request(sibling, 'PUT', `/race-series/${series.id}/subscription`, { token: owner.token, body: { active: false } });
      assert.equal(response.status, 500);
      assert.equal((await detail(owner, race.id)).series.subscribed, true);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER race_open_reject_subscription ON race_series_subscriptions');
      await prisma.$executeRawUnsafe('DROP FUNCTION race_open_reject_subscription()');
    }
  });
  it('an in-flight list cache fill cannot reinstall a subscription from before another worker commits', { timeout: 15000 }, async () => {
    const { owner, race, series } = await fixture({ recurring: true });
    const second = await prisma.race.create({ data: { creatorId: owner.user.id, name: 'Second cached row',
      targetSteps: 50000, status: 'COMPLETED', completedAt: new Date(),
      participants: { create: { userId: owner.user.id, status: 'ACCEPTED' } },
    } });
    await detail(owner, race.id); await detail(owner, second.id);
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:viewer-state:*`);
    await redis.del(...keys);
    const proxy = await holdRedisCommand({ target: process.env.REDIS_URL, matches: args =>
      args[0].toUpperCase() === 'EVAL' && args[1].includes('local markerCount = tonumber(ARGV[3])') &&
      args.includes(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:viewer-state:${race.id}:${owner.user.id}`),
    });
    const reader = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], {
      env: { ...process.env, PORT: '0', REDIS_URL: proxy.url }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending;
    try {
      const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Paused reader startup timeout')), 5000);
        reader.once('exit', code => { clearTimeout(timer); reject(new Error(`Reader exited ${code}`)); });
        reader.stdout.on('data', bytes => { const match = String(bytes).match(/LISTENING (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      });
      pending = call(base, owner, 'GET', '/races');
      await Promise.race([proxy.waiting, delay(5000).then(() => { throw new Error('No in-flight viewer fill observed'); })]);
      await call(sibling, owner, 'PUT', `/race-series/${series.id}/subscription`, { active: false });
      proxy.release();
      const listing = await pending;
      assert.equal(listing.completed.find(row => row.id === race.id).series.subscribed, false);
      assert.equal((await detail(owner, race.id)).series.subscribed, false);
    } finally {
      proxy.release();
      if (pending) await pending.catch(() => {});
      if (reader.exitCode === null) { const closed = once(reader, 'exit'); reader.kill('SIGTERM'); await closed; }
      await proxy.close();
    }
  });
  it('creator deletion invalidates cached series state for a remaining participant', async () => {
    const { owner, member, race } = await fixture({ recurring: true });
    assert.equal((await detail(member, race.id)).series.enabled, true);
    const response = await request(sibling, 'DELETE', '/auth/account', { token: owner.token });
    assert.equal(response.status, 204, await response.text());
    const remaining = await detail(member, race.id);
    assert.equal(remaining.series.enabled, false);
    assert.equal(remaining.series.subscribed, false);
    assert.equal(remaining.series.canManage, false);
  });
  it('completing a descendant through team forfeit updates warm child and ancestor eligibility', async () => {
    const { owner, member, race } = await fixture();
    const childRace = await prisma.race.create({ data: {
      creatorId: owner.user.id, name: 'Team rematch', targetSteps: 50000, status: 'ACTIVE',
      startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
      isTeamRace: true, teamSize: 2, maxParticipants: 4, powerupsEnabled: false,
      rematchRootRaceId: race.id, rematchSourceRaceId: race.id,
      participants: { create: [
        { userId: owner.user.id, status: 'ACCEPTED', team: 'TEAM_A', totalSteps: 100 },
        { userId: member.user.id, status: 'ACCEPTED', team: 'TEAM_B', totalSteps: 100 },
      ] },
    } });
    assert.equal((await detail(owner, race.id)).rematchEligible, false);
    assert.equal((await detail(owner, childRace.id)).rematchEligible, false);
    await call(sibling, member, 'POST', `/races/${childRace.id}/forfeit`, {});
    const completed = await detail(owner, childRace.id);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.rematchEligible, true);
    assert.equal((await detail(owner, race.id)).rematchEligible, false);
  });
  it('real renewal worker creates a successor and stopping recurrence does not reopen its predecessor for rematch', { timeout: 45000 }, async () => {
    const owner = await createTestUser({ displayName: 'Worker series owner', timezone: 'UTC' });
    const created = await call(server.baseUrl, owner, 'POST', '/races', {
      name: 'Cached recurring worker', maxDurationDays: 2, maxParticipants: 10,
      powerupsEnabled: false, recurringSeries: true,
    }, { 'Idempotency-Key': randomUUID() });
    await prisma.race.update({ where: { id: created.race.id }, data: {
      status: 'COMPLETED', completedAt: new Date(), settlementCompletedAt: new Date(),
    } });
    // Fixture construction precedes every read; the queued renewal below is
    // consumed by src/index.js's actual production worker scheduler.
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    assert.equal((await detail(owner, created.race.id)).rematchEligible, false);
    await prisma.raceSeriesRenewalJob.create({ data: { predecessorId: created.race.id } });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'race-open-renewal-'));
    const worker = spawn(process.execPath, [path.resolve('src/index.js')], {
      cwd, env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL,
        SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET,
        REDIS_URL: process.env.REDIS_URL, CACHE_ENV_PREFIX: process.env.CACHE_ENV_PREFIX,
        STEPS_PROCESS_ROLE: 'resolution', NODE_APP_INSTANCE: '0', PORT: '0', HOST: '127.0.0.1', CRON_START_DELAY_MS: '0',
        REFERRAL_IP_HMAC_ACTIVE_VERSION: '1', REFERRAL_IP_HMAC_SECRET_V1: 'integration-test-only-referral-hmac-secret-material',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let recent = '';
    worker.stdout.on('data', bytes => { recent = (recent + String(bytes)).slice(-5000); });
    worker.stderr.on('data', bytes => { recent = (recent + String(bytes)).slice(-5000); });
    try {
      let job;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        assert.equal(worker.exitCode, null, recent);
        job = await prisma.raceSeriesRenewalJob.findUnique({ where: { predecessorId: created.race.id } });
        if (['SUCCEEDED', 'FAILED_TERMINAL', 'FAILED_RETRYABLE'].includes(job.state)) break;
        await delay(100);
      }
      assert.equal(job.state, 'SUCCEEDED', `${job.lastErrorCode}: ${recent}`);
      const successor = await detail(owner, job.targetRaceId);
      assert.equal(successor.series.id, created.series.id);
      await call(sibling, owner, 'PUT', `/race-series/${created.series.id}`, { enabled: false });
      const predecessor = await detail(owner, created.race.id);
      assert.equal(predecessor.series.enabled, false);
      assert.equal(predecessor.rematchEligible, false, 'a committed successor still blocks predecessor rematching');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const closed = once(worker, 'exit'); worker.kill('SIGTERM'); await closed;
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
