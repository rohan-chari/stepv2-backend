process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, beforeEach, after, it } = require('node:test');
for (const name of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[name]);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  if (name === 'DATABASE_URL') assert.match(url.pathname, /_test$/);
}
assert.equal(process.env.CACHE_ENV_PREFIX, 'historical-raw-test:');
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);
const { reads, setAfterRead } = require('./fixtures/observe-historical-raw.cjs');
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { coordinatedOptimizationMetrics: metrics } = require('../../src/shared/observability/coordinatedOptimizationMetrics');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
let baseUrl;
let queries = [];
prisma.$on("query", event => queries.push(event.query));
const DAY = 86400000;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(async () => { await cleanDatabase(); const cacheKeys = await redis.keys("historical-raw-test:*"); if (cacheKeys.length) await redis.del(...cacheKeys); reads.length = 0; });
after(async () => { await redis.quit(); });
async function fixture() {
  const account = await createTestUser({ timezone: 'UTC' });
  const now = Date.now();
  const start = new Date(Math.floor(now / DAY) * DAY - 6 * DAY);
  const race = await prisma.race.create({ data: { creatorId: account.user.id, name: 'Raw history',
    status: 'ACTIVE', targetSteps: 1000000, maxParticipants: 10, powerupsEnabled: true,
    timezone: 'UTC', startedAt: start, endsAt: new Date(now + DAY) } });
  const participant = await prisma.raceParticipant.create({ data: { raceId: race.id,
    userId: account.user.id, status: 'ACCEPTED', joinedAt: start } });
  const oldRows = Array.from({ length: 96 }, (_, i) => ({ userId: account.user.id,
    periodStart: new Date(+start + i * 3600000), periodEnd: new Date(+start + (i + 1) * 3600000), steps: 10 }));
  await prisma.stepSample.createMany({ data: oldRows });
  return { account, race, participant, now, start, oldRows };
}
async function upload(f, steps, samples = null) {
  const res = await request(baseUrl, 'POST', '/steps/sync-v2', { token: f.account.token,
    headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC', 'X-Client-Features': '' },
    body: { date: new Date(f.now).toISOString().slice(0, 10), steps,
      samples: samples || [{ periodStart: new Date(f.now - 3600000).toISOString(),
        periodEnd: new Date(f.now - 1800000).toISOString(), steps }] } });
  assert.equal(res.status, 202, JSON.stringify(await res.json()));
}
async function run(f, steps, samples = null, options = {}) {
  await upload(f, steps, samples); reads.length = 0; queries = []; metrics.reset();
  assert.equal(await buildRaceResolutionWorkerV2({ bootAt: 0, logger: { log() {}, warn() {}, error: console.error }, ...options }).tick(), 1);
  const captured = reads.slice(); const workerQueries = queries.slice(); const workerMetrics = metrics.snapshot();
  const persistedTotal = (await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.participant.id } })).totalSteps;
  const res = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.account.token,
    headers: { 'X-Timezone': 'UTC', 'X-Client-Features': '' } });
  assert.equal(res.status, 200);
  const total = (await res.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps;
  assert.equal(persistedTotal, total, 'worker itself commits the HTTP score before any display repair');
  return { total, metrics: workerMetrics, queries: workerQueries, rows: captured.reduce((n, r) => n + r.rows, 0), reads: captured };
}
const keys = () => redis.keys('historical-raw-test:historical-raw:v1:*');
it('recent generations reuse older raw rows with exact old-client HTTP scoring', async t => {
  const f = await fixture(); const cold = await run(f, 100); const warm = await run(f, 200);
  assert.equal(cold.total, 1060); assert.equal(warm.total, 1160);
  assert.ok((await keys()).length > 0, 'worker publishes separately verified raw history');
  assert.ok(warm.rows < cold.rows / 2, `warm ${warm.rows} rows must avoid cold ${cold.rows} history`);
  const cacheKeys = await keys();
  const bytes = (await Promise.all(cacheKeys.map(key => redis.strlen(key)))).reduce((a, b) => a + b, 0);
  t.diagnostic(JSON.stringify({ coldRows: cold.rows, warmRows: warm.rows,
    coldSampleSelects: cold.reads.length, warmSampleSelects: warm.reads.length,
    coldProofSelects: cold.queries.filter(q => q.includes('steps:historical-raw-proof')).length,
    warmProofSelects: warm.queries.filter(q => q.includes('steps:historical-raw-proof')).length, redisBytes: bytes }));
});
it('old corrections and old overlap replacement invalidate history', async () => {
  const f = await fixture(); await run(f, 100); const previous = await keys(); assert.ok(previous.length);
  const old = f.oldRows[0];
  const changed = await run(f, 100, [{ periodStart: old.periodStart.toISOString(), periodEnd: old.periodEnd.toISOString(), steps: 20 }]);
  assert.equal(changed.total, 1070); assert.ok(changed.rows >= 97);
  assert.equal((await run(f, 200)).total, 1170);
  const replacement = await run(f, 200, [{ periodStart: old.periodStart.toISOString(), periodEnd: new Date(+old.periodStart + 1800000).toISOString(), steps: 3 }, { periodStart: new Date(+old.periodStart + 1800000).toISOString(), periodEnd: old.periodEnd.toISOString(), steps: 4 }]);
  assert.equal(replacement.total, 1157);
});
it('legacy generation gaps remain invalid after the next classified recent writer', async () => {
  const f = await fixture(); await run(f, 100); assert.ok((await keys()).length);
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('UPDATE user_scoring_input_versions SET generation=generation+1 WHERE user_id=$1', f.account.user.id);
    await tx.stepSample.updateMany({ where: { userId: f.account.user.id, periodStart: f.oldRows[0].periodStart }, data: { steps: 70 } });
  });
  const changed = await run(f, 200); assert.equal(changed.total, 1220); assert.ok(changed.rows >= 97);
  const warm = await run(f, 300); assert.equal(warm.total, 1320); assert.ok(warm.rows < changed.rows);
});
for (const damage of ['malformed', 'oversized', 'expired', 'wrong-metadata']) {
  it(`Redis ${damage} entries fall back to complete PostgreSQL reads`, async () => {
    const f = await fixture(); await run(f, 100); const cached = await keys(); assert.ok(cached.length);
    for (const key of cached) {
      if (damage === 'expired') await redis.del(key);
      else if (damage === 'malformed') await redis.set(key, '{');
      else if (damage === 'oversized') await redis.set(key, 'x'.repeat(1024 * 1024 + 1));
      else { const value = JSON.parse(await redis.get(key)); value.revision = 'incorrect'; await redis.set(key, JSON.stringify(value)); }
    }
    const result = await run(f, 200); assert.equal(result.total, 1160); assert.ok(result.rows >= 97);
  });
}
it('final generation fence rejects a concurrent correction without poisoning the next reuse', async () => {
  const f = await fixture(); await run(f, 100); let once = false;
  const result = await run(f, 200, null, { beforeWriteTransaction: async () => {
    if (once) return; once = true;
    await upload(f, 200, [{ periodStart: f.oldRows[0].periodStart.toISOString(), periodEnd: f.oldRows[0].periodEnd.toISOString(), steps: 70 }]);
  } });
  assert.equal(result.total, 1220); assert.equal((await run(f, 300)).total, 1320);
  assert.ok((await keys()).length);
});

