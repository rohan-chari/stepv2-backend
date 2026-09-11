// Real HTTP across independent API processes plus the production worker probe.
// Fixture SQL and Redis fault injection are test setup; assertions use the GET
// packet that the app consumes. No internal cache/query helpers are imported.
const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IORedis = require('ioredis');
const exec = promisify(execFile);
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'), 'only a dedicated local test database is allowed');
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6404';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
process.env.CACHE_ENV_PREFIX = `t:race-open-transitions:${randomUUID()}:`;
process.env.NODE_ENV = 'production';
process.env.STEPS_PROCESS_ROLE = 'http';
process.env.DATABASE_POOL_MAX_HTTP = '10';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { startRedisFailProxy } = require('./helpers/redisFailProxy');
const HEADERS = {
  'X-Client-Features': 'characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,api_payload_compact_v1,race_leave,team_races,race_preview',
  'X-Timezone': 'UTC', 'X-Release-Channel': 'prod', 'X-App-Version': '99.0.0',
};
let reader, writer, redis;
const children = [];
const bootstrapSettingKeys = ['apiRaceBootstrapV1Enabled', 'apiRaceBootstrapCompactV1Enabled'];
let priorBootstrapSettings;
let priorDailySeed;
async function launch(extraEnv = {}) {
  const child = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], {
    env: { ...process.env, PORT: '0', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '', errors = '';
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-2000); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('API child startup timeout')), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`API child exited ${code}: ${errors.replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s]+/g, '[connection]')}`)); });
    child.stdout.on('data', bytes => {
      output += bytes;
      const match = output.match(/LISTENING (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}
async function fixture({ pending = false } = {}) {
  const alice = await createTestUser({ displayName: 'Transition owner' });
  const bob = await createTestUser({ displayName: 'Transition rival' });
  const startedAt = new Date(Date.now() - 3 * 3600000);
  const race = await prisma.race.create({ data: {
    creatorId: alice.user.id, name: 'Race cache transitions', targetSteps: 200000,
    status: pending ? 'PENDING' : 'ACTIVE', startedAt: pending ? null : startedAt,
    endsAt: new Date(Date.now() + 86400000), timeBased: true, isPublic: false,
    timezone: 'UTC', powerupsEnabled: true, powerupStepInterval: 5000,
  } });
  const participants = [];
  for (const user of [alice, bob]) participants.push(await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.user.id, status: 'ACCEPTED', joinedAt: startedAt,
    rawSteps: 0, totalSteps: 0, boxProgressSteps: 0, nextBoxAtSteps: 5000,
  } }));
  return { alice, bob, race, participants };
}
async function held(f, type, status = 'HELD') {
  return prisma.racePowerup.create({ data: {
    raceId: f.race.id, participantId: f.participants[0].id, userId: f.alice.user.id,
    type, rarity: 'RARE', status,
  } });
}
async function packet(f, { user = f.alice, suffix = '/bootstrap?view=participants-v1&offset=0&limit=15&shape=compact-v1', headers = HEADERS } = {}) {
  const r = await request(reader.baseUrl, 'GET', `/races/${f.race.id}${suffix}`, { token: user.token, headers });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}
