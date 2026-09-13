// Real HTTP ingestion -> separate real worker -> persisted and HTTP score.
// Baseline and candidate execute identical fixtures against one isolated DB.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
assert.equal(process.env.NODE_ENV, 'test');
const database = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(database.hostname)); assert.match(database.pathname, /_test$/);
const redisURL = new URL(process.env.REDIS_URL); assert.ok(['localhost','127.0.0.1'].includes(redisURL.hostname));
assert.equal(redisURL.pathname, '/15');
assert.equal(process.env.CACHE_ENV_PREFIX, 'historical-raw-test:');
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const baseline = path.resolve(process.env.BENCHMARK_BASELINE_DIR);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(), '6c5fd10cc2bd27d109a2b2a5bc67cae36032553f');
// Passive worker observer copied only into the disposable baseline worktree.
for (const file of ['historical-raw-worker.cjs', 'observe-historical-raw.cjs']) {
  writeFileSync(path.join(baseline, 'test/integration/fixtures', file), readFileSync(path.join(__dirname, '../../test/integration/fixtures', file)));
}
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('../../test/integration/setup');
function percentile(values, q) { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.ceil(sorted.length*q)-1]; }
async function worker(cwd) {
  const child = spawn(process.execPath, ['test/integration/fixtures/historical-raw-worker.cjs'], {
    cwd, env: { ...process.env, RACE_QUEUE_V2_QUIET_PERIOD_MS: '0', RACE_RESOLVE_DEBOUNCE_MS: '0' }, stdio: ['ignore','pipe','pipe','ipc'] });
  let logs = '', message;
  child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
  return new Promise((resolve,reject) => { child.on('message', value => { message=value; }); child.on('error',reject);
    child.on('exit', code => code === 0 && message ? resolve(message) : reject(new Error(logs))); });
}
(async () => {
  await cleanDatabase(); const { baseUrl } = await getSharedServer();
  const account = await createTestUser({ timezone: 'UTC' });
  const now = Date.now(), day = 86400000, start = new Date(Math.floor(now/day)*day-6*day);
  const race = await prisma.race.create({ data: { creatorId: account.user.id, name: 'proof benchmark', status: 'ACTIVE',
    targetSteps: 1000000, timezone: 'UTC', startedAt: start, endsAt: new Date(now+day) } });
  const participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id, status: 'ACCEPTED', joinedAt: start } });
  await prisma.stepSample.createMany({ data: Array.from({ length: 96 }, (_, i) => ({ userId: account.user.id,
    periodStart: new Date(+start+i*3600000), periodEnd: new Date(+start+(i+1)*3600000), steps: 10 })) });
  let steps = 100;
  async function run(kind) {
    steps += 10;
    const upload = await request(baseUrl, 'POST', '/steps/sync-v2', { token: account.token,
      headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC', 'X-Client-Features': '' },
      body: { date: new Date(now).toISOString().slice(0,10), steps,
        samples: [{ periodStart: new Date(now-3600000).toISOString(), periodEnd: new Date(now-1800000).toISOString(), steps }] } });
    assert.equal(upload.status,202);
    // Intake permanently coalesces STEP_INPUT_CHANGED for five seconds.
    // Observe and honor that durable readiness floor outside the timed tick.
    const queued = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: race.id } });
    const remainingMs = Math.max(0, +queued.notBeforeAt - Date.now()) + 5;
    await new Promise(resolve => setTimeout(resolve, remainingMs));
    const result = await worker(kind === 'baseline' ? baseline : path.resolve(__dirname,'../..'));
    assert.equal(result.count,1, JSON.stringify(result));
    const stored = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: participant.id } });
    assert.equal(stored.totalSteps,960+steps);
    const response = await request(baseUrl,'GET',`/races/${race.id}/progress`,{ token: account.token,
      headers: { 'X-Timezone':'UTC','X-Client-Features': kind === 'baseline' ? '' : 'tournaments' } });
    assert.equal(response.status,200);
    assert.equal((await response.json()).progress.participants.find(row => row.userId === account.user.id).totalSteps,960+steps);
    return { elapsedMs: result.elapsedMs, queryCount: result.queries.length,
      proofSelects: result.queries.filter(query => query.includes('steps:historical-raw-proof')).length,
      sampleSelects: result.reads.length, sourceRows: result.reads.reduce((n,row) => n+row.rows,0) };
  }
  const cold = await run('candidate'); const warmup = [await run('baseline'),await run('candidate')];
  const pairs = [];
  for(let i=0;i<30;i++) pairs.push(i%2 ? { candidate: await run('candidate'),baseline: await run('baseline') }
    : { baseline: await run('baseline'),candidate: await run('candidate') });
  const summary = Object.fromEntries(['baseline','candidate'].map(kind => [kind,{
    medianWorkerMs:percentile(pairs.map(pair=>pair[kind].elapsedMs),.5),p95WorkerMs:percentile(pairs.map(pair=>pair[kind].elapsedMs),.95),
    medianQueries:percentile(pairs.map(pair=>pair[kind].queryCount),.5),
  }]));
  const evidence = { sourceBaseline: '6c5fd10cc2bd27d109a2b2a5bc67cae36032553f', fixture: { users:1,races:1,historicalRows:96 },
    cold,warmup,pairs,summary, note:'30 alternating warm Redis pairs, independent fresh worker process per run; timer excludes process startup but includes entire worker tick. Public HTTP and persisted totals checked every run. No hostCPU attribution.' };
  writeFileSync('docs/evidence/db-work-reduction/historical-proof-worker.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(summary));
  assert.ok(pairs.every(pair=>pair.baseline.proofSelects===2 && pair.candidate.proofSelects===1));
  assert.ok(summary.candidate.p95WorkerMs<=summary.baseline.p95WorkerMs*1.05,'no repeatable five-percent worker p95 regression');
  await cleanDatabase(); await prisma.$disconnect(); process.exit(0);
})().catch(async error=>{console.error(error);await prisma.$disconnect();process.exit(1);});
