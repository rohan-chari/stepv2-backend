#!/usr/bin/env node
// Local synthetic HTTP workload. Requires a fresh dedicated *_load_test DB.
// This process profile measures total SQL work and contention, not prod CPU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { databaseSnapshot, databaseDelta, queueSample, sourceIdentity } = require('./seeded-load-metrics');
const { setTimeout: delay } = require('node:timers/promises');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const i = arg.indexOf('=');
  assert.ok(arg.startsWith('--') && i > 2, 'Arguments must use --name=value');
  return [arg.slice(2, i), arg.slice(i + 1)];
}));
const url = new URL(process.env.DATABASE_URL || 'invalid:');
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Loopback database only');
assert.equal(url.port, '55439', 'Dedicated local PG18 port only');
assert.match(url.pathname, /_load_test$/, 'Dedicated load-test database required');
const root = path.resolve(args.root || process.cwd());
const output = path.resolve(args.output || '');
assert.ok(args.output && !fs.existsSync(output), 'A new evidence output is required');
const usersCount = Number(args.users || 1000);
const concurrency = Number(args.concurrency || 8);
assert.ok(Number.isInteger(usersCount) && usersCount >= 100 && usersCount <= 10000);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 32);
process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET = 'seeded-load-local-only-secret';
process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = '1';
process.env.REFERRAL_IP_HMAC_SECRET_V1 = 'seeded-load-local-only-hmac-material';
process.env.CACHE_ENV_PREFIX = `seeded-load-${process.pid}:`;
process.env.REDIS_URL = args.redis || 'redis://127.0.0.1:56379';
process.env.DATABASE_POOL_MAX_ALL = '20';
process.env.ASYNC_RACE_RESOLUTION_CONCURRENCY = '2';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '30000';
process.env.DOTENV_CONFIG_QUIET = 'true';

// A progressing virtual ET boundary exercises the same calendar window in
// baseline and candidate. Wall timings use performance.now(), never this clock.
const NativeDate = Date;
let phaseEpoch = new NativeDate('2026-09-14T03:14:00Z').getTime();
let phaseWall = NativeDate.now();
global.Date = class ScenarioDate extends NativeDate {
  constructor(...values) { super(...(values.length ? values : [phaseEpoch + NativeDate.now() - phaseWall])); }
  static now() { return phaseEpoch + NativeDate.now() - phaseWall; }
};
function advance(iso) { phaseEpoch = new NativeDate(iso).getTime(); phaseWall = NativeDate.now(); }

const requireTarget = createRequire(path.join(root, 'package.json'));
const { Client } = requireTarget('pg');
let measured = false;
const transactionDurations = [];
const sql = { calls: 0, errors: 0, elapsedMs: 0, affectedRows: 0, verbs: {}, errorCodes: {} };
const nativeQuery = Client.prototype.query;
Client.prototype.query = function measuredQuery(...queryArgs) {
  const text = typeof queryArgs[0] === 'string' ? queryArgs[0] : queryArgs[0]?.text || '';
  const count = measured && !text.includes('seeded_load_monitor');
  const start = performance.now();
  let done = false;
  const record = (error, result) => {
    if (!count || done) return;
    done = true;
    const verb = text.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '').match(/^\w+/)?.[0]?.toUpperCase() || 'OTHER';
    sql.calls += 1;
    sql.errors += error ? 1 : 0;
    if (error) { const key = `${error.code || "UNKNOWN"}:${error.constraint || error.message?.slice(0,100) || "unknown"}`; sql.errorCodes[key] = (sql.errorCodes[key] || 0) + 1; }
    sql.elapsedMs += performance.now() - start;
    sql.affectedRows += Number(result?.rowCount) || 0;
    sql.verbs[verb] = (sql.verbs[verb] || 0) + 1;
    if (verb === 'BEGIN') this.seededTransactionStart = start;
    if ((verb === 'COMMIT' || verb === 'ROLLBACK') && this.seededTransactionStart != null) { transactionDurations.push(performance.now() - this.seededTransactionStart); this.seededTransactionStart = null; }
  };
  const cbIndex = queryArgs.findLastIndex((value) => typeof value === 'function');
  if (cbIndex >= 0) {
    const callback = queryArgs[cbIndex];
    queryArgs[cbIndex] = (error, result) => { record(error, result); callback(error, result); };
  }
  let result;
  try { result = nativeQuery.apply(this, queryArgs); }
  catch (error) { record(error); throw error; }
  if (cbIndex >= 0) return result;
  if (result?.then) return result.then((value) => { record(null, value); return value; }, (error) => { record(error); throw error; });
  return result;
};

