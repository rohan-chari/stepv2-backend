const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { prisma, cleanDatabase, createTestUser } = require('./setup');
const { signSessionToken } = require('../../src/modules/users/services/sessionToken');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname)); assert.match(target.pathname, /_test$/);
const usersCount = Number(process.env.CPU_ACCOUNTING_USERS || 12);
assert.ok(Number.isInteger(usersCount) && usersCount > 0 && usersCount <= 2000);
const root = process.cwd();
const children = [];
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'cpu-accounting-runtime-'));
const basePort = Number(process.env.CPU_ACCOUNTING_PORT || 16550);
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  await prisma.$disconnect(); fs.rmSync(runtime, { recursive: true, force: true });
});
function start(role, port, instance) {
  // Empty runtime cwd prevents loading developer .env/provider credentials.
  const child = spawn(process.execPath, ['--require', path.join(root, 'test/integration/fixtures/db-cpu/observe.cjs'), path.join(root, 'src/index.js')], {
    cwd: runtime,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: target.toString(),
      SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET,
      REDIS_URL: process.env.REDIS_URL || '', CACHE_ENV_PREFIX: process.env.CACHE_ENV_PREFIX || 'cpu-accounting:',
      REFERRAL_IP_HMAC_ACTIVE_VERSION: '1', REFERRAL_IP_HMAC_SECRET_V1: 'integration-test-only-referral-hmac-secret-material',
      STEPS_PROCESS_ROLE: role, NODE_APP_INSTANCE: String(instance), PORT: String(port), HOST: '127.0.0.1',
      CRON_START_DELAY_MS: '0', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0', ASYNC_RACE_RESOLUTION_CONCURRENCY: '2', DATABASE_POOL_MAX_HTTP: '10', DATABASE_POOL_MAX_RESOLUTION: '4' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.recent = ''; child.commits = 0; child.lines = '';
  child.stdout.on('data', buffer => {
    child.lines += buffer; const lines = child.lines.split('\n'); child.lines = lines.pop();
    for (const line of lines) {
      try { const row = JSON.parse(line); if (row.event === 'race_resolution_v2' && row.status === 'committed') child.commits++; } catch {}
    }
    child.recent = (child.recent + buffer).slice(-10000);
  });
  child.stderr.on('data', buffer => { child.recent = (child.recent + buffer).slice(-10000); });
  children.push(child); return child;
}
async function ready(child, port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, child.recent);
    try { const res = await fetch(`http://127.0.0.1:${port}/health`); if (res.ok) return; } catch {}
    await delay(100);
  }
  throw Error(`server startup timeout: ${child.recent}`);
}
async function snapshot(child) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('observer timeout')); }, 10000);
    function receive(row) { if (row.requestId === requestId) { clearTimeout(timer); child.off('message', receive); resolve(row); } }
    child.on('message', receive); child.send({ kind: 'cpu-accounting-snapshot', requestId });
  });
}
function delta(a, b) {
  const prior = new Map(a.shapes.map(s => [s.id, s]));
  return { admissionRejected: b.admission.rejected - a.admission.rejected, calls: b.calls - a.calls, elapsedMs: b.elapsedMs - a.elapsedMs,
    appCpuUserMs: (b.processCpu.user - a.processCpu.user) / 1000,
    appCpuSystemMs: (b.processCpu.system - a.processCpu.system) / 1000,
    sampleRangeReads: b.sampleRangeReads - a.sampleRangeReads,
    newUniqueSampleRanges: b.uniqueSampleRanges - a.uniqueSampleRanges,
    shapes: b.shapes.map(s => ({ ...s, calls: s.calls - (prior.get(s.id)?.calls || 0), elapsedMs: s.elapsedMs - (prior.get(s.id)?.elapsedMs || 0) })).filter(s => s.calls),
  };
}

