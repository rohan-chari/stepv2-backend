process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { once } = require('node:events');
const IORedis = require('ioredis');
const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(databaseUrl.hostname) && databaseUrl.pathname.endsWith('_test'));
process.env.CACHE_ENV_PREFIX = 't:ce-personal-readers:';
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6402';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require('./setup');
let server, sibling, child, redis, observed;
prisma.$on('query', event => { if (observed) observed.push(event); });
const cacheKey = (user, date) => `${process.env.CACHE_ENV_PREFIX}ce:v1:milestones:${user.user.id}:${date}`;
async function get(base, user, date) {
  const response = await request(base, 'GET', `/users/me/step-milestones/today?localDate=${date}`, { token: user.token });
  assert.equal(response.status, 200);
  return response.json();
}
const extraChildren = [];
async function launchProductionReader() {
  const processHandle = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], {
    env: { ...process.env, PORT: '0', NODE_ENV: 'production', STEPS_PROCESS_ROLE: 'http', DATABASE_POOL_MAX_HTTP: '20', PRISMA_QUERY_EVENTS_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  extraChildren.push(processHandle);
  let errors = '';
  processHandle.stderr.on('data', bytes => { errors = (errors + String(bytes)).slice(-2500); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Production reader did not start')), 10000);
    processHandle.once('exit', code => { clearTimeout(timer); reject(new Error(`Production reader exited ${code}: ${errors.replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s]+/g, '[connection]')}`)); });
    processHandle.stdout.on('data', bytes => { const match = String(bytes).match(/LISTENING (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
}
describe('personal Redis displays across actual API workers', () => {
  before(async () => {
    redis = new IORedis(process.env.REDIS_URL);
    server = await getSharedServer();
    child = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], { cwd: process.env.CACHE_TEST_WRITER_ROOT || process.cwd(), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    sibling = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sibling API failed to start')), 10000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Sibling API exited ${code}`)); });
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
    await redis.quit();
    for (const extra of extraChildren) if (extra.exitCode === null) { const closed = once(extra, 'exit'); extra.kill('SIGTERM'); await closed; }
    if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
  });
  it('warm milestones eliminate display SQL and sibling writes immediately invalidate steps/claims', async () => {
    const alice = await createTestUser({ displayName: 'Cached milestones' });
    const date = new Date().toISOString().slice(0, 10);
    const initial = await get(server.baseUrl, alice, date);
    assert.equal(initial.currentSteps, 0);
    assert.ok(await redis.pttl(cacheKey(alice, date)) > 0);
    assert.ok(await redis.pttl(cacheKey(alice, date)) <= 30000);
    observed = [];
    assert.deepEqual(await get(server.baseUrl, alice, date), initial);
    const milestoneSql = observed.filter(event => /\b(?:steps|step_milestone_claims)\b/.test(event.query));
    observed = null;
    assert.equal(milestoneSql.length, 0, JSON.stringify(milestoneSql));
    const upload = await request(sibling, 'POST', '/steps', { token: alice.token, body: { date, steps: 6000 } });
    assert.equal(upload.status, 200);
    const updated = await get(server.baseUrl, alice, date);
    assert.equal(updated.currentSteps, 6000);
    assert.equal(updated.milestones.find(row => row.threshold === 5000).claimable, true);
    const claim = await request(sibling, 'POST', '/users/me/step-milestones/5000/claim', { token: alice.token, body: { localDate: date } });
    assert.equal(claim.status, 200);
    const claimed = await get(server.baseUrl, alice, date);
    assert.equal(claimed.milestones.find(row => row.threshold === 5000).claimed, true);
    const bob = await createTestUser({ displayName: 'Separate user' });
    assert.equal((await get(server.baseUrl, bob, date)).currentSteps, 0);
  });
  it('different local dates, malformed payload and missing generation all use authoritative values', async () => {
    const user = await createTestUser({ displayName: 'Cache isolation' });
    const date = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await prisma.step.create({ data: { userId: user.user.id, date: new Date(yesterday), steps: 7500 } });
    assert.equal((await get(server.baseUrl, user, yesterday)).currentSteps, 7500);
    assert.equal((await get(server.baseUrl, user, date)).currentSteps, 0);
    await redis.set(cacheKey(user, date), '{broken', 'EX', 30);
    assert.equal((await get(server.baseUrl, user, date)).currentSteps, 0);
    await prisma.step.create({ data: { userId: user.user.id, date: new Date(date), steps: 4000 } });
    await redis.del(`${process.env.CACHE_ENV_PREFIX}ce:v1:g:milestones:${user.user.id}:${date}`);
    assert.equal((await get(server.baseUrl, user, date)).currentSteps, 4000);
  });
  it('race slot display shares a 30s fragment and sibling discard replaces it before next GET', async () => {
    const user = await createTestUser({ displayName: 'Slot reader' });
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Slots', targetSteps: 500000,
      status: 'ACTIVE', startedAt: new Date(), endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000 } });
    const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: 'ACCEPTED' } });
    const box = await prisma.racePowerup.create({ data: { raceId: race.id, userId: user.user.id, participantId: participant.id,
      status: 'MYSTERY_BOX', earnedAtSteps: 5000 } });
    const progress = async () => {
      const response = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, { token: user.token });
      assert.equal(response.status, 200); return (await response.json()).progress;
    };
    const first = await progress();
    assert.ok(first.powerupData.inventory.some(row => row.id === box.id));
    const key = `${process.env.CACHE_ENV_PREFIX}ce:v1:slots:${race.id}:${user.user.id}:${participant.id}`;
    assert.ok(await redis.pttl(key) > 0);
    assert.ok(await redis.pttl(key) <= 30000);
    const cached = await redis.get(key);
    observed = [];
    assert.ok((await progress()).powerupData.inventory.some(row => row.id === box.id));
    const inventorySql = observed.filter(event => /race_powerups/.test(event.query) && event.params.includes(participant.id));
    observed = null;
    assert.equal(inventorySql.length, 0, JSON.stringify(inventorySql));
    assert.equal(await redis.get(key), cached);
    const discard = await request(sibling, 'POST', `/races/${race.id}/powerups/${box.id}/discard`, { token: user.token });
    assert.equal(discard.status, 200);
    assert.equal((await progress()).powerupData.inventory.some(row => row.id === box.id), false);
    assert.notEqual(await redis.get(key), cached);
  });

  it('a rolled-back daily write does not publish its registered cache invalidation', async () => {
    const user = await createTestUser({ displayName: 'Rollback user' });
    const date = new Date().toISOString().slice(0, 10);
    await prisma.race.create({ data: { creatorId: user.user.id, name: 'Rollback race', targetSteps: 500000,
      status: 'ACTIVE', startedAt: new Date(), participants: { create: { userId: user.user.id, status: 'ACCEPTED' } } } });
    const before = await get(server.baseUrl, user, date);
    const payload = await redis.get(cacheKey(user, date));
    const markerKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:g:milestones:${user.user.id}:${date}`;
    const marker = await redis.get(markerKey);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ce_reject_queue_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cache test rollback after daily hook registration'; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER ce_reject_queue BEFORE INSERT OR UPDATE ON race_resolution_jobs_v2 FOR EACH ROW EXECUTE FUNCTION ce_reject_queue_write()');
    try {
      const response = await request(sibling, 'POST', '/steps', { token: user.token, body: { date, steps: 6500 } });
      assert.equal(response.status, 500);
      assert.equal(await prisma.step.count({ where: { userId: user.user.id } }), 0);
      assert.equal(await redis.get(markerKey), marker);
      assert.deepEqual(await get(server.baseUrl, user, date), before);
      assert.equal(await redis.get(cacheKey(user, date)), payload);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER ce_reject_queue ON race_resolution_jobs_v2');
      await prisma.$executeRawUnsafe('DROP FUNCTION ce_reject_queue_write()');
    }
  });
  it('a sibling steal invalidates both actor and victim slot displays', async () => {
    const actor = await createTestUser({ displayName: 'Actor' });
    const victim = await createTestUser({ displayName: 'Victim' });
    const race = await prisma.race.create({ data: { creatorId: actor.user.id, name: 'Steal cache', targetSteps: 500000,
      status: 'ACTIVE', startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000 } });
    const participants = await Promise.all([actor, victim].map(user => prisma.raceParticipant.create({ data: {
      raceId: race.id, userId: user.user.id, status: 'ACCEPTED', joinedAt: race.startedAt,
    } })));
    const steal = await prisma.racePowerup.create({ data: { raceId: race.id, userId: actor.user.id, participantId: participants[0].id,
      status: 'HELD', type: 'SNEAKY_SWAP', rarity: 'RARE', earnedAtSteps: 1000 } });
    const target = await prisma.racePowerup.create({ data: { raceId: race.id, userId: victim.user.id, participantId: participants[1].id,
      status: 'HELD', type: 'TRAIL_MIX', rarity: 'COMMON', earnedAtSteps: 5000 } });
    const slots = async user => {
      const response = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, { token: user.token });
      assert.equal(response.status, 200); return (await response.json()).progress.powerupData.inventory;
    };
    assert.ok((await slots(actor)).some(row => row.id === steal.id));
    assert.ok((await slots(victim)).some(row => row.id === target.id));
    const response = await request(sibling, 'POST', `/races/${race.id}/powerups/${steal.id}/use`, { token: actor.token, body: { targetUserId: victim.user.id } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.result.stolenPowerup.id, target.id);
    assert.ok((await slots(actor)).some(row => row.id === target.id));
    assert.equal((await slots(victim)).some(row => row.id === target.id), false);
  });

  it('failed A invalidation opens B read bypass until real Redis recovery', async () => {
    const { startRedisFailProxy } = require('./helpers/redisFailProxy');
    const proxy = await startRedisFailProxy(process.env.REDIS_URL);
    const writer = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], {
      cwd: process.env.CACHE_TEST_WRITER_ROOT || process.cwd(),
      env: { ...process.env, PORT: '0', REDIS_URL: proxy.url }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Fault writer did not start')), 10000);
        writer.once('exit', code => { clearTimeout(timer); reject(new Error(`Fault writer exited ${code}`)); });
        writer.stdout.on('data', bytes => { const match = String(bytes).match(/LISTENING (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      });
      const user = await createTestUser({ displayName: 'Redis recovery' });
      const date = new Date().toISOString().slice(0, 10);
      assert.equal((await get(server.baseUrl, user, date)).currentSteps, 0);
      const payload = await redis.get(cacheKey(user, date));
      proxy.arm(['EVAL', 'DEL']);
      const response = await request(base, 'POST', '/steps', { token: user.token, body: { date, steps: 7000 } });
      assert.equal(response.status, 200);
      assert.ok(proxy.failedCount() > 0);
      assert.equal(await redis.get(cacheKey(user, date)), payload, 'fault leaves the stale payload in Redis');
      assert.equal((await get(server.baseUrl, user, date)).currentSteps, 7000, 'healthy sibling must bypass stale Redis after failed invalidation');
      proxy.disarm();
      const markerKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:g:milestones:${user.user.id}:${date}`;
      const original = JSON.parse(payload).tokens[0];
      const deadline = Date.now() + 5000;
      while (await redis.get(markerKey) === original && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.notEqual(await redis.get(markerKey), original);
      assert.equal((await get(server.baseUrl, user, date)).currentSteps, 7000);
    } finally {
      proxy.disarm();
      if (writer.exitCode === null) { const closed = once(writer, 'exit'); writer.kill('SIGTERM'); await closed; }
      await proxy.close();
    }
  });

  it('a late sibling bulk-cache fill cannot resurrect inventory discarded by an A writer', async () => {
    const user = await createTestUser({ displayName: 'Bulk fence ordering' });
    const fixtures = [];
    for (let index = 0; index < 2; index++) {
      const race = await prisma.race.create({ data: { creatorId: user.user.id, name: `Bulk race ${index}`, targetSteps: 500000,
        status: 'ACTIVE', startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000 } });
      const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: 'ACCEPTED' } });
      const box = await prisma.racePowerup.create({ data: { raceId: race.id, userId: user.user.id, participantId: participant.id,
        status: 'MYSTERY_BOX', earnedAtSteps: 5000 } });
      fixtures.push({ race, participant, box });
    }
    // Instrument only transport scheduling. Every read/write still enters via
    // real HTTP and executes the real handler, PostgreSQL and Redis chain.
    const transport = require('../../src/shared/cache/redisCache');
    const originalEval = transport.evalLua;
    let releaseLate;
    const late = new Promise(resolve => { releaseLate = resolve; });
    let firstParticipant, heldLate = false, mutation;
    const slots = fixtures.map(row => `participant:${row.participant.id}`);
    transport.evalLua = async function(script, keys, args) {
      const isSlot = keys.some(key => key.includes('g:slots:participant:'));
      const ensure = script.includes("'NX'") && isSlot;
      if (ensure && keys.length === 2) {
        const identity = slots.find(value => keys.some(key => key.endsWith(value)));
        if (!firstParticipant) firstParticipant = identity;
        else if (identity !== firstParticipant && !heldLate) { heldLate = true; await late; }
      }
      if (script.includes("redis.call('SET', KEYS[1], ARGV[1], 'PX'") && keys[0].includes('ce:v1:slots:') && !mutation) {
        const target = fixtures.find(row => `participant:${row.participant.id}` !== firstParticipant) || fixtures[1];
        mutation = (async () => {
          const response = await request(sibling, 'POST', `/races/${target.race.id}/powerups/${target.box.id}/discard`, { token: user.token });
          assert.equal(response.status, 200);
          releaseLate();
          return target;
        })();
        await mutation;
      }
      return originalEval.call(this, script, keys, args);
    };
    try {
      const response = await request(server.baseUrl, 'GET', '/races', { token: user.token });
      assert.equal(response.status, 200);
      assert.ok(mutation, 'HTTP list exercised bulk inventory cache publication');
      const target = await mutation;
      const next = await request(server.baseUrl, 'GET', `/races/${target.race.id}/progress`, { token: user.token });
      assert.equal(next.status, 200);
      assert.equal((await next.json()).progress.powerupData.inventory.some(row => row.id === target.box.id), false,
        'next HTTP GET must never reuse pre-discard bulk rows under a post-discard marker');
    } finally { releaseLate(); transport.evalLua = originalEval; }
  });

  it('measures actual cold/warm SQL and Redis work for personal display endpoints', async (t) => {
    const commandCounts = async () => Object.fromEntries((await redis.info('commandstats')).split('\n')
      .map(line => line.match(/^cmdstat_([^:]+):calls=(\d+)/)).filter(Boolean).map(match => [match[1], Number(match[2])]));
    const measure = async (fetch) => {
      const beforeCommands = await commandCounts();
      observed = [];
      const body = await fetch();
      const queries = observed; observed = null;
      const afterCommands = await commandCounts();
      const commands = Object.fromEntries(Object.entries(afterCommands).filter(([name]) => name !== 'info')
        .map(([name, count]) => [name, count - (beforeCommands[name] || 0)]).filter(([, count]) => count));
      return { body, queries, commands };
    };
    const user = await createTestUser({ displayName: 'Measured personal displays' });
    const date = new Date().toISOString().slice(0, 10);
    const coldMilestone = await measure(() => get(server.baseUrl, user, date));
    const warmMilestone = await measure(() => get(server.baseUrl, user, date));
    assert.deepEqual(warmMilestone.body, coldMilestone.body);
    const milestoneQueries = result => result.queries.filter(row => /\b(?:steps|step_milestone_claims)\b/.test(row.query)).length;
    assert.ok(milestoneQueries(coldMilestone) > 0);
    assert.equal(milestoneQueries(warmMilestone), 0);
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Measured slots', targetSteps: 500000,
      status: 'ACTIVE', startedAt: new Date(), endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000 } });
    const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: 'ACCEPTED' } });
    await prisma.racePowerup.create({ data: { raceId: race.id, userId: user.user.id, participantId: participant.id,
      status: 'MYSTERY_BOX', earnedAtSteps: 5000 } });
    const progress = async () => {
      const response = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, { token: user.token });
      assert.equal(response.status, 200); return (await response.json()).progress;
    };
    const coldSlots = await measure(progress);
    const warmSlots = await measure(progress);
    assert.deepEqual(warmSlots.body.powerupData.inventory, coldSlots.body.powerupData.inventory);
    const slotQueries = result => result.queries.filter(row => /race_powerups/.test(row.query) && row.params.includes(participant.id)).length;
    assert.ok(slotQueries(coldSlots) > 0);
    assert.equal(slotQueries(warmSlots), 0);
    const slotKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:slots:${race.id}:${user.user.id}:${participant.id}`;
    for (const [kind, cold, warm, relevant, key] of [
      ['milestones', coldMilestone, warmMilestone, milestoneQueries, cacheKey(user, date)],
      ['slots', coldSlots, warmSlots, slotQueries, slotKey],
    ]) t.diagnostic(JSON.stringify({ kind, cold: { totalSql: cold.queries.length, relevantSql: relevant(cold), redisCommandsIncludingLuaInternals: cold.commands },
      warm: { totalSql: warm.queries.length, relevantSql: relevant(warm), redisCommandsIncludingLuaInternals: warm.commands },
      cachePayloadBytes: Buffer.byteLength(await redis.get(key)) }));
  });

  it('a separate resolution worker mints/promotes boxes and invalidates warm viewer slots', async () => {
    const reader = await launchProductionReader();
    const user = await createTestUser({ displayName: 'Worker slots' });
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Worker inventory', targetSteps: 500000,
      status: 'ACTIVE', startedAt: new Date(Date.now() - 3 * 3600000), endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000 } });
    const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: 'ACCEPTED', joinedAt: race.startedAt, nextBoxAtSteps: 5000 } });
    await prisma.racePowerup.createMany({ data: [100].map(earnedAtSteps => ({
      raceId: race.id, userId: user.user.id, participantId: participant.id, status: 'MYSTERY_BOX', earnedAtSteps,
    })) });
    const queued = await prisma.racePowerup.create({ data: { raceId: race.id, userId: user.user.id, participantId: participant.id,
      status: 'QUEUED', earnedAtSteps: 300 } });
    const progress = async () => {
      const response = await request(reader, 'GET', `/races/${race.id}/progress`, { token: user.token });
      assert.equal(response.status, 200); return (await response.json()).progress.powerupData;
    };
    const before = await progress();
    assert.equal(before.inventory.length, 1); assert.equal(before.queuedBoxCount, 1);
    const markerKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:g:slots:participant:${participant.id}`;
    const original = await redis.get(markerKey);
    const response = await request(sibling, 'POST', '/steps/samples', { token: user.token, body: { samples: [{
      periodStart: new Date(Date.now() - 2 * 3600000).toISOString(), periodEnd: new Date(Date.now() - 3600000).toISOString(), steps: 6000,
    }] } });
    assert.equal(response.status, 200);
    await prisma.raceResolutionJobV2.update({ where: { raceId: race.id }, data: { notBeforeAt: null } });
    await exec(process.execPath, ['scripts/test-race-resolution-worker-once.js'], {
      cwd: process.env.CACHE_TEST_WRITER_ROOT || process.cwd(), env: { ...process.env, NODE_ENV: 'production', STEPS_PROCESS_ROLE: 'resolution', DATABASE_POOL_MAX_RESOLUTION: '20', PRISMA_QUERY_EVENTS_ENABLED: 'false' }, timeout: 30000,
    });
    const job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
    assert.equal(job.state, 'SUCCEEDED', JSON.stringify({ state: job.state, error: job.lastErrorCode }));
    const after = await progress();
    assert.ok(after.inventory.some(row => row.id === queued.id), 'real worker promotes the queued box into an open slot');
    assert.notEqual(await redis.get(markerKey), original);
    assert.ok(await prisma.racePowerup.findFirst({ where: { participantId: participant.id, earnedAtSteps: 5000 } }), 'real worker mints the newly earned threshold');
  });

});
