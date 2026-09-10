// Dedicated local 2,000-user HTTP step burst with a bounded concurrency of 16.
// Sources stay PostgreSQL; the production worker drains its real durable queue.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const IORedis = require('ioredis');
const jwt = require('jsonwebtoken');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
assert.ok(process.env.REDIS_TEST_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_TEST_URL).hostname));
process.env.REDIS_URL = process.env.REDIS_TEST_URL;
process.env.CACHE_ENV_PREFIX = 't:ce-burst:';
process.env.SESSION_TOKEN_SECRET ||= 'cache-efficiency-dedicated-local-burst-secret';
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
process.env.NODE_ENV = 'test';
const { prisma } = require('../../../src/db');
process.env.NODE_ENV = 'production';
process.env.STEPS_PROCESS_ROLE = 'http';
const { cleanDatabase, request, getSharedServer } = require('../setup');
const redis = new IORedis(process.env.REDIS_URL);
const count = 2000, concurrency = 16;
let observed = false, sql = { statements: 0, writes: 0, queueWrites: 0 }, child;
prisma.$on('query', event => {
  if (!observed) return;
  sql.statements++;
  if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(event.query)) sql.writes++;
  if (/^\s*(?:INSERT|UPDATE)/i.test(event.query) && /race_resolution_jobs_v2/.test(event.query)) sql.queueWrites++;
});
async function main() {
  await cleanDatabase();
  // The observing worker uses test mode to expose SQL events. Match the two
  // permanent production drain settings rather than historical test defaults.
  for (const key of ['raceResolutionAdaptiveDrainV1Enabled', 'raceResolutionPostTaskAdaptiveDrainV1Enabled']) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
  }
  const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`); if (keys.length) await redis.del(...keys);
  const users = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), appleId: `burst-${randomUUID()}`, displayName: `Burst${i}`, timezone: 'UTC' }));
  for (let i = 0; i < count; i += 256) await prisma.user.createMany({ data: users.slice(i, i + 256) });
  const race = await prisma.race.create({ data: { creatorId: users[0].id, name: '2000-user cache efficiency burst', targetSteps: 1000000,
    status: 'ACTIVE', powerupsEnabled: false, timezone: 'UTC', startedAt: new Date(Date.now() - 86400000), endsAt: new Date(Date.now() + 86400000), maxParticipants: 5000 } });
  for (let i = 0; i < count; i += 256) await prisma.raceParticipant.createMany({ data: users.slice(i, i + 256).map(user => ({ raceId: race.id, userId: user.id, status: 'ACCEPTED', joinedAt: new Date(Date.now() - 86400000) })) });
  const tokens = users.map(user => jwt.sign({ appleId: user.appleId }, process.env.SESSION_TOKEN_SECRET, { subject: user.id, issuer: 'steps-tracker-api', expiresIn: '1h', algorithm: 'HS256' }));
  const server = await getSharedServer();
  const date = new Date().toISOString().slice(0, 10), durations = [], failures = [];
  const redisBefore = await redis.info('commandstats');
  observed = true;
  const started = performance.now(); let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++; if (index >= count) return;
      const at = performance.now();
      const response = await request(server.baseUrl, 'POST', '/steps', { token: tokens[index], body: { date, steps: 6000 } });
      durations.push(performance.now() - at);
      if (response.status !== 200) failures.push({ index, status: response.status, body: await response.json() });
    }
  }));
  const durationMs = performance.now() - started;
  observed = false;
  const redisAfter = await redis.info('commandstats');
  assert.deepEqual(failures, []);
  assert.equal(await prisma.step.count({ where: { userId: { in: users.map(user => user.id) } } }), count);
  const aggregate = await prisma.step.aggregate({ where: { userId: { in: users.map(user => user.id) } }, _sum: { steps: true } });
  assert.equal(aggregate._sum.steps, count * 6000);
  assert.equal(await prisma.raceResolutionJobV2.count({ where: { raceId: race.id } }), 1);
  assert.equal((await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:g:milestones:*:${date}`)).length, count);
  // Sample real display refreshes after every writer response has completed.
  for (let i = count - 16; i < count; i++) {
    const response = await request(server.baseUrl, 'GET', `/users/me/step-milestones/today?localDate=${date}`, { token: tokens[i] });
    assert.equal(response.status, 200); assert.equal((await response.json()).currentSteps, 6000);
  }
  const workerSql = { statements: 0, writes: 0 };
  const workerStarted = performance.now();
  const workerEnv = { ...process.env, NODE_ENV: 'test', STEPS_PROCESS_ROLE: 'resolution', NODE_APP_INSTANCE: '0', PORT: '0', CRON_START_DELAY_MS: '0', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0' };
  // Do not inherit the Node test runner's historical permanent-flag defaults.
  // Keep local SQL observation enabled while selecting production's permanent settings.
  delete workerEnv.NODE_TEST_CONTEXT;
  child = spawn(process.execPath, ['--require', './test/integration/fixtures/query-efficiency/observe-resolution.cjs', 'src/index.js'], {
    cwd: process.cwd(), env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let workerOutput = '';
  child.stdout.on('data', data => { workerOutput += data; if (workerOutput.length > 200000) workerOutput = workerOutput.slice(-200000); });
  child.stderr.on('data', data => { workerOutput += data; });
  child.on('message', event => { if (event.kind === 'query') { workerSql.statements++; if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(event.query)) workerSql.writes++; } });
  const deadline = Date.now() + 120000; let job;
  while (Date.now() < deadline) {
    job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
    const remainingTriggers = await prisma.raceResolutionFullTrigger.count({ where: { raceId: race.id } });
    const pendingTasks = await prisma.raceResolutionPostTask.count({ where: { raceId: race.id, completedAt: null } });
    if (job?.committedGeneration === job?.generation && job?.lastCompletedAt && remainingTriggers === 0 && pendingTasks === 0) break;
    if (child.exitCode !== null) throw new Error(`Worker exited: ${workerOutput.slice(-6000)}`);
    await delay(100);
  }
  assert.ok(job?.committedGeneration === job?.generation && job?.lastCompletedAt, workerOutput.slice(-6000));
  assert.equal(await prisma.raceResolutionFullTrigger.count({ where: { raceId: race.id } }), 0);
  assert.equal(await prisma.raceResolutionPostTask.count({ where: { raceId: race.id, completedAt: null } }), 0);
  const totals = await prisma.raceParticipant.aggregate({ where: { raceId: race.id }, _sum: { totalSteps: true } });
  assert.equal(totals._sum.totalSteps, count * 6000);
  const workerDurationMs = performance.now() - workerStarted;
  const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed;
  durations.sort((a, b) => a - b);
  const parse = info => Object.fromEntries([...info.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)].filter(match => match[1] !== 'info').map(match => [match[1], Number(match[2])]));
  const before = parse(redisBefore), after = parse(redisAfter);
  const commands = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] || 0)]).filter(([, value]) => value));
  const report = { measuredAt: new Date().toISOString(), users: count, concurrency, successfulWrites: count, durableSteps: aggregate._sum.steps,
    durableQueueRows: 1, resolvedParticipantSteps: totals._sum.totalSteps, requestedGeneration: job.generation, committedGeneration: job.committedGeneration,
    durationMs: Math.round(durationMs), p50Ms: durations[Math.floor(count * .5)], p95Ms: durations[Math.floor(count * .95)], p99Ms: durations[Math.floor(count * .99)],
    sql, redisCommands: commands, workerSql, workerDurationMs: Math.round(workerDurationMs) };
  assert.ok(process.env.CACHE_TEST_EVIDENCE_PATH);
  await fs.writeFile(process.env.CACHE_TEST_EVIDENCE_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().then(async () => { await redis.quit(); await prisma.$disconnect(); process.exit(0); }, async error => {
  console.error(error); if (child?.exitCode === null) child.kill('SIGTERM'); await redis.quit(); await prisma.$disconnect(); process.exit(1);
});