test('two HTTP workers accept a synchronized cohort and the real resolution worker commits exact totals', { timeout: 600000 }, async () => {
  await cleanDatabase();
  const first = await createTestUser({ timezone: 'UTC', globalEventTimezone: 'UTC' });
  const users = [first.user, ...Array.from({ length: usersCount - 1 }, () => ({ id: randomUUID(), timezone: 'UTC', globalEventTimezone: 'UTC' }))];
  if (users.length > 1) await prisma.user.createMany({ data: users.slice(1) });
  const tokens = users.map(user => signSessionToken({ userId: user.id, appleId: user.appleId }));
  const now = new Date(); const startedAt = new Date(+now - 7200000);
  const races = Array.from({ length: Math.ceil(users.length / 20) }, () => ({
    id: randomUUID(), creatorId: first.user.id, name: 'CPU accounting cohort', status: 'ACTIVE',
    targetSteps: 1000000, maxParticipants: 20, powerupsEnabled: true, timezone: 'UTC',
    startedAt, endsAt: new Date(+now + 86400000),
  }));
  await prisma.race.createMany({ data: races });
  await prisma.raceParticipant.createMany({ data: users.map((user, i) => ({ raceId: races[Math.floor(i / 20)].id, userId: user.id, status: 'ACCEPTED', joinedAt: startedAt })) });
  const http0 = start('http', basePort, 0), http1 = start('http', basePort + 1, 1);
  await Promise.all([ready(http0, basePort), ready(http1, basePort + 1)]);
  const worker = start('resolution', basePort + 2, 0);
  await delay(1500); assert.equal(worker.exitCode, null, worker.recent);
  const before = await Promise.all(children.map(snapshot));
  const latencies = []; const acceptedLatencies = []; const uploadLatencies = []; const statuses = {}; let retries = 0;
  const started = Date.now();
  async function upload(user, i, duplicate = false) {
    const body = { date: now.toISOString().slice(0, 10), steps: 100, samples: [{ periodStart: new Date(+now - 3600000).toISOString(), periodEnd: new Date(+now - 1800000).toISOString(), steps: 100 }] };
    const key = randomUUID(); const uploadStarted = performance.now();
    for (let attempt = 0; attempt < 100; attempt++) {
      const at = performance.now();
      const response = await fetch(`http://127.0.0.1:${basePort + i % 2}/steps/sync-v2`, { method: 'POST', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${tokens[i]}`, 'Idempotency-Key': key, 'X-Timezone': 'UTC',
      }, body: JSON.stringify(body) });
      const result = await response.json(); latencies.push(performance.now() - at); statuses[response.status] = (statuses[response.status] || 0) + 1;
      if (response.status === 429 || response.status === 503 || response.status === 500) { retries++; await delay(Math.min(1000, 50 + attempt * 50)); continue; }
      assert.equal(response.status, 202, JSON.stringify(result) + '\n' + children[i % 2].recent);
      acceptedLatencies.push(performance.now() - at); uploadLatencies.push(performance.now() - uploadStarted); return;
    }
    throw Error('bounded admission retries exhausted');
  }
  await Promise.all(users.map(upload));
  const drainSql = `SELECT (
      (SELECT count(*) FROM race_participants WHERE total_steps<>100) +
      (SELECT count(*) FROM race_resolution_jobs_v2 WHERE state<>'succeeded' OR committed_generation<generation) +
      (SELECT count(*) FROM race_resolution_post_tasks WHERE state IN ('queued','running')) +
      (SELECT count(*) FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry'))
    )::int AS count`;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    assert.equal(worker.exitCode, null, worker.recent);
    const [row] = await prisma.$queryRawUnsafe(drainSql);
    if (!row.count) break;
    await delay(250);
  }
  const [remaining] = await prisma.$queryRawUnsafe(drainSql);
  assert.equal(remaining.count, 0, 'every scoring, generation, publication and placement obligation must drain before accounting: ' + worker.recent);
  const generationBefore = await prisma.raceResolutionJobV2.findMany({ select: { raceId: true, generation: true, committedGeneration: true }, orderBy: { raceId: 'asc' } });
  const settled = await Promise.all(children.map(snapshot));
  // Whole-upload duplicate delivery is distinct from HTTP idempotency-key reuse.
  await Promise.all(users.map((u, i) => upload(u, i, true)));
  const generationAfter = await prisma.raceResolutionJobV2.findMany({ select: { raceId: true, generation: true, committedGeneration: true }, orderBy: { raceId: 'asc' } });
  assert.deepEqual(generationAfter.map(x => [x.raceId, x.generation]), generationBefore.map(x => [x.raceId, x.generation]), 'identical source uploads must not create another generation');
  const final = await Promise.all(children.map(snapshot));
  assert.equal(statuses[500] || 0, final.slice(0, 2).reduce((sum, s, i) => sum + s.admission.rejected - before[i].admission.rejected, 0), 'every legacy overload 500 must be accounted for by bounded admission, not an application failure');
  const progress = await fetch(`http://127.0.0.1:${basePort}/races/${races[0].id}/progress`, { headers: { Authorization: `Bearer ${tokens[0]}`, 'X-Client-Features': '' } });
  assert.equal(progress.status, 200);
  const view = await progress.json();
  assert.equal(view.progress.participants.find(p => p.userId === users[0].id).totalSteps, 100);
  const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  const report = { schema: 'db-cpu-work-accounting-v1', users: users.length, races: races.length,
    httpWorkers: 2, resolutionConcurrency: 2, durationMs: Date.now() - started, statuses, admissionRetries: retries,
    httpAttemptP95Ms: p95(latencies), acceptedAttemptP95Ms: p95(acceptedLatencies), uploadIncludingRetriesP95Ms: p95(uploadLatencies),
    changed: before.map((s, i) => ({ role: i < 2 ? `http${i}` : 'resolution', ...delta(s, settled[i]) })),
    duplicate: settled.map((s, i) => ({ role: i < 2 ? `http${i}` : 'resolution', ...delta(s, final[i]) })),
    generations: generationAfter.map(x => ({ generation: x.generation, committed: x.committedGeneration })),
  };
  if (process.env.CPU_ACCOUNTING_OUTPUT) fs.writeFileSync(process.env.CPU_ACCOUNTING_OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, changed: report.changed.map(({ shapes, ...s }) => s), duplicate: report.duplicate.map(({ shapes, ...s }) => s), generations: report.generations.length }));
});