async function warm(f, options = {}) {
  const first = await packet(f, options);
  const second = await packet(f, options);
  assert.equal(second.race.status, first.race.status);
  assert.ok((await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:core:${f.race.id}`)).length, 'the reader must actually warm the new race core cache');
  return second;
}
async function use(f, powerup) {
  const response = await request(writer, 'POST', `/races/${f.race.id}/powerups/${powerup.id}/use`, {
    token: f.alice.token, headers: HEADERS, body: {},
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
async function activateViaProductionCron(raceId) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'race-open-seeded-cron-'));
  const child = spawn(process.execPath, [path.resolve('src/index.js')], {
    cwd, env: {
      PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: process.env.DATABASE_URL,
      SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET,
      REDIS_URL: process.env.REDIS_URL, CACHE_ENV_PREFIX: process.env.CACHE_ENV_PREFIX,
      STEPS_PROCESS_ROLE: 'cron', DATABASE_POOL_MAX_CRON: '10', NODE_APP_INSTANCE: '0',
      PORT: '0', HOST: '127.0.0.1', CRON_START_DELAY_MS: '0',
      REFERRAL_IP_HMAC_ACTIVE_VERSION: '1', REFERRAL_IP_HMAC_SECRET_V1: 'integration-test-only-referral-hmac-secret-material',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let recent = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { recent = (recent + String(bytes)).slice(-12000); });
  try {
    let activated = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, recent);
      const race = await prisma.race.findUniqueOrThrow({ where: { id: raceId }, select: { status: true } });
      if (race.status === 'ACTIVE' && recent.includes(raceId)) { activated = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(activated, `actual src/index.js cron process must promote the warmed race: ${recent}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('race-open cached display transitions across actual processes', () => {
  before(async () => {
    redis = new IORedis(process.env.REDIS_URL);
    await redis.ping();
    await cleanDatabase();
    priorBootstrapSettings = await prisma.appSetting.findMany({ where: { key: { in: bootstrapSettingKeys } } });
    priorDailySeed = await prisma.raceSeed.findUniqueOrThrow({ where: { kind: 'DAILY_10K' } });
    await prisma.raceSeed.update({ where: { id: priorDailySeed.id }, data: { active: true } });
    for (const key of bootstrapSettingKeys) {
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
    }
    reader = await getSharedServer();
    writer = await launch();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  });
  after(async () => {
    for (const child of children) if (child.exitCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
    }
    if (priorBootstrapSettings) {
      const retainedKeys = new Set(priorBootstrapSettings.map(row => row.key));
      for (const key of bootstrapSettingKeys) {
        if (!retainedKeys.has(key)) await prisma.appSetting.deleteMany({ where: { key } });
      }
      for (const row of priorBootstrapSettings) {
        await prisma.appSetting.upsert({ where: { key: row.key }, create: row, update: row });
      }
    }
    if (priorDailySeed) await prisma.raceSeed.update({ where: { id: priorDailySeed.id }, data: { active: priorDailySeed.active, updatedAt: priorDailySeed.updatedAt } });
    if (redis) {
      const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  });

  it('a separate powerup writer refreshes slot capacity, active effects and Trail Mix history', async () => {
    const f = await fixture();
    const pack = await held(f, 'FANNY_PACK');
    await held(f, 'TRAIL_MIX');
    const before = await warm(f);
    assert.equal(before.progress.powerupData.powerupSlots, 3);
    assert.equal(before.progress.powerupData.trailMix.uniqueTypesIfUsedNow, 1);
    await use(f, pack);
    const after = await packet(f);
    assert.equal(after.progress.powerupData.powerupSlots, 4);
    assert.equal(after.progress.powerupData.trailMix.uniqueTypesIfUsedNow, 2);
    assert.equal(after.progress.powerupData.inventory.some(row => row.id === pack.id), false);
    assert.ok(after.progress.powerupData.activeEffects.some(row => row.type === 'FANNY_PACK'));
    const other = await packet(f, { user: f.bob });
    assert.equal(other.progress.powerupData.powerupSlots, 3);
    assert.equal(other.progress.powerupData.trailMix, undefined);
  });

  it('real sample intake and a separate resolution worker refresh steps, box gate and queued inventory', async () => {
    const f = await fixture();
    const queued = await held(f, null, 'QUEUED');
    const before = await warm(f);
    assert.equal(before.race.myTotalSteps, 0);
    assert.equal(before.progress.powerupData.stepsUntilNextPowerup, 5000);
    assert.equal(before.progress.powerupData.queuedBoxCount, 1);
    const response = await request(writer, 'POST', '/steps/samples', {
      token: f.alice.token, headers: HEADERS, body: { samples: [{
        periodStart: new Date(Date.now() - 2 * 3600000).toISOString(),
        periodEnd: new Date(Date.now() - 3600000).toISOString(), steps: 6000,
      }] },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    // Scheduling setup only: make the public intake's durable job due now.
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: { notBeforeAt: null } });
    await exec(process.execPath, ['scripts/test-race-resolution-worker-once.js'], {
      env: { ...process.env, STEPS_PROCESS_ROLE: 'resolution', DATABASE_POOL_MAX_RESOLUTION: '10' }, timeout: 30000,
    });
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: f.race.id } });
    assert.equal(job.state, 'SUCCEEDED', JSON.stringify({ state: job.state, error: job.lastErrorCode }));
    const after = await packet(f);
    assert.equal(after.race.myTotalSteps, 6000);
    assert.equal(after.progress.powerupData.stepsUntilNextPowerup, 4000);
    assert.equal(after.progress.powerupData.queuedBoxCount, 0);
    assert.ok(after.progress.powerupData.inventory.some(row => row.id === queued.id));
    assert.equal(after.progress.powerupData.inventory.length, 2, 'promoted queued box plus newly earned 5000-step box');
  });

  it('a separate resolution worker removes warmed mine and socks effects before their time deadlines', async () => {
    const f = await fixture();
    const expiresAt = new Date(Date.now() + 3600000);
    const effects = [];
    for (const [index, type] of ['TRAIL_MINE', 'COMPRESSION_SOCKS'].entries()) {
      const user = index === 0 ? f.alice : f.bob;
      const powerup = await prisma.racePowerup.create({ data: {
        raceId: f.race.id, participantId: f.participants[index].id,
        userId: user.user.id, type, rarity: 'RARE', status: 'USED',
      } });
      effects.push(await prisma.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participants[index].id,
        targetUserId: user.user.id, sourceUserId: user.user.id,
        powerupId: powerup.id, type, status: 'ACTIVE',
        startsAt: new Date(Date.now() - 2 * 3600000), expiresAt,
        ...(index === 0 ? { metadata: {
          ownerParticipantId: f.participants[0].id, positionSteps: 1000,
          penaltyPercent: 0.03, aheadParticipantIds: [],
        } } : {}),
      } }));
    }
    for (const [index, user] of [f.alice, f.bob].entries()) {
      const before = await warm(f, { user });
      assert.ok(before.progress.powerupData.activeEffects.some(row => row.id === effects[index].id));
    }
    const effectKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:effects:${f.race.id}`;
    const cachedBefore = await redis.get(effectKey);
    assert.ok(cachedBefore && effects.every(effect => cachedBefore.includes(effect.id)), 'both active effects must actually be warmed in Redis');
    const synced = await request(writer, 'POST', '/steps/samples', {
      token: f.bob.token, headers: HEADERS, body: { samples: [{
        periodStart: new Date(Date.now() - 90 * 60000).toISOString(),
        periodEnd: new Date(Date.now() - 30 * 60000).toISOString(), steps: 2000,
      }] },
    });
    assert.equal(synced.status, 200, JSON.stringify(await synced.json()));
    await prisma.raceResolutionJobV2.update({ where: { raceId: f.race.id }, data: { notBeforeAt: null } });
    await exec(process.execPath, ['scripts/test-race-resolution-worker-once.js'], {
      env: { ...process.env, STEPS_PROCESS_ROLE: 'resolution', DATABASE_POOL_MAX_RESOLUTION: '10' }, timeout: 30000,
    });
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: f.race.id } });
    assert.equal(job.state, 'SUCCEEDED', JSON.stringify({ state: job.state, error: job.lastErrorCode }));
    for (const [index, user] of [f.alice, f.bob].entries()) {
      const persisted = await prisma.raceActiveEffect.findUniqueOrThrow({ where: { id: effects[index].id } });
      assert.equal(persisted.status, index === 0 ? 'EXPIRED' : 'BLOCKED');
      assert.equal(persisted.expiresAt.toISOString(), expiresAt.toISOString());
      assert.ok(persisted.expiresAt.getTime() > Date.now(), 'time-only filtering must not conceal a missing C0 output invalidation');
      const after = await packet(f, { user });
      assert.equal(after.progress.powerupData.activeEffects.some(row => row.id === effects[index].id), false, `${persisted.type} must disappear immediately after the worker commits`);
    }
  });

  for (const activation of ['cron', 'admission']) it(`seeded ${activation} replaces warmed pending dates and box state immediately`, async () => {
    const f = await fixture({ pending: true });
    const [window] = await prisma.$queryRawUnsafe(`SELECT
      date_trunc('day', clock_timestamp() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS "windowStart",
      (date_trunc('day', clock_timestamp() AT TIME ZONE 'America/New_York') + interval '1 day') AT TIME ZONE 'America/New_York' AS "windowEnd"`);
    await prisma.race.update({ where: { id: f.race.id }, data: {
      seedId: priorDailySeed.id, creatorId: null, scheduledStartAt: window.windowStart,
      startedAt: null, endsAt: activation === 'cron' ? null : window.windowEnd,
      maxParticipants: 35, timezone: 'America/New_York',
    } });
    if (activation === 'cron') await prisma.raceParticipant.updateMany({ where: { raceId: f.race.id }, data: { nextBoxAtSteps: 0 } });
    const before = await warm(f);
    assert.equal(before.race.status, 'PENDING');
    assert.equal(before.race.startedAt, null);
    if (activation === 'cron') assert.equal(before.race.endsAt, null);
    const participantKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:participant:${f.race.id}:${f.participants[0].id}`;
    if (activation === 'cron') assert.equal(JSON.parse(await redis.get(participantKey)).value.nextBoxAtSteps, 0);
    if (activation === 'cron') {
      await activateViaProductionCron(f.race.id);
    } else {
      const joined = await request(writer, 'POST', '/races/seeded/DAILY_10K/join-current', {
        token: f.alice.token, headers: { ...HEADERS, 'X-Client-Features': `${HEADERS['X-Client-Features']},seeded_race_buckets` }, body: { requestId: randomUUID() },
      });
      const body = await joined.json();
      assert.equal(joined.status, 200, JSON.stringify(body));
      assert.equal(body.raceId, f.race.id);
      assert.equal(body.alreadyJoined, true, 'owned admission must activate without an incidental membership write invalidating the cache');
      assert.equal(body.raceStatus, 'ACTIVE');
    }
    const after = await packet(f);
    assert.equal(after.race.status, 'ACTIVE');
    assert.equal(after.race.startedAt, window.windowStart.toISOString());
    assert.equal(after.race.endsAt, window.windowEnd.toISOString());
    assert.equal(after.progress.powerupData.stepsUntilNextPowerup, 5000);
    assert.equal(after.progress.powerupData.powerupSlots, 3);
    const persisted = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.participants[0].id } });
    assert.equal(persisted.nextBoxAtSteps, 5000);
    if (activation === 'cron') assert.equal(JSON.parse(await redis.get(participantKey)).value.nextBoxAtSteps, 5000, 'the viewer fragment must refresh too; derived fallback must not conceal a stale zero gate');
  });

  it('time alone expires a cached finite effect while a null-expiry effect remains visible', async () => {
    const f = await fixture();
    const finitePowerup = await held(f, 'RUNNERS_HIGH', 'USED');
    const permanentPowerup = await held(f, 'COMPRESSION_SOCKS', 'USED');
    const expiresAt = new Date(Date.now() + 2500);
    const effects = [];
    for (const [powerup, expiry] of [[finitePowerup, expiresAt], [permanentPowerup, null]]) {
      effects.push(await prisma.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participants[0].id,
        targetUserId: f.alice.user.id, sourceUserId: f.alice.user.id,
        powerupId: powerup.id, type: powerup.type, status: 'ACTIVE',
        startsAt: new Date(Date.now() - 60000), expiresAt: expiry,
      } }));
    }
    const before = await warm(f);
    for (const effect of effects) assert.ok(before.progress.powerupData.activeEffects.some(row => row.id === effect.id));
    const progressPaths = ['/progress', '/progress?view=compact-v1', '/progress?view=participants-v1&offset=0&limit=15'];
    for (const suffix of progressPaths) {
      const visible = await packet(f, { suffix });
      for (const effect of effects) assert.ok(visible.progress.powerupData.activeEffects.some(row => row.id === effect.id), suffix);
    }
    const oldClient = { suffix: '/progress', headers: { 'X-Timezone': 'UTC' } };
    const oldBefore = await packet(f, oldClient);
    for (const effect of effects) assert.ok(oldBefore.progress.powerupData.activeEffects.some(row => row.id === effect.id));
    const key = `${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:effects:${f.race.id}`;
    assert.ok(await redis.pttl(key) > 0, 'raw effects must be cached before the boundary');
    await new Promise(resolve => setTimeout(resolve, Math.max(0, +expiresAt - Date.now()) + 100));
    const after = await packet(f);
    assert.equal(after.progress.powerupData.activeEffects.some(row => row.id === effects[0].id), false);
    assert.ok(after.progress.powerupData.activeEffects.some(row => row.id === effects[1].id));
    for (const suffix of progressPaths) {
      const visible = await packet(f, { suffix });
      assert.equal(visible.progress.powerupData.activeEffects.some(row => row.id === effects[0].id), false, suffix);
      assert.ok(visible.progress.powerupData.activeEffects.some(row => row.id === effects[1].id), suffix);
    }
    const oldAfter = await packet(f, oldClient);
    assert.equal(oldAfter.progress.powerupData.activeEffects.some(row => row.id === effects[0].id), false);
    assert.ok(oldAfter.progress.powerupData.activeEffects.some(row => row.id === effects[1].id));
    assert.equal((await prisma.raceActiveEffect.findUniqueOrThrow({ where: { id: effects[0].id } })).status, 'ACTIVE', 'no worker or fixture mutation expired the row');
  });

  it('private access is revoked with stale Redis still present and all writer invalidation broadcasts failing', async () => {
    const f = await fixture({ pending: true });
    await warm(f, { user: f.bob });
    const key = `${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:participant:${f.race.id}:${f.participants[1].id}`;
    const stale = await redis.get(key);
    assert.ok(stale, 'revoked member state must have been cached');
    const proxy = await startRedisFailProxy(process.env.REDIS_URL);
    try {
      const unavailableWriter = await launch({ REDIS_URL: proxy.url });
      // A Redis partition must also defeat bypass broadcasts, not merely DEL.
      proxy.arm(['EVAL', 'EVALSHA', 'DEL', 'UNLINK', 'SET', 'MSET', 'PUBLISH', 'GET', 'MGET', 'HGETALL']);
      const kick = await request(unavailableWriter, 'DELETE', `/races/${f.race.id}/participants/${f.bob.user.id}`, {
        token: f.alice.token, headers: HEADERS,
      });
      assert.equal(kick.status, 200, JSON.stringify(await kick.json()));
      assert.ok(proxy.failedCount() > 0);
      assert.equal(await redis.get(key), stale, 'reader Redis retains the revoked member payload');
      for (const suffix of ['', '/progress', '/bootstrap?view=participants-v1&limit=15&shape=compact-v1']) {
        const denied = await request(reader.baseUrl, 'GET', `/races/${f.race.id}${suffix}`, { token: f.bob.token, headers: HEADERS });
        assert.equal(denied.status, 403, `${suffix}: ${JSON.stringify(await denied.json())}`);
      }
      const deniedOldClient = await request(reader.baseUrl, 'GET', `/races/${f.race.id}/bootstrap`, { token: f.bob.token, headers: { 'X-Timezone': 'UTC' } });
      assert.equal(deniedOldClient.status, 403, JSON.stringify(await deniedOldClient.json()));
    } finally {
      proxy.disarm();
      await proxy.close();
    }
  });

  it('old team clients are refused immediately after a Redis-isolated writer expands a warmed team race', async () => {
    const f = await fixture({ pending: true });
    // Both accounts have used a capable build, which authorizes expansion;
    // a frozen older binary on another device must still fail its own GET.
    await prisma.user.updateMany({ where: { id: { in: [f.alice.user.id, f.bob.user.id] } }, data: { clientFeatures: ['team_races', 'team_races_10v10_v1'] } });
    await prisma.race.update({ where: { id: f.race.id }, data: { isTeamRace: true, teamSize: 2, maxParticipants: 4 } });
    for (const [index, participant] of f.participants.entries()) await prisma.raceParticipant.update({ where: { id: participant.id }, data: { team: index === 0 ? 'TEAM_A' : 'TEAM_B' } });
    const oldHeaders = { 'X-Client-Features': 'team_races', 'X-Timezone': 'UTC' };
    const before = await warm(f, { headers: oldHeaders });
    assert.equal(before.race.teamSize, 2);
    const coreKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:core:${f.race.id}`;
    const stale = await redis.get(coreKey);
    assert.ok(stale);
    const proxy = await startRedisFailProxy(process.env.REDIS_URL);
    try {
      const unavailableWriter = await launch({ REDIS_URL: proxy.url });
      proxy.arm(['EVAL', 'EVALSHA', 'DEL', 'UNLINK', 'SET', 'MSET', 'PUBLISH', 'GET', 'MGET', 'HGETALL']);
      const edited = await request(unavailableWriter, 'PATCH', `/races/${f.race.id}`, {
        token: f.alice.token, headers: { ...HEADERS, 'X-Client-Features': `${HEADERS['X-Client-Features']},team_races_10v10_v1` }, body: { teamSize: 10 },
      });
      const body = await edited.json();
      assert.equal(edited.status, 200, JSON.stringify(body));
      assert.equal(body.race.teamSize, 10);
      assert.ok(proxy.failedCount() > 0);
      assert.equal(await redis.get(coreKey), stale, 'small-team Redis core remains unchanged despite the authoritative expansion');
      for (const suffix of ['', '/progress', '/bootstrap']) {
        const denied = await request(reader.baseUrl, 'GET', `/races/${f.race.id}${suffix}`, { token: f.alice.token, headers: oldHeaders });
        const error = await denied.json();
        assert.equal(denied.status, 400, `${suffix}: ${JSON.stringify(error)}`);
        assert.equal(error.code, 'UPDATE_REQUIRED');
      }
    } finally {
      proxy.disarm();
      await proxy.close();
    }
  });
});