const { prisma } = requireTarget('./src/db');
const { cleanDatabase, startServer, request } = requireTarget('./test/integration/setup');
const { signSessionToken } = requireTarget('./src/modules/users/services/sessionToken');
const { appSettings } = requireTarget('./src/shared/config/appSettings');
const { windowFor } = requireTarget('./src/modules/races/services/seededRaceBuckets');
const { buildRaceResolutionWorkerV2 } = requireTarget('./src/modules/races/jobs/raceResolutionQueueV2');
const { buildRaceResolutionPostTaskRunner } = requireTarget('./src/modules/races/jobs/raceResolutionPostTaskRunner');
const { buildRacePlacementTransitionWorker } = requireTarget('./src/modules/races/jobs/racePlacementTransitionWorker');
const features = { 'X-Client-Features': 'seeded_race_buckets,api_payload_compact_v1', 'X-App-Version': '2.3.13', 'X-Timezone': 'America/New_York' };
const quantile = (rows, q) => rows.length ? [...rows].sort((a, b) => a - b)[Math.min(rows.length - 1, Math.floor(rows.length * q))] : null;
const chunks = async (rows, fn, size = 500) => { for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size)); };
const stats = (rows) => ({ count: rows.length, p50Ms: quantile(rows, 0.5), p95Ms: quantile(rows, 0.95), p99Ms: quantile(rows, 0.99), maxMs: rows.length ? Math.max(...rows) : null });

