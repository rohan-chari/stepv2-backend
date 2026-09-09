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
  const monitor = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'seeded_load_monitor' });
  await monitor.connect();
  const identity = (await monitor.query('/*seeded_load_monitor*/ SELECT current_database() db, inet_server_addr() host, inet_server_port() port, version() version')).rows[0];
  assert.match(identity.db, /_load_test$/);
  assert.match(identity.version, /PostgreSQL 18\./);
  assert.equal(await prisma.user.count(), 0, 'Fresh load database only; do not overwrite a prior run');
  await cleanDatabase();
  const now = new Date();
  const existingCount = Math.floor(usersCount * 0.9);
  const users = Array.from({ length: usersCount }, (_, i) => ({
    id: randomUUID(), appleId: `seeded-load-${randomUUID()}`, displayName: `load_${i}`,
    timezone: 'America/New_York', globalEventTimezone: 'America/New_York',
    autoJoinFeaturedRaces: false, clientFeatures: ['seeded_race_buckets', 'api_payload_compact_v1'],
    lastAppVersion: '2.3.13', createdAt: new Date(+now - 45 * 86400000),
  }));
  await chunks(users, (data) => prisma.user.createMany({ data }));
  await chunks(users.map(user => ({ userId: user.id, generation: 1n })), data => prisma.userScoringInputVersion.createMany({ data }));
  const historyStart = new Date(+now - 30 * 86400000);
  await chunks(users.map((user, i) => ({ userId: user.id, periodStart: historyStart, periodEnd: new Date(+historyStart + 300000), steps: 100 + i % 100 })), (data) => prisma.stepSample.createMany({ data }));
  const seeded = [];
  for (const kind of ['DAILY_10K', 'WEEKLY_50K']) {
    const seed = await prisma.raceSeed.findUniqueOrThrow({ where: { kind } });
    const { windowStart, windowEnd } = windowFor(seed, now);
    await prisma.seededRaceWindowModeRecord.create({ data: { seedId: seed.id, windowStart, windowEnd, mode: 'BUCKET' } });
    const cap = kind === 'DAILY_10K' ? 35 : 100;
    const groups = Math.max(1, Math.ceil(existingCount / cap));
    const races = Array.from({ length: groups }, () => ({
      id: randomUUID(), seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps,
      status: 'ACTIVE', isPublic: false, maxParticipants: cap, timeBased: true,
      timezone: 'America/New_York', startedAt: windowStart, scheduledStartAt: windowStart,
      endsAt: windowEnd, maxDurationDays: kind === 'DAILY_10K' ? 1 : 7,
      powerupsEnabled: true, powerupStepInterval: seed.powerupStepInterval || 1000,
      fundedPrize: true, prizeCalculationVersion: 2, prizeCoinUnit: 10,
      prizePoolMaxCoins: 8000, payoutPreset: 'TOP_HALF',
    }));
    const buckets = races.map((race) => ({ id: randomUUID(), raceId: race.id, seedId: seed.id, windowStart, windowEnd, status: 'ACTIVE' }));
    await chunks(races, (data) => prisma.race.createMany({ data }));
    await chunks(buckets, (data) => prisma.seededRaceBucket.createMany({ data }));
    await prisma.$executeRawUnsafe(`UPDATE races r SET seeded_bucket_id = b.id FROM seeded_race_buckets b WHERE b.race_id = r.id AND b.seed_id = $1`, seed.id);
    const participants = users.slice(0, existingCount).map((user, i) => ({ id: randomUUID(), userId: user.id, raceId: races[i % groups].id, status: 'ACCEPTED', joinedAt: windowStart, nextBoxAtSteps: 1000 }));
    await chunks(participants, (data) => prisma.raceParticipant.createMany({ data }));
    await chunks(participants.map((p, i) => ({ bucketId: buckets[i % groups].id, userId: p.userId, seedId: seed.id, windowStart, raceParticipantId: p.id, matchSteps: 100 + i % 100, state: 'FINAL' })), (data) => prisma.seededRaceBucketAssignment.createMany({ data }));
    await chunks(participants.map((p) => ({ userId: p.userId, seedId: seed.id, windowStart, raceId: p.raceId, stream: 'BUCKET' })), (data) => prisma.seededRaceWindowMembership.createMany({ data }));
    seeded.push({ kind, seedId: seed.id, windowStart, windowEnd, cap, initialGroups: groups });
  }
  const tokens = users.map((user) => signSessionToken({ userId: user.id, appleId: user.appleId }));
  const server = await startServer({ feedbackTransport: { async send() { return { accepted: [], rejected: [] }; } } });
  const workerErrors = [];
  const worker = buildRaceResolutionWorkerV2({ logger: { log() {}, error(...values) { workerErrors.push(String(values[0]).slice(0, 8000)); } } });
  const downstreamLogger = { log() {}, warn() {}, error(...values) { workerErrors.push(String(values[0]).slice(0,8000)); } };
  const postTasks = buildRaceResolutionPostTaskRunner({ logger: downstreamLogger });
  const placements = buildRacePlacementTransitionWorker({ logger: downstreamLogger });
  const counters = {}, latency = {}, failures = [], samples = [];
  const call = async (type, method, endpoint, userIndex, body, headers = {}) => {
    const start = performance.now();
    try {
      const response = await request(server.baseUrl, method, endpoint, { token: tokens[userIndex], headers: { ...features, ...headers }, body });
      const json = await response.json();
      counters[`${type}:${response.status}`] = (counters[`${type}:${response.status}`] || 0) + 1;
      (latency[type] ||= []).push(performance.now() - start);
      if (response.status >= 400) failures.push({ type, status: response.status, code: json.code || null });
      return { status: response.status, json };
    } catch (error) { failures.push({ type, networkError: error.message }); return { status: 0 }; }
  };
  let running = true;
  const drain = async () => { while (running) { await worker.tick(); await postTasks.tick(); await placements.tick(); await delay(25); } };
  const sample = async () => {
    while (running) {
      const row = (await monitor.query(`/*seeded_load_monitor*/ SELECT
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name <> 'seeded_load_monitor' AND wait_event_type='Lock') lock_waiters,
        (SELECT count(*)::int FROM race_resolution_jobs_v2 WHERE state IN ('queued','running')) queued,
        (SELECT COALESCE(max(EXTRACT(EPOCH FROM (clock_timestamp()-requested_at))),0)::float FROM race_resolution_jobs_v2 WHERE state IN ('queued')) oldest_queue_seconds`)).rows[0];
      samples.push({ elapsedMs: performance.now(), ...row });
      await delay(250);
    }
  };
  await monitor.query('/*seeded_load_monitor*/ ANALYZE');
  const before = (await monitor.query('/*seeded_load_monitor*/ SELECT xact_commit,xact_rollback,tup_inserted,tup_updated,tup_deleted,deadlocks FROM pg_stat_database WHERE datname=current_database()')).rows[0];
  const dbBefore = await databaseSnapshot(monitor);
  const started = performance.now();
  const appCpu = process.cpuUsage();
  measured = true;
  const drains = [drain(), sample()];
  let next = 0;
  const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < users.length) {
      const i = next++;
      if (i >= existingCount) {
        for (const kind of ['DAILY_10K', 'WEEKLY_50K']) {
          const requestId = randomUUID();
          const joined = await call('join', 'POST', `/races/seeded/${kind}/join-current`, i, { requestId });
          if (joined.status === 200) {
            assert.equal(typeof joined.json.raceId, 'string');
            if ((i - existingCount) % 10 === 0) {
              const replay = await call('replay', 'POST', `/races/seeded/${kind}/join-current`, i, { requestId });
              assert.equal(replay.json?.raceId, joined.json.raceId);
            }
          }
        }
      }
      const at = new Date();
      await call('sync', 'POST', '/steps/sync-v2', i, {
        date: dayKey, steps: 100,
        samples: [{ periodStart: new Date(+at - 300000).toISOString(), periodEnd: at.toISOString(), steps: 100 }],
      }, { 'Idempotency-Key': randomUUID() });
    }
  }));
  const foregroundMs = performance.now() - started;
  const drainDeadline = performance.now() + 120000;
  let remaining;
  do {
    remaining = Number((await monitor.query("/*seeded_load_monitor*/ SELECT ((SELECT count(*) FROM race_resolution_jobs_v2 WHERE state IN ('queued','running','failed')) + (SELECT count(*) FROM race_resolution_post_tasks WHERE state IN ('queued','running','retry')) + (SELECT count(*) FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry')))::int n")).rows[0].n);
    if (!remaining) break;
    await delay(250);
  } while (performance.now() < drainDeadline);
  running = false;
  await Promise.all(drains);
  measured = false;
  const workloadCpu = process.cpuUsage(appCpu);
  const workloadMs = performance.now() - started;
  const dbAfter = await databaseSnapshot(monitor);
  const after = (await monitor.query('/*seeded_load_monitor*/ SELECT xact_commit,xact_rollback,tup_inserted,tup_updated,tup_deleted,deadlocks FROM pg_stat_database WHERE datname=current_database()')).rows[0];
  const accepted = await prisma.raceParticipant.count({ where: { status: 'ACCEPTED', race: { seedId: { in: seeded.map((s) => s.seedId) } } } });
  const overfull = (await monitor.query(`/*seeded_load_monitor*/ SELECT r.id FROM races r JOIN race_participants p ON p.race_id=r.id AND p.status='accepted' WHERE r.seeded_bucket_id IS NOT NULL GROUP BY r.id HAVING count(*)>r.max_participants`)).rows;
  const overflowGroups = {};
  for (const window of seeded) {
    overflowGroups[window.kind] = await prisma.seededRaceBucket.count({ where: { seedId: window.seedId, windowStart: window.windowStart } }) - window.initialGroups;
    assert.ok(overflowGroups[window.kind] > 0, `${window.kind} must exercise full-group overflow`);
  }
  const candidatePlans = {};
  const admission = requireTarget('./src/modules/races/services/seededChallengeAdmission').buildSeededChallengeAdmission({ prisma });
  const explainClient = { $queryRaw(parts, ...values) {
    const statement = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, ...values);
  } };
  for (const window of seeded) {
    const seed = await prisma.raceSeed.findUnique({ where: { id: window.seedId } });
    candidatePlans[window.kind] = await admission.candidates(explainClient, seed, window, 0);
  }
  const sourceAfter = sourceIdentity(root);
  const artifact = {
    sourceBefore, sourceAfter, sourceUnchanged: sourceBefore.sourceSha256 === sourceAfter.sourceSha256,
    schema: 'seeded-current-join-load-v1', scenario: 'current-join-with-step-sync',
    sourceRootName: path.basename(root), users: usersCount, existingUsers: existingCount,
    concurrency, topology: 'single HTTP process plus real V2, post-task, and placement workers; 20-connection shared pool',
    limits: ['Synthetic local workload, not a production CPU or topology claim', 'No retries hide HTTP errors', 'Database cumulative stats can lag; SQL instrumentation includes every pg query in this process'],
    foregroundMs, totalMs: workloadMs, cpu: workloadCpu,
    sql, transactionLatency: stats(transactionDurations), database: databaseDelta(dbBefore, dbAfter), latency: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, stats(v)])),
    counters, failures: failures.slice(0, 100), failureCount: failures.length,
    workerErrors: workerErrors.slice(0, 100), accepted, expectedAccepted: usersCount * 2,
    overfull: overfull.length, remainingQueue: remaining, overflowGroups, candidatePlans,
    dbDelta: Object.fromEntries(Object.keys(before).map((key) => [key, Number(after[key]) - Number(before[key])])),
    maxLockWaiters: Math.max(0, ...samples.map((s) => s.lock_waiters)),
    maxQueueAgeSeconds: Math.max(0, ...samples.map((s) => s.oldest_queue_seconds)),
    samples: samples.map((s) => ({ ...s, elapsedMs: s.elapsedMs - started })),
    passed: sourceBefore.sourceSha256 === sourceAfter.sourceSha256 && failures.length === 0 && workerErrors.length === 0 && accepted === usersCount * 2 && overfull.length === 0 && remaining === 0,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  await server.close();
  await prisma.$disconnect();
  await monitor.end();
  process.stdout.write(`${JSON.stringify({ output, passed: artifact.passed, users: usersCount, foregroundMs, accepted, failures: failures.length })}\n`);
  process.exit(artifact.passed ? 0 : 1);
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
