const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const Redis = require('ioredis');
const target = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname.endsWith('_test'));
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6403';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
process.env.CACHE_ENV_PREFIX = 't:ce-boundary:';
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
// Register local-only query observation before selecting the actual production
// HTTP read path. NODE_ENV=test intentionally retains old replay fixtures.
require('../../src/db');
process.env.NODE_ENV = 'production';
process.env.STEPS_PROCESS_ROLE = 'http';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const prefix = process.env.CACHE_ENV_PREFIX;
let server, redis;
const queries = [];
const features = 'api_payload_compact_v1,race_participants_paging,race_preview,privacy_safe_display_ranks';
async function get(fixture, path = 'progress?view=compact-v1', user = fixture.user) {
  const response = await request(server.baseUrl, 'GET', `/races/${fixture.id}/${path}`, {
    token: user.token, headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function waitFor(check, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await check(); if (value) return value; await delay(40); }
  assert.fail('worker publication timed out');
}
async function fixture() {
  const user = await createTestUser({ timezone: 'UTC' });
  const id = randomUUID();
  await prisma.race.create({ data: { id, name: 'Boundary proof', creatorId: user.user.id,
    status: 'ACTIVE', timezone: 'UTC', powerupsEnabled: false, isPublic: true,
    targetSteps: 1000000, startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000) } });
  const participant = await prisma.raceParticipant.create({ data: { raceId: id, userId: user.user.id,
    status: 'ACCEPTED', joinedAt: new Date(Date.now() - 3600000), buyInStatus: 'NONE' } });
  return { id, user, participant };
}
async function enqueue(f) {
  const at = Date.now();
  const response = await request(server.baseUrl, 'POST', '/steps/samples', {
    token: f.user.token, headers: { 'X-Timezone': 'UTC' }, body: { samples: [{
      periodStart: new Date(at - 1800000).toISOString(), periodEnd: new Date(at - 900000).toISOString(), steps: 100,
    }] },
  });
  assert.equal(response.status, 200);
}
async function publish(f) {
  await enqueue(f);
  return withWorker(async workerQueries => {
    const key = `${prefix}v1:race:progress:${f.id}:lean-v3`;
    await waitFor(() => redis.get(key));
    return { snapshot: JSON.parse(await redis.get(key)), key, workerQueries };
  });
}
async function withWorker(run, beforePublication = null) {
  const child = spawn(process.execPath, ['--require', './test/integration/fixtures/query-efficiency/observe-cpu-remediation.cjs', '--require', './test/integration/fixtures/query-efficiency/observe-resolution.cjs', '--require', './test/integration/fixtures/boundary-proof/pause-publication.cjs', 'src/index.js'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', STEPS_PROCESS_ROLE: 'resolution',
      TEST_PAUSE_BOUNDARY_PUBLICATION: beforePublication ? '1' : '0',
      NODE_APP_INSTANCE: '0', PORT: '0', CRON_START_DELAY_MS: '0', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const workerQueries = [];
  workerQueries.protocol = [];
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.on('message', async message => {
    if (message.kind === 'query') workerQueries.push(message.query);
    if (message.kind === 'cpu-query') workerQueries.protocol.push(message);
    if (message.kind === 'before-boundary-publication') {
      await beforePublication();
      child.send({ kind: 'resume-boundary-publication' });
    }
  });
  try {
    return await run(workerQueries);
  } catch (error) {
    error.message += `\n${output.slice(-6000)}`;
    throw error;
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve); });
  }
}
describe('worker-stamped display boundary proof through HTTP', () => {
  before(async () => {
    redis = new Redis(process.env.REDIS_URL);
    for (const key of ['raceResolutionPostTasksV1Enabled', 'redisStandingsEnabled', 'racePreviewEnabled']) {
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
    }
    server = await getSharedServer();
    prisma.$on('query', event => queries.push(event.query));
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    queries.length = 0;
  });
  after(async () => { await redis.quit(); });
  it('publishes a scored-at proof through the durable worker and one bounded boundary SQL read', async () => {
    const f = await fixture();
    const { snapshot, workerQueries } = await publish(f);
    assert.equal(snapshot.boundaryProof?.v, 1);
    assert.equal(snapshot.boundaryProof.scoredAt, snapshot.asOf);
    assert.ok(snapshot.boundaryProof.nextBoundaryAt);
    const index = JSON.parse(await redis.get(`${prefix}v1:race:progress:index:${f.id}`));
    assert.deepEqual(index.boundaryProof, snapshot.boundaryProof);
    assert.equal(workerQueries.filter(query => query.includes('display_boundary_proof')).length, 1);
    if (process.env.CPU_QUERY_EVIDENCE) require('node:fs').writeFileSync(process.env.CPU_QUERY_EVIDENCE, JSON.stringify(workerQueries.protocol, null, 2));
    const boundary = workerQueries.protocol.filter(q => q.family === 'display-boundary');
    assert.equal(boundary.length, 1);
    assert.match(boundary[0].name || '', /^steps_read_v1_[a-f0-9]{48}$/, 'real publication must admit the stable boundary shape to bounded preparation');
    for (const family of ['post-task-readiness', 'post-task-finish']) {
      const selected = workerQueries.protocol.filter(q => q.family === family);
      assert.ok(selected.length, `${family} must execute in the real worker`);
      assert.ok(selected.every(q => /^steps_(read|query)_v1_[a-f0-9]{48}$/.test(q.name || '')), `${family} must use bounded preparation`);
    }
    assert.equal((await get(f)).progress.participants[0].totalSteps, 100);
  });
  it('includes future PENDING local entitlement starts for accepted race members', async () => {
    const f = await fixture();
    const start = new Date(Date.now() + 300000);
    const end = new Date(+start + 1800000);
    const event = await prisma.globalStepEvent.create({ data: { startsAt: start, endsAt: end,
      scheduleMode: 'LOCAL_ENTITLEMENTS', multiplier: 2 } });
    await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id, userId: f.user.user.id,
      startsAt: start, endsAt: end, timezone: 'UTC', localDate: start.toISOString().slice(0, 10), startOutcome: 'PENDING' } });
    const { snapshot } = await publish(f);
    assert.equal(snapshot.boundaryProof?.nextBoundaryAt, start.toISOString());
  });
  it('includes active legacy event ends', async () => {
    const f = await fixture();
    const end = new Date(Date.now() + 300000);
    await prisma.globalStepEvent.create({ data: { startsAt: new Date(Date.now() - 60000), endsAt: end,
      scheduleMode: 'LEGACY_GLOBAL', multiplier: 2 } });
    const { snapshot } = await publish(f);
    assert.equal(snapshot.boundaryProof?.nextBoundaryAt, end.toISOString());
  });
  it('includes the Campfire freeze-to-boost transition before its expiry', async () => {
    const f = await fixture();
    await prisma.race.update({ where: { id: f.id }, data: { powerupsEnabled: true } });
    const powerup = await prisma.racePowerup.create({ data: { raceId: f.id, participantId: f.participant.id,
      userId: f.user.user.id, type: 'CAMPFIRE_REST', rarity: 'RARE', status: 'USED', earnedAtSteps: 0 } });
    const start = new Date(Date.now() - 60000);
    const phase = new Date(+start + 120000);
    await prisma.raceActiveEffect.create({ data: { raceId: f.id, powerupId: powerup.id,
      sourceUserId: f.user.user.id, targetUserId: f.user.user.id, targetParticipantId: f.participant.id,
      type: 'CAMPFIRE_REST', status: 'ACTIVE', startsAt: start, expiresAt: new Date(+start + 600000),
      metadata: { freezeMs: 120000, boostMs: 480000, multiplier: 2 } } });
    const { snapshot } = await publish(f);
    assert.equal(snapshot.boundaryProof?.nextBoundaryAt, phase.toISOString());
  });
  for (const kind of ['soft-age', 'missing', 'crossed', 'generation']) {
    it(`paged ${kind} keeps hard validity independent of display age`, async () => {
      const f = await fixture();
      const { snapshot } = await publish(f);
      const asOf = new Date(Date.now() - 31000).toISOString();
      for (const key of await redis.keys(`${prefix}v1:race:progress:*${f.id}*`)) {
        const value = JSON.parse(await redis.get(key));
        function modify(item) {
          if (!item || typeof item !== 'object') return;
          if ('asOf' in item) item.asOf = asOf;
          if ('totalSteps' in item) item.totalSteps = 777;
          if (item.boundaryProof) {
            item.boundaryProof.scoredAt = asOf;
            if (kind === 'missing') delete item.boundaryProof;
            if (kind === 'crossed') item.boundaryProof.nextBoundaryAt = new Date(Date.now() - 1).toISOString();
          }
          for (const child of Object.values(item)) modify(child);
        }
        modify(value);
        await redis.set(key, JSON.stringify(value), 'EX', 300);
      }
      if (kind === 'generation') await redis.set(`${prefix}ce:v1:g:race-effects:${f.id}`, randomUUID(), 'EX', 300);
      const progress = (await get(f, 'progress?view=participants-v1&participantsLimit=15')).progress;
      assert.equal(progress.participants[0].totalSteps, kind === 'soft-age' ? 777 : 100);
      assert.equal(progress.projectionSource, 'stale-fallback');
      if (kind !== 'soft-age') {
        const bootstrap = await get(f, 'bootstrap?view=compact-v1');
        assert.equal(bootstrap.progress.participants[0].totalSteps, 100);
        const homeResponse = await request(server.baseUrl, 'GET', '/home/race-card', { token: f.user.token,
          headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' } });
        assert.equal(homeResponse.status, 200);
        const home = await homeResponse.json();
        assert.equal(home.data.me.totalSteps, 100);
        const listResponse = await request(server.baseUrl, 'GET', '/races', { token: f.user.token,
          headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' } });
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json();
        assert.equal(JSON.stringify(list).includes('777'), false, JSON.stringify(list));
      }
      assert.equal(snapshot.boundaryProof.v, 1);
    });
  }
  it('keeps an older payout-offer completed race beside a valid active projection on cold and warm list reads', async () => {
    const f = await fixture();
    let oldest;
    for (let index = 0; index < 11; index += 1) {
      const id = randomUUID();
      const ended = new Date(Date.now() - (index + 1) * 86400000);
      await prisma.race.create({ data: { id, creatorId: f.user.user.id, name: `Completed ${index}`,
        status: 'COMPLETED', targetSteps: 1000, powerupsEnabled: false, timezone: 'UTC',
        startedAt: new Date(+ended - 86400000), endsAt: ended, completedAt: ended } });
      const participant = await prisma.raceParticipant.create({ data: { raceId: id, userId: f.user.user.id,
        status: 'ACCEPTED', joinedAt: new Date(+ended - 86400000), finishedAt: ended,
        totalSteps: 1000, finishTotalSteps: 1000, placement: 1, buyInStatus: 'NONE' } });
      oldest = { id, participant };
    }
    await prisma.racePayoutDoubleOffer.create({ data: { userId: f.user.user.id, baseCoins: 10, bonusCoins: 10,
      maxBonusCoins: 100, rolling24hRemainingBeforeClaim: 100, providerSubHash: 'test-only',
      items: { create: { raceId: oldest.id, raceIdSnapshot: oldest.id, raceParticipantId: oldest.participant.id,
        placementSnapshot: 1, eligibleCoins: 10, sourceReason: 'race_finish_reward', sourceRefId: `${oldest.id}:rank:1` } } } });
    await publish(f);
    const baselineResponse = await request(server.baseUrl, 'GET', '/races', { token: f.user.token,
      headers: { 'X-Client-Features': features, 'X-Timezone': 'UTC' } });
    assert.equal(baselineResponse.status, 200);
    assert.equal((await baselineResponse.json()).completed.some(race => race.id === oldest.id), false);
    const completedKeys = await redis.keys(`${prefix}ce:v1:list:${f.user.user.id}:*:completed:*`);
    assert.ok(completedKeys.length > 0);
    for (const key of completedKeys) {
      const cached = JSON.parse(await redis.get(key));
      assert.equal(cached.races.length, 10);
      assert.equal(cached.races.some(race => race.id === oldest.id), false);
    }
    const listKeys = await redis.keys(`${prefix}ce:v1:list:${f.user.user.id}:*`);
    await redis.del(...listKeys);
    for (const phase of ['cold', 'warm']) {
      const response = await request(server.baseUrl, 'GET', '/races', { token: f.user.token,
        headers: { 'X-Client-Features': `${features},race_payout_double`, 'X-Timezone': 'UTC' } });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.completed.filter(race => race.id === oldest.id).length, 1, phase);
      assert.equal(result.active.filter(race => race.id === f.id).length, 1, phase);
    }
  });
  it('rejects an effect mutation after chunk writes and before the atomic index install', async () => {
    const f = await fixture();
    await enqueue(f);
    let mutationCommitted = false;
    await withWorker(async () => {
      await waitFor(async () => {
        const task = await prisma.raceResolutionPostTask.findFirst({ where: { raceId: f.id } });
        return task?.snapshotState === 'failed_no_retry' && task;
      });
    }, async () => {
      await redis.set(`${prefix}ce:v1:g:race-effects:${f.id}`, randomUUID(), 'EX', 300);
      mutationCommitted = true;
    });
    assert.equal(mutationCommitted, true);
    assert.equal(await redis.get(`${prefix}v1:race:progress:index:${f.id}`), null);
    assert.equal(await redis.get(`${prefix}v1:race:progress:${f.id}:lean-v3`), null);
    assert.equal((await get(f)).progress.participants[0].totalSteps, 100);
  });
  for (const kind of ['crossed-local', 'old-command', 'mutated-effects']) {
    it(`delayed durable ${kind} publication cannot restamp a valid snapshot`, async () => {
      const f = await fixture();
      const { key } = await publish(f);
      const task = await prisma.raceResolutionPostTask.findFirst({ where: { raceId: f.id } });
      assert.ok(task?.snapshotCommand.displayBoundaryInput);
      const command = task.snapshotCommand;
      command.displayBoundaryInput.scoredAt = new Date(Date.now() - 60000).toISOString();
      if (kind === 'crossed-local') {
        const start = new Date(Date.now() - 30000);
        const end = new Date(Date.now() + 300000);
        const event = await prisma.globalStepEvent.create({ data: { startsAt: start, endsAt: end,
          scheduleMode: 'LOCAL_ENTITLEMENTS', multiplier: 2 } });
        await prisma.globalStepEventEntitlement.create({ data: { eventId: event.id, userId: f.user.user.id,
          startsAt: start, endsAt: end, timezone: 'UTC', localDate: start.toISOString().slice(0, 10), startOutcome: 'PENDING' } });
      }
      if (kind === 'old-command') delete command.displayBoundaryInput;
      if (kind === 'mutated-effects') await redis.set(`${prefix}ce:v1:g:race-effects:${f.id}`, randomUUID(), 'EX', 300);
      // Reconstruct an unattempted durable task from the worker's exact command.
      await prisma.raceResolutionPostTaskReceipt.deleteMany({ where: { raceId: f.id } });
      await prisma.raceResolutionPostTask.update({ where: { id: task.id }, data: {
        state: 'queued', snapshotState: 'pending', snapshotCommand: command, snapshotAttemptId: null,
        snapshotAttemptedAt: null, snapshotCompletedAt: null, snapshotErrorCode: null,
        startedAt: null, completedAt: null, leaseExpiresAt: null, leaseToken: null, notBeforeAt: new Date(),
      } });
      await redis.del(key, `${prefix}v1:race:progress:${f.id}`, `${prefix}v1:race:progress:index:${f.id}`);
      await withWorker(async () => {
        await waitFor(async () => {
          const value = await prisma.raceResolutionPostTask.findUnique({ where: { id: task.id } });
          return value?.snapshotState === 'failed_no_retry' && value;
        });
      });
      const settled = await prisma.raceResolutionPostTask.findUnique({ where: { id: task.id } });
      assert.equal(settled.snapshotErrorCode, kind === 'old-command' ? 'DISPLAY_PROOF_MISSING' : 'DISPLAY_PROOF_INVALID');
      assert.equal(await redis.get(key), null);
      assert.equal((await get(f)).progress.participants[0].totalSteps, 100);
    });
  }
  for (const age of [14, 16, 29, 31]) {
    it(`accepts display age ${age}s only within the thirty-second window`, async () => {
      const f = await fixture();
      const { snapshot, key } = await publish(f);
      assert.equal(snapshot.boundaryProof?.v, 1);
      snapshot.asOf = new Date(Date.now() - age * 1000).toISOString();
      snapshot.boundaryProof.scoredAt = snapshot.asOf;
      snapshot.participants[0].totalSteps = 777;
      await redis.set(key, JSON.stringify(snapshot), 'EX', 300);
      const result = await get(f);
      assert.equal(result.progress.participants[0].totalSteps, age <= 30 ? 777 : 100);
    });
  }
  for (const kind of ['missing', 'crossed', 'generation']) {
    it(`${kind} proof rejects compact and preview shared snapshots`, async () => {
      const f = await fixture();
      const outsider = await createTestUser();
      const { snapshot, key } = await publish(f);
      assert.equal(snapshot.boundaryProof?.v, 1);
      snapshot.participants[0].totalSteps = 777;
      if (kind === 'missing') delete snapshot.boundaryProof;
      if (kind === 'crossed') snapshot.boundaryProof.nextBoundaryAt = new Date(Date.now() - 1).toISOString();
      if (kind === 'generation') await redis.set(`${prefix}ce:v1:g:event:${f.id}`, randomUUID(), 'EX', 300);
      await redis.set(key, JSON.stringify(snapshot), 'EX', 300);
      assert.equal((await get(f)).progress.participants[0].totalSteps, 100);
      assert.equal((await get(f, 'progress?view=compact-v1', outsider)).progress.participants[0].totalSteps, 100);
    });
  }
});