async function main() {
  const sourceBefore = sourceIdentity(root);
  const mode = args.mode || 'candidate';
  assert.ok(['baseline', 'candidate'].includes(mode));
  const monitor = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'seeded_load_monitor' });
  await monitor.connect();
  const identity = (await monitor.query('/*seeded_load_monitor*/ SELECT current_database() db,version() version')).rows[0];
  assert.match(identity.db, /_load_test$/); assert.match(identity.version, /PostgreSQL 18\./);
  assert.equal(await prisma.user.count(), 0, 'Fresh load database only');
  await cleanDatabase();
  const users = Array.from({ length: usersCount }, (_, i) => ({ id: randomUUID(), appleId: `rollover-${randomUUID()}`,
    displayName: `rollover_${i}`, autoJoinFeaturedRaces: false, clientFeatures: ['seeded_race_buckets'],
    createdAt: new Date('2026-07-01T12:00:00Z'), timezone: 'America/New_York', globalEventTimezone: 'America/New_York' }));
  await chunks(users, data => prisma.user.createMany({ data }));
  // Historical step fixtures require the same durable input generation that
  // normal ingestion establishes; sample-only users are invalid scoring input.
  await chunks(users.map(user => ({ userId: user.id, generation: 1n })), data => prisma.userScoringInputVersion.createMany({ data }));
  await prisma.user.create({ data: { appleId: `rollover-compatibility-${randomUUID()}`, autoJoinFeaturedRaces: true, clientFeatures: [], createdAt: new Date(), timezone: 'America/New_York' } });
  // Both completed ET days have activity, so the scheduled inactivity policy
  // cannot turn a preparation benchmark into a deliberately empty population.
  for (const day of ['2026-09-12', '2026-09-13']) await chunks(users.map(user => ({ userId: user.id,
    periodStart: new Date(`${day}T12:00:00Z`), periodEnd: new Date(`${day}T12:05:00Z`), steps: 1000 })), data => prisma.stepSample.createMany({ data }));
  const nextWindows = [], oldRaceIds = [];
  for (const kind of ['DAILY_10K', 'WEEKLY_50K']) {
    const seed = await prisma.raceSeed.findUniqueOrThrow({ where: { kind } });
    const current = windowFor(seed, new Date()), next = windowFor(seed, current.windowEnd);
    nextWindows.push({ seed, ...next });
    await prisma.seededRaceWindowModeRecord.createMany({ data: [current, next].map(window => ({ seedId: seed.id, ...window, mode: 'BUCKET' })) });
    const maximum = kind === 'DAILY_10K' ? 35 : 100, target = kind === 'DAILY_10K' ? 30 : 75;
    const count = Math.ceil(usersCount / target), races = [], buckets = [], participants = [], assignments = [], ledger = [];
    for (let index = 0; index < count; index++) {
      const id = randomUUID(), bucketId = randomUUID();
      races.push({ id, seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps, maxParticipants: maximum,
        status: 'ACTIVE', isPublic: false, startedAt: current.windowStart, scheduledStartAt: current.windowStart,
        endsAt: current.windowEnd, timeBased: true, timezone: 'America/New_York', powerupsEnabled: true,
        powerupStepInterval: 5000, maxDurationDays: seed.cadence === 'WEEKLY' ? 7 : 1,
        fundedPrize: true, prizeCalculationVersion: 2, prizeCoinUnit: 10, prizePoolMaxCoins: 8000, payoutPreset: 'TOP_HALF' });
      buckets.push({ id: bucketId, raceId: id, seedId: seed.id, ...current, status: 'ACTIVE' }); oldRaceIds.push(id);
    }
    await chunks(races, data => prisma.race.createMany({ data }));
    await chunks(buckets, data => prisma.seededRaceBucket.createMany({ data }));
    await prisma.$executeRawUnsafe('UPDATE races r SET seeded_bucket_id=b.id FROM seeded_race_buckets b WHERE b.race_id=r.id');
    users.forEach((user, index) => {
      const race = races[index % count], bucket = buckets[index % count], participantId = randomUUID();
      participants.push({ id: participantId, raceId: race.id, userId: user.id, status: 'ACCEPTED', joinedAt: current.windowStart, nextBoxAtSteps: 5000 });
      assignments.push({ bucketId: bucket.id, userId: user.id, seedId: seed.id, windowStart: current.windowStart, raceParticipantId: participantId, matchSteps: 1000, state: 'FINAL' });
      ledger.push({ seedId: seed.id, windowStart: current.windowStart, userId: user.id, stream: 'BUCKET', raceId: race.id, createdAt: current.windowStart });
      ledger.push({ seedId: seed.id, windowStart: next.windowStart, userId: user.id, stream: 'BUCKET', createdAt: new Date() });
    });
    await chunks(participants, data => prisma.raceParticipant.createMany({ data }));
    await chunks(assignments, data => prisma.seededRaceBucketAssignment.createMany({ data }));
    await chunks(ledger, data => prisma.seededRaceWindowMembership.createMany({ data }));
  }
  const workerErrors = [], failures = [], latency = [];
  const logger = { log() {}, warn() {}, error(...values) { workerErrors.push(String(values[0]).slice(0, 8000)); } };
  const worker = buildRaceResolutionWorkerV2({ logger, processRole: 'all' });
  const post = buildRaceResolutionPostTaskRunner({ logger });
  const placements = buildRacePlacementTransitionWorker({ logger });
  const expiry = requireTarget('./src/modules/races/jobs/raceExpiry').buildRaceExpiryRunner({ logger });
  let coordinator;
  const renew = mode === 'candidate'
    ? (coordinator = requireTarget('./src/modules/races/jobs/seededChallengePreparation').scheduleSeededChallengePreparation({
        prisma, logger, processRole: 'cron', instance: '0', setInterval: () => ({ unref() {} }), clearInterval() {}, startImmediately: false,
      })).runNow
    : requireTarget('./src/modules/races/jobs/seededRaceRenewal').buildRenewSeededRaces({ prisma, logger,
        enqueueRaceResolution: requireTarget('./src/modules/races/services/enqueueRaceResolution').enqueueRaceResolution });
  const drainTick = async () => { await worker.tick(); await post.tick(); await placements.tick(); };
  const earlyDb = await databaseSnapshot(monitor);
  const earlyStart = performance.now();
  measured = true;
  if (mode === 'candidate' && args.cold !== 'true') {
    for (const [kind, at] of [['WEEKLY_50K', '2026-09-14T03:15:00Z'], ['DAILY_10K', '2026-09-14T03:30:00Z']]) {
      advance(at);
      await renew();
      const seedId = nextWindows.find(window => window.seed.kind === kind).seed.id;
      const deadline = performance.now() + 120000;
      // One scheduled coordinator tick publishes the plan. Drain background
      // work independently; repeatedly calling cron here would invent dozens
      // of population/maintenance scans per second and distort total work.
      while (await prisma.seededRaceWindowMembership.count({ where: { seedId, windowStart: new Date('2026-09-14T04:00:00Z'), stream: 'BUCKET', raceId: null } })) {
        assert.ok(performance.now() < deadline, 'Early preparation did not drain');
        await drainTick(); await delay(25);
      }
    }
  }
  const early = { durationMs: performance.now() - earlyStart, sql: JSON.parse(JSON.stringify(sql)), transactionLatency: stats(transactionDurations), database: databaseDelta(earlyDb, await databaseSnapshot(monitor)) };
  transactionDurations.length = 0;
  for (const key of Object.keys(sql)) sql[key] = ['verbs', 'errorCodes'].includes(key) ? {} : 0;
  const server = await startServer();
  const tokens = users.map(user => signSessionToken({ userId: user.id, appleId: user.appleId }));
  let running = true;
  const drain = (async () => { while (running) { await drainTick(); await delay(10); } })();
  const midnightDb = await databaseSnapshot(monitor);
  const observations = [];
  const observe = (async () => { while (running) { observations.push({ atMs: performance.now(), ...await queueSample(monitor) }); await delay(250); } })();
  const start = performance.now(), cpu = process.cpuUsage();
  advance('2026-09-14T03:55:00Z');
  async function syncAll(day) {
    let cursor = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < users.length) {
        const index = cursor++, at = new Date(), started = performance.now();
        const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', { token: tokens[index], headers: { ...features, 'Idempotency-Key': randomUUID() },
          body: { date: day, steps: 100, samples: [{ periodStart: new Date(at.getTime() - 300000).toISOString(), periodEnd: at.toISOString(), steps: 100 }] } });
        latency.push(performance.now() - started);
        if (response.status !== 202) failures.push({ status: response.status, body: (await response.text()).slice(0, 200) });
      }
    }));
  }
  await Promise.all([syncAll('2026-09-13'), args.cold === 'true' ? Promise.resolve() : renew()]);
  // Never jump the clock underneath an in-flight lease: that would benchmark
  // an artificial multi-minute clock discontinuity. Drain the pre-boundary
  // phase, position just before midnight, then cross it in real elapsed time.
  const beforeBoundaryDeadline = performance.now() + 120000;
  for (;;) {
    const active = Number((await monitor.query("/*seeded_load_monitor*/ SELECT ((SELECT count(*) FROM race_resolution_jobs_v2 WHERE state IN ('queued','running'))+(SELECT count(*) FROM race_resolution_post_tasks WHERE state IN ('queued','running','retry'))+(SELECT count(*) FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry')))::int n")).rows[0].n);
    if (!active) break;
    assert.ok(performance.now() < beforeBoundaryDeadline, 'Pre-boundary work did not drain');
    await delay(100);
  }
  advance('2026-09-14T03:59:59Z');
  await delay(2100);
  await Promise.all([syncAll('2026-09-14'), renew(), expiry()]);
  const foregroundMs = performance.now() - start;
  const deadline = performance.now() + 180000;
  let remaining = 0;
  do {
    remaining = Number((await monitor.query("/*seeded_load_monitor*/ SELECT ((SELECT count(*) FROM race_resolution_jobs_v2 WHERE state IN ('queued','running','failed'))+(SELECT count(*) FROM race_resolution_post_tasks WHERE state IN ('queued','running','retry'))+(SELECT count(*) FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry')))::int n")).rows[0].n);
    if (!remaining) break;
    await delay(100);
  } while (performance.now() < deadline);
  running = false; await Promise.all([drain, observe]);
  const measurement = { durationMs: performance.now() - start, foregroundMs, sql, transactionLatency: stats(transactionDurations), database: databaseDelta(midnightDb, await databaseSnapshot(monitor)), maxLockWaiters: Math.max(0,...observations.map(row => row.lock_waiters)), maxQueueAgeSeconds: Math.max(0,...observations.map(row => row.oldest_queue_seconds)), processCpu: process.cpuUsage(cpu), syncLatency: stats(latency), failures, workerErrors, remainingQueue: remaining };
  measured = false;
  const currentAccepted = await prisma.raceParticipant.count({ where: { status: 'ACCEPTED', race: { scheduledStartAt: new Date('2026-09-14T04:00:00Z'), seededBucketId: { not: null }, status: 'ACTIVE' } } });
  const unassigned = await prisma.seededRaceWindowMembership.count({ where: { windowStart: new Date('2026-09-14T04:00:00Z'), stream: 'BUCKET', raceId: null } });
  const overfull = (await monitor.query("/*seeded_load_monitor*/ SELECT r.id FROM races r JOIN race_participants p ON p.race_id=r.id AND p.status='accepted' WHERE r.seeded_bucket_id IS NOT NULL GROUP BY r.id HAVING count(*)>r.max_participants")).rows.length;
  const sourceAfter = sourceIdentity(root);
  const result = { sourceBefore, sourceAfter, sourceUnchanged: sourceBefore.sourceSha256 === sourceAfter.sourceSha256, schema: 'seeded-rollover-load-v1', mode, cold: args.cold === 'true', users: usersCount, compatibilityUsers: 1, early, midnight: measurement,
    currentAccepted, expectedAccepted: usersCount * 2, unassigned, overfull,
    topology: 'single HTTP process, two canonical scoring lanes, post-task and placement workers, shared 20-connection pool',
    limitations: ['Progressing virtual ET clock; PostgreSQL wall clock unchanged', 'Local synthetic process CPU, not managed database CPU', 'Join/capacity traffic measured separately by current-join workload'],
    passed: sourceBefore.sourceSha256 === sourceAfter.sourceSha256 && !failures.length && !workerErrors.length && !remaining && !unassigned && !overfull && currentAccepted === usersCount * 2 };
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  await coordinator?.stop(); await server.close(); await prisma.$disconnect(); await monitor.end();
  process.stdout.write(`${JSON.stringify({ output, passed: result.passed, users: usersCount, mode, remaining, currentAccepted })}\n`);
  process.exit(result.passed ? 0 : 1);
}
main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