it('a source correction during a cold fill cannot publish mixed-generation history', async () => {
  const f = await fixture(); let corrected = false;
  setAfterRead(async () => { corrected = true; await upload(f, 100, [{
    periodStart: f.oldRows[0].periodStart.toISOString(), periodEnd: f.oldRows[0].periodEnd.toISOString(), steps: 70 }]); });
  const result = await run(f, 100); assert.ok(corrected); assert.equal(result.total, 1120);
  assert.equal((await run(f, 200)).total, 1220);
});
it('cutoff-straddling three-step sample stays whole and preserves canonical rounding', async () => {
  const f = await fixture(); const cutoff = Math.floor(f.now / DAY) * DAY - 2 * DAY;
  await prisma.stepSample.deleteMany({ where: { userId: f.account.user.id, periodStart: f.oldRows.at(-1).periodStart } });
  await prisma.stepSample.create({ data: { userId: f.account.user.id,
    periodStart: new Date(cutoff - 1800000), periodEnd: new Date(cutoff + 1800000), steps: 3 } });
  // Existing daily windows round each half to2, so canonical total is1054.
  assert.equal((await run(f, 100)).total, 1054);
  const warm = await run(f, 200); assert.equal(warm.total, 1154); assert.equal(warm.rows, 2);
  for (const key of await keys()) {
    const value = JSON.parse(await redis.get(key));
    assert.ok(value.rows.every(row => row[1] <= cutoff), 'straddler remains wholly in the recent database read');
  }
});
it('coverage expansion rebuilds the older prefix instead of treating absent history as zero', async () => {
  const f = await fixture(); const earlier = new Date(+f.start - DAY);
  await prisma.stepSample.create({ data: { userId: f.account.user.id, periodStart: earlier,
    periodEnd: new Date(+earlier + 3600000), steps: 50 } });
  assert.equal((await run(f, 100)).total, 1060);
  await prisma.race.update({ where: { id: f.race.id }, data: { startedAt: earlier } });
  await prisma.raceParticipant.update({ where: { id: f.participant.id }, data: { joinedAt: earlier } });
  const widened = await run(f, 200); assert.equal(widened.total, 1210); assert.equal(widened.rows, 98);
  assert.equal((await run(f, 300)).rows, 1);
});
it('ordinary no-op sync keeps the proof and version tuple without a new update', async () => {
  const f = await fixture(); await run(f, 100);
  const before = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  queries = []; await upload(f, 100);
  assert.equal(queries.filter(q => /UPDATE user_scoring_input_versions\s+SET generation/.test(q)).length, 0);
  const after = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  assert.deepEqual(after, before);
});
it('legacy gap then no-op upload rotates historical proof before restoring completeness', async () => {
  const f = await fixture(); await run(f, 100);
  const before = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  await prisma.$executeRawUnsafe('UPDATE user_scoring_input_versions SET generation=generation+1 WHERE user_id=$1', f.account.user.id);
  await upload(f, 100);
  const after = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  assert.notEqual(after.historicalRawRevision, before.historicalRawRevision);
  assert.equal(after.historicalRawCompleteGeneration, after.generation);
});
it('Redis command outage falls back to PostgreSQL with unchanged HTTP scores', async () => {
  const f = await fixture(); await run(f, 100);
  assert.equal(new URL(process.env.REDIS_URL).port, '16440', 'ACL failure test requires its dedicated temporary Redis');
  assert.deepEqual(await redis.config('GET', 'pidfile'), ['pidfile', '/tmp/bara-historical-raw-redis.pid']);
  await redis.acl('SETUSER', 'default', '-eval');
  try { const failedCache = await run(f, 200); assert.equal(failedCache.total, 1160); assert.ok(failedCache.rows >= 97); }
  finally { await redis.acl('SETUSER', 'default', '+eval'); }
  assert.equal((await run(f, 300)).total, 1260);
});
it('a mixed upload resending unchanged old rows only refreshes the changed recent tail', async () => {
  const f = await fixture(); await run(f, 100);
  const samples = f.oldRows.slice(0, 2).map(row => ({ periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(), steps: row.steps }));
  samples.push({ periodStart: new Date(f.now - 3600000).toISOString(), periodEnd: new Date(f.now - 1800000).toISOString(), steps: 200 });
  const mixed = await run(f, 200, samples); assert.equal(mixed.total, 1160); assert.equal(mixed.rows, 1);
});
it('actual retention deletion invalidates completeness before a recent writer can restore it', async () => {
  const f = await fixture();
  await prisma.stepSample.create({ data: { userId: f.account.user.id, periodStart: new Date(f.now - 61 * DAY), periodEnd: new Date(f.now - 60 * DAY), steps: 10 } });
  await run(f, 100);
  const before = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  const { buildCleanupStepSamples } = require('../../src/modules/steps/jobs/stepSampleRetention');
  await prisma.jobRun.deleteMany({ where: { jobName: "step_sample_retention" } });
  const result = await buildCleanupStepSamples({ disabled: false, now: () => new Date(Math.floor(f.now / DAY) * DAY + DAY + 12 * 3600000), logger: { log() {}, error: console.error } })();
  assert.equal(result.count, 1);
  const gap = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  assert.notEqual(gap.historicalRawCompleteGeneration, gap.generation);
  assert.equal((await run(f, 200)).total, 1160);
  const after = await prisma.userScoringInputVersion.findUniqueOrThrow({ where: { userId: f.account.user.id } });
  assert.notEqual(after.historicalRawRevision, before.historicalRawRevision);
});
it('expiry settles from PostgreSQL without consulting historical raw Redis entries', async () => {
  const f = await fixture(); await run(f, 100); assert.ok((await keys()).length);
  await prisma.race.update({ where: { id: f.race.id }, data: { endsAt: new Date(f.now - 60000) } });
  const { resolveExpiredRaces } = require('../../src/modules/races/jobs/raceExpiry');
  queries = [];
  const priorReads = reads.length;
  await resolveExpiredRaces();
  assert.equal(queries.filter(q => q.includes('steps:historical-raw-proof')).length, 0);
  const res = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.account.token, headers: { 'X-Client-Features': '', 'X-Timezone': 'UTC' } });
  assert.equal(res.status, 200); const progress = (await res.json()).progress;
  assert.equal(progress.status.toLowerCase(), 'completed');
  assert.equal(progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 1060);
  assert.ok(reads.length > priorReads, 'expiry loads canonical source samples');
});
it('a different worker process reuses Redis history after a recent sync', async () => {
  const f = await fixture(); await run(f, 100); await upload(f, 200);
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['test/integration/fixtures/historical-raw-worker.cjs'], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const result = await new Promise((resolve, reject) => {
    let message; child.on('message', value => { message = value; }); child.on('error', reject);
    child.on('exit', code => code === 0 && message ? resolve(message) : reject(new Error(logs)));
  });
  assert.equal(result.count, 1); assert.equal(result.reads.reduce((n, r) => n + r.rows, 0), 1);
  const persisted = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.participant.id } });
  assert.equal(persisted.totalSteps, 1160);
  const response = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.account.token, headers: { 'X-Client-Features': '', 'X-Timezone': 'UTC' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).progress.participants.find(p => p.userId === f.account.user.id).totalSteps, 1160);
});
it('six days of five-minute samples avoid old rows while keeping the full recent tail', async t => {
  const f = await fixture();
  await prisma.stepSample.deleteMany({ where: { userId: f.account.user.id } });
  const finish = Math.floor(f.now / 300000) * 300000;
  const count = Math.floor((finish - +f.start) / 300000);
  const rows = Array.from({ length: count }, (_, i) => ({ userId: f.account.user.id,
    periodStart: new Date(+f.start + i * 300000), periodEnd: new Date(+f.start + (i + 1) * 300000), steps: 10 }));
  await prisma.stepSample.createMany({ data: rows });
  const latest = rows.at(-1);
  const sample = steps => [{ periodStart: latest.periodStart.toISOString(), periodEnd: latest.periodEnd.toISOString(), steps }];
  const cold = await run(f, 20, sample(20)); const warm = await run(f, 30, sample(30));
  assert.equal(cold.total, count * 10 + 10); assert.equal(warm.total, count * 10 + 20);
  const cutoff = Math.floor(f.now / DAY) * DAY - 2 * DAY;
  assert.equal(cold.rows, count); assert.equal(warm.rows, rows.filter(row => +row.periodEnd > cutoff).length);
  assert.ok(warm.rows < cold.rows / 2);
  const bytes = (await Promise.all((await keys()).map(key => redis.strlen(key)))).reduce((a, b) => a + b, 0);
  t.diagnostic(JSON.stringify({ fiveMinuteFixture: true, coldRows: cold.rows, warmRows: warm.rows,
    coldSampleSelects: cold.reads.length, warmSampleSelects: warm.reads.length,
    coldProofSelects: cold.queries.filter(q => q.includes('steps:historical-raw-proof')).length,
    warmProofSelects: warm.queries.filter(q => q.includes('steps:historical-raw-proof')).length, redisBytes: bytes }));
});

