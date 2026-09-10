const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { before, after, it } = require('node:test');
const IORedis = require('ioredis');
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6402';
process.env.CACHE_ENV_PREFIX = 't:ce-review-maintenance:';
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(databaseUrl.hostname) && databaseUrl.pathname.endsWith('_test'), 'Explicit local *_test DATABASE_URL required before setup');
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require('./setup');
const exec = promisify(execFile);
let redis, server;
before(async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(process.env.REDIS_URL).hostname));
  await cleanDatabase();
  redis = new IORedis(process.env.REDIS_URL);
  server = await getSharedServer();
});
after(async () => { await redis.quit(); });
it('managed seed/reset fence raw writes and retain the reviewer login identity', async () => {
  const reviewer = await createTestUser({ appleId: 'review-account-v1', isReviewAccount: true });
  const ordinary = await createTestUser({ displayName: 'Ordinary Friend' });
  const env = { ...process.env, APP_REVIEW_EMAIL: 'cache-review@example.invalid' };
  await exec(process.execPath, ['scripts/seed-app-review-demo.js'], { env, timeout: 30000 });
  const prefix = process.env.CACHE_ENV_PREFIX;
  assert.match(await redis.get(`${prefix}ce:v1:g:list:${reviewer.user.id}`) || '', /^[a-f0-9-]{36}$/);
  await prisma.friendship.create({ data: { requesterId: ordinary.user.id, addresseeId: reviewer.user.id, status: 'ACCEPTED' } });
  const before = await request(server.baseUrl, 'GET', '/friends', { token: ordinary.token });
  assert.equal(before.status, 200);
  assert.equal(JSON.stringify(await before.json()).includes(reviewer.user.id), true);
  await prisma.stepMilestoneClaim.create({ data: { userId: reviewer.user.id, claimedDate: new Date().toISOString().slice(0, 10), threshold: 5000, coins: 10 } });
  await exec(process.execPath, ['scripts/reset-app-review.js'], { env, timeout: 30000 });
  assert.equal(await prisma.stepMilestoneClaim.count({ where: { userId: reviewer.user.id } }), 0);
  assert.equal((await prisma.user.findUnique({ where: { appleId: 'review-account-v1' } })).id, reviewer.user.id);
  assert.match(await redis.get(`${prefix}ce:v1:g:list:${ordinary.user.id}`) || '', /^[a-f0-9-]{36}$/);
  const after = await request(server.baseUrl, 'GET', '/friends', { token: ordinary.token });
  assert.equal(after.status, 200);
  assert.equal(JSON.stringify(await after.json()).includes(reviewer.user.id), false);
});

it('retains committed-phase manifest on Redis rejection and refuses wrong-namespace recovery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bara-cache-recovery-test-'));
  const restricted = new URL(process.env.REDIS_URL);
  restricted.username = 'ce-review-restricted'; restricted.password = 'test-only-password';
  await redis.call('ACL', 'SETUSER', restricted.username, 'on', '>test-only-password', '~t:ce-review-maintenance:*', '&*', '+eval', '+get', '+ping', '+info', '+client', '+subscribe', '+unsubscribe', '+publish', '+quit', '+select');
  const env = { ...process.env, XDG_STATE_HOME: directory, REDIS_URL: restricted.toString(), APP_REVIEW_EMAIL: 'committed-cache-review@example.invalid' };
  try {
    await assert.rejects(exec(process.execPath, ['scripts/seed-app-review-demo.js'], { env, timeout: 30000 }), error => {
      assert.match(error.stderr, /cache recovery incomplete/);
      return true;
    });
    assert.equal((await prisma.user.findUnique({ where: { appleId: 'review-account-v1' } })).email, env.APP_REVIEW_EMAIL);
    const manifests = await fs.readdir(path.join(directory, 'bara-cache-recovery'));
    assert.equal(manifests.length, 1);
    const manifest = path.join(directory, 'bara-cache-recovery', manifests[0]);
    await assert.rejects(exec(process.execPath, ['scripts/review-cache-maintenance.js', '--replay', manifest], {
      env: { ...env, REDIS_URL: process.env.REDIS_URL, CACHE_ENV_PREFIX: 't:wrong-namespace:' }, timeout: 30000,
    }), error => { assert.match(error.stderr, /does not match/); return true; });
    assert.ok(await fs.stat(manifest));
    await exec(process.execPath, ['scripts/review-cache-maintenance.js', '--replay', manifest], {
      env: { ...env, REDIS_URL: process.env.REDIS_URL }, timeout: 30000,
    });
    assert.deepEqual(await fs.readdir(path.dirname(manifest)), []);
    const reviewer = await prisma.user.findUnique({ where: { appleId: 'review-account-v1' } });
    assert.match(await redis.get(`${process.env.CACHE_ENV_PREFIX}ce:v1:g:list:${reviewer.id}`) || '', /^[a-f0-9-]{36}$/);
  } finally {
    await redis.call('ACL', 'DELUSER', restricted.username);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
it('rejects unmanaged direct SQL before any review deletion', async () => {
  const before = await prisma.user.count();
  await assert.rejects(exec('psql', [process.env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-f', 'scripts/reset-app-review.sql'], { timeout: 10000 }), error => {
    assert.match(error.stderr, /direct SQL would bypass cache invalidation/); return true;
  });
  assert.equal(await prisma.user.count(), before);
});