it('cache stage accounting attributes cold, warm and malformed Redis loads without diagnostic SELECTs', async () => {
  const f = await fixture();
  const cold = await run(f, 100);
  const stage = (result, kind, reason) => result.metrics.counters[
    `race_scoring_cache_stage_total{kind=${kind},reason=${reason}}`] || 0;
  assert.equal(stage(cold, 'raw', 'absent_unknown'), 1);
  assert.equal(stage(cold, 'publication', 'success'), 1);
  assert.equal(stage(cold, 'process', 'absent'), 1);
  const warm = await run(f, 200);
  assert.equal(stage(warm, 'raw', 'accepted'), 1);
  assert.equal(stage(warm, 'process', 'generation_mismatch'), 1);
  for (const key of await keys()) await redis.set(key, '{');
  const malformed = await run(f, 300);
  assert.equal(stage(malformed, 'raw', 'malformed_payload'), 1);
  assert.equal(malformed.total, 1260);
  for (const result of [cold, warm, malformed]) {
    const counters = Object.entries(result.metrics.counters);
    assert.equal(counters.filter(([key]) => key.startsWith('race_scoring_cache_stage_total{kind=raw,')).reduce((sum, [, n]) => sum + n, 0), 1);
    assert.equal(counters.filter(([key]) => key.startsWith('race_scoring_cache_stage_total{kind=process,')).reduce((sum, [, n]) => sum + n, 0), 1);
    assert.ok(result.queries.every(query => !/pg_stat_|pg_statio_|pg_stat_activity/.test(query)));
    assert.doesNotMatch(JSON.stringify(result.metrics), new RegExp(f.account.user.id));
  }
});

it('same-attempt initial versions eliminate one proof SELECT on cold and warm worker source reads', async () => {
  const f = await fixture();
  for (const steps of [100, 200]) {
    const result = await run(f, steps);
    assert.equal(result.total, 960 + steps);
    assert.equal(result.queries.filter(query => query.includes('steps:historical-raw-proof')).length, 1,
      'existing initial version SELECT supplies proof; authoritative post-source SELECT remains');
  }
});
