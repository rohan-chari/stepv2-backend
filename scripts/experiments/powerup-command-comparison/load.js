// Real HTTP load -> real step intake, powerup commands, resolution and delivery.
// All arms use the same harness; no artificial participant lock is held here.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { randomUUID, createHash } = require('node:crypto');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const sourceRoot = path.resolve(option('source-root', path.join(__dirname, '../../..')));
const arm = option('arm', 'B');
const profile = option('profile', 'weekly');
const rate = Number(option('rate', '8'));
const syncRate = Number(option('sync-rate', '16'));
const seconds = Number(option('seconds', '30'));
const epoch = Number(option('epoch', String(Date.now())));
const output = path.resolve(option('output', path.join('artifacts/powerup-command-comparison', `${arm}-${profile}-${rate}-${Date.now()}`)));
const pgPid = Number(option('pg-pid', '0'));
const drainMs = Number(option('drain-ms', '90000'));
const db = new URL(process.env.DATABASE_URL);
const redis = new URL(process.env.REDIS_URL);
assert.ok(['localhost', '127.0.0.1'].includes(db.hostname) && db.port === '55445' && db.pathname.endsWith('_test'));
assert.ok(redis.hostname === '127.0.0.1' && redis.port === '16389');
assert.ok(!fs.existsSync(path.join(sourceRoot, '.env')), 'do not source an application environment');
assert.ok(['A', 'B', 'C', 'D'].includes(arm) && ['weekly', 'small'].includes(profile));
assert.ok(rate > 0 && rate <= 64 && syncRate >= 0 && syncRate <= 64 && seconds > 0 && seconds <= 60);
delete process.env.NODE_TEST_CONTEXT;
Object.assign(process.env, { NODE_ENV: 'test', SESSION_TOKEN_SECRET: 'isolated-powerup-command-comparison-secret',
  REFERRAL_IP_HMAC_ACTIVE_VERSION: '1', REFERRAL_IP_HMAC_SECRET_V1: 'isolated-comparison-referral-test-material',
  DATABASE_POOL_MAX_DEFAULT: '4', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0' });
const fromSource = (name) => require(path.join(sourceRoot, name));
const { prisma } = fromSource('src/db');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const results = [];
const samples = [];
const startedCommands = [];
async function measureProcesses() {
  return Promise.all(children.map((state) => new Promise((resolve, reject) => {
    const sampleId = randomUUID();
    const timer = setTimeout(() => reject(new Error('Metrics sample timed out')), 5000);
    const receive = (message) => {
      if (message.sampleId !== sampleId) return;
      clearTimeout(timer); state.child.off('message', receive);
      resolve({ role: state.role, index: state.index, ...message });
    };
    state.child.on('message', receive); state.child.send({ type: 'sample', sampleId });
  })));
}
function quantiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
  return { count: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) };
}
function guid(group, index) { return `00000000-0000-4000-8000-${String(group * 10000000 + index).padStart(12, '0')}`; }
function cpuSeconds(raw) {
  const parts = raw.split(':').map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}
const previousCpu = new Map();
let dbCpuSeconds = 0;
function sampleDbCpu() {
  if (!pgPid) return null;
  const rows = execFileSync('ps', ['-axo', 'pid,ppid,time'], { encoding: 'utf8' }).trim().split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/));
  const selected = rows.filter(([pid, ppid]) => Number(pid) === pgPid || Number(ppid) === pgPid);
  for (const [pid, , time] of selected) {
    const value = cpuSeconds(time);
    if (previousCpu.has(pid)) dbCpuSeconds += Math.max(0, value - previousCpu.get(pid));
    previousCpu.set(pid, value);
  }
  return { cpuSeconds: dbCpuSeconds, processes: selected.length };
}
async function snapshot() {
  const [row] = await prisma.$queryRawUnsafe(`SELECT
    (SELECT COUNT(*)::int FROM race_resolution_jobs_v2 WHERE state IN ('queued','running')) AS resolution_pending,
    (SELECT COUNT(*)::int FROM race_resolution_jobs_v2 WHERE state='failed') AS resolution_failed,
    (SELECT COUNT(*)::int FROM race_resolution_full_triggers) AS full_triggers,
    (SELECT COUNT(*)::int FROM race_resolution_post_tasks WHERE state IN ('queued','running')) AS post_pending,
    (SELECT COUNT(*)::int FROM race_resolution_post_tasks WHERE state NOT IN ('queued','running','succeeded','superseded')) AS post_failed,
    (SELECT COUNT(*)::int FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry')) AS placement_pending,
    (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS lock_waiters,
    (SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (NOW()-requested_at))),0)::float8 FROM race_resolution_jobs_v2 WHERE state IN ('queued','running')) AS oldest_resolution_seconds`);
  let commandPending = 0;
  if (arm === 'C' || arm === 'D') {
    const [queueRow] = await prisma.$queryRawUnsafe("SELECT COUNT(*)::int AS count FROM experiment_powerup_commands WHERE state IN ('pending','running') OR (status=200 AND NOT post_done)");
    commandPending = queueRow.count;
  }
  return { at: Date.now(), ...row, commandPending, dbCpu: sampleDbCpu() };
}
async function drain(deadlineMs = 90000) {
  const start = performance.now();
  let empty = 0; let last;
  while (performance.now() - start < deadlineMs) {
    last = await snapshot(); samples.push(last);
    if (last.resolution_pending + last.full_triggers + last.post_pending + last.placement_pending + last.commandPending === 0) empty += 1;
    else empty = 0;
    if (empty >= 2) return { drained: true, ms: performance.now() - start, last };
    await delay(500);
  }
  return { drained: false, ms: performance.now() - start, last };
}
async function boot(role, index) {
  const env = { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL,
    NODE_ENV: 'test', STEPS_PROCESS_ROLE: role === 'worker' ? 'resolution' : 'http', NODE_APP_INSTANCE: String(index),
    DATABASE_POOL_MAX_HTTP: '10', DATABASE_POOL_MAX_RESOLUTION: '8', DATABASE_POOL_MAX_DEFAULT: '4',
    ASYNC_RACE_RESOLUTION_CONCURRENCY: '3', RACE_QUEUE_V2_QUIET_PERIOD_MS: '0', PRISMA_QUERY_EVENTS_ENABLED: 'true',
    SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET, REFERRAL_IP_HMAC_ACTIVE_VERSION: '1',
    REFERRAL_IP_HMAC_SECRET_V1: process.env.REFERRAL_IP_HMAC_SECRET_V1, CACHE_ENV_PREFIX: 'powerup-comparison:' };
  const child = fork(path.join(__dirname, 'process.js'), [sourceRoot, role, arm], { env, cwd: sourceRoot, execArgv: [], silent: true });
  const stream = fs.createWriteStream(path.join(output, `${role}-${index}.log`));
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  const state = { child, role, index, metrics: [], exited: false };
  children.push(state);
  child.on('message', (message) => {
    if (message.type === 'metrics') state.metrics.push(message);
    if (message.type === 'commandStart') startedCommands.push(message);
  });
  child.on('exit', (code) => { state.exited = true; state.exitCode = code; stream.end(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} startup timed out`)), 30000);
    child.on('message', (message) => { if (message.type === 'ready') { clearTimeout(timer); state.baseUrl = message.baseUrl; resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${role} exited during startup: ${code}`)); });
  });
  return state;
}
async function stopChildren() {
  await Promise.all(children.map(async (state) => {
    if (state.exited) return;
    state.child.send({ type: 'stop' });
    const deadline = Date.now() + 35000;
    while (!state.exited && Date.now() < deadline) await delay(100);
    if (!state.exited) { state.forcedStop = true; state.child.kill('SIGKILL'); }
  }));
}
async function seed() {
  // Queue tables are experimental and are intentionally outside production's
  // fixture cleanup list. Clear them before their referenced fixture rows.
  const [{ exists }] = await prisma.$queryRawUnsafe("SELECT to_regclass('experiment_powerup_commands') IS NOT NULL AS exists");
  if (exists) {
    await prisma.$executeRawUnsafe('DELETE FROM experiment_powerup_commands');
    await prisma.$executeRawUnsafe('DELETE FROM experiment_powerup_inboxes');
    const [admissions] = await prisma.$queryRawUnsafe("SELECT to_regclass('experiment_powerup_admissions') IS NOT NULL AS exists");
    if (admissions.exists) await prisma.$executeRawUnsafe('DELETE FROM experiment_powerup_admissions');
  }
  await fromSource('test/integration/setup').cleanDatabase();
  const redisClient = new (require('ioredis'))(process.env.REDIS_URL);
  await redisClient.flushdb(); await redisClient.quit();
  const userCount = profile === 'weekly' ? 2000 : 1000;
  const sampleEnd = Math.floor((epoch - 60000) / 300000) * 300000;
  const sampleStart = sampleEnd - 24 * 300000;
  const users = Array.from({ length: userCount }, (_, i) => ({ id: guid(1, i), appleId: `queue-comparison-${i}`, displayName: `Compare${i}`, timezone: 'UTC' }));
  await prisma.user.createMany({ data: users });
  const races = []; const members = [];
  const raceCount = profile === 'weekly' ? 1 : 100;
  const size = profile === 'weekly' ? 2000 : 20;
  for (let r = 0; r < raceCount; r += 1) {
    const ids = Array.from({ length: size }, (_, p) => (r * size + p) % userCount);
    const race = { id: guid(2, r), creatorId: users[ids[0]].id, name: `Command comparison ${r}`,
      status: 'ACTIVE', timeBased: true, maxDurationDays: 7, maxParticipants: size,
      targetSteps: 100000000, powerupsEnabled: true, powerupStepInterval: 1000000,
      startedAt: new Date(sampleStart - 3600000), endsAt: new Date(epoch + 7 * 86400000), timezone: 'UTC' };
    races.push(race);
    for (const userIndex of ids) members.push({ id: guid(3, members.length), raceId: race.id, userId: users[userIndex].id,
      status: 'ACCEPTED', joinedAt: race.startedAt, rawSteps: 240, bonusSteps: 10000, totalSteps: 10240, nextBoxAtSteps: 1000000 });
  }
  await prisma.race.createMany({ data: races });
  await prisma.raceParticipant.createMany({ data: members });
  const stepSamples = users.flatMap((u) => Array.from({ length: 24 }, (_, i) => ({ userId: u.id,
    periodStart: new Date(sampleStart + i * 300000), periodEnd: new Date(sampleStart + (i + 1) * 300000), steps: 10 })));
  for (let i = 0; i < stepSamples.length; i += 2000) await prisma.stepSample.createMany({ data: stepSamples.slice(i, i + 2000) });
  await prisma.userScoringInputVersion.createMany({ data: users.map((u) => ({ userId: u.id, generation: 1n })) });
  const types = ['PROTEIN_SHAKE', 'TRAIL_MIX', 'RUNNERS_HIGH', 'COMPRESSION_SOCKS', 'SHORTCUT', 'MIRROR', 'UMBRELLA', 'DECOY', 'STEALTH_MODE', 'DETOUR_SIGN', 'SIGNAL_JAMMER', 'CLEANSE'];
  const powers = []; const defenses = [];
  for (let i = 0; i < members.length; i += 1) {
    if (i % 5 > 1) continue;
    const p = members[i]; const type = ['COMPRESSION_SOCKS', 'MIRROR', 'DECOY', 'UMBRELLA'][Math.floor(i / 5) % 4];
    const item = { id: guid(4, i), raceId: p.raceId, participantId: p.id, userId: p.userId,
      type, rarity: 'RARE', status: 'USED', earnedAtSteps: 100 };
    powers.push(item); defenses.push({ raceId: p.raceId, targetParticipantId: p.id, targetUserId: p.userId, sourceUserId: p.userId,
      powerupId: item.id, type, status: 'ACTIVE', startsAt: new Date(epoch - 1000), expiresAt: new Date(epoch + 86400000) });
  }
  const commands = Array.from({ length: Math.round(rate * seconds) }, (_, i) => {
    const p = members[(i * 37) % members.length];
    const raceMembers = members.filter((m) => m.raceId === p.raceId);
    const target = raceMembers[(raceMembers.findIndex((m) => m.id === p.id) + 1) % raceMembers.length];
    const type = types[i % types.length];
    const item = { id: guid(5, i), raceId: p.raceId, participantId: p.id, userId: p.userId, type, rarity: 'RARE', status: 'HELD', earnedAtSteps: 900000 + i };
    powers.push(item);
    return { item, body: ['SHORTCUT', 'DETOUR_SIGN', 'SIGNAL_JAMMER'].includes(type) ? { targetUserId: target.userId } : {} };
  });
  // Rare fanout is a separate, labelled end-of-load probe, so one early Outage
  // cannot make an arm appear efficient merely by jamming most later uses.
  const p = members[0];
  const outage = { item: { id: guid(6, 0), raceId: p.raceId, participantId: p.id, userId: p.userId, type: 'POWER_OUTAGE', rarity: 'RARE', status: 'HELD', earnedAtSteps: 9999999 }, body: {} };
  powers.push(outage.item);
  await prisma.racePowerup.createMany({ data: powers });
  await prisma.raceActiveEffect.createMany({ data: defenses });
  const { signSessionToken } = fromSource('src/modules/users/services/sessionToken');
  return { users, races, members, sampleStart, sampleEnd, commands, outage,
    tokens: new Map(users.map((u) => [u.id, signSessionToken({ userId: u.id, appleId: u.appleId })])),
    expectedRaw: new Map(users.map((u) => [u.id, 240])), versions: new Map() };
}
async function call(api, kind, userId, endpoint, body, fixture, extra = {}) {
  const start = performance.now(); const sentAt = Date.now();
  let record;
  try {
    const response = await fetch(`${api.baseUrl}${endpoint}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fixture.tokens.get(userId)}`,
        'X-Timezone': 'UTC', 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-App-Version': '2.0.0',
        ...(kind === 'sync' ? { 'Idempotency-Key': randomUUID() } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
    const data = await response.json();
    record = { kind, userId, sentAt, completedAt: Date.now(), ms: performance.now() - start, status: response.status, body: data, ...extra };
    if (kind === 'sync' && response.status === 202) fixture.expectedRaw.set(userId, Math.max(fixture.expectedRaw.get(userId), body.steps));
  } catch (error) { record = { kind, userId, sentAt, completedAt: Date.now(), ms: performance.now() - start, status: 0, error: error.message, ...extra }; }
  results.push(record);
  return record;
}
async function workload(fixture, apis) {
  const pending = new Set();
  const start = performance.now();
  let maxInflight = 0; let maxScheduleLagMs = 0;
  const events = [
    ...fixture.commands.map((command, i) => ({ kind: 'powerup', at: i * 1000 / rate, command, index: i })),
    ...Array.from({ length: Math.round(syncRate * seconds) }, (_, i) => ({ kind: 'sync', at: i * 1000 / syncRate, index: i })),
  ].sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));
  for (const event of events) {
    const remaining = start + event.at - performance.now();
    if (remaining > 0) await delay(remaining);
    maxScheduleLagMs = Math.max(maxScheduleLagMs, performance.now() - start - event.at);
    if (pending.size >= 256) { results.push({ kind: event.kind, status: -1, error: 'generator in-flight cap', powerupId: event.command?.item.id }); continue; }
    const api = apis[event.index % apis.length];
    let promise;
    if (event.kind === 'powerup') {
      const { item, body } = event.command;
      promise = call(api, 'powerup', item.userId, `/races/${item.raceId}/powerups/${item.id}/use`, body, fixture,
        { powerupId: item.id, powerupType: item.type, raceId: item.raceId, phase: 'load' });
    } else {
      const user = fixture.users[(event.index * 41) % fixture.users.length];
      const version = (fixture.versions.get(user.id) || 0) + 1; fixture.versions.set(user.id, version);
      const body = { date: new Date(fixture.sampleEnd - 1).toISOString().slice(0, 10), steps: 240 + version,
        samples: Array.from({ length: 24 }, (_, i) => ({ periodStart: new Date(fixture.sampleStart + i * 300000).toISOString(),
          periodEnd: new Date(fixture.sampleStart + (i + 1) * 300000).toISOString(), steps: i === 23 ? 10 + version : 10 })) };
      promise = call(api, 'sync', user.id, '/steps/sync-v2', body, fixture);
    }
    pending.add(promise); promise.finally(() => pending.delete(promise));
    maxInflight = Math.max(maxInflight, pending.size);
  }
  await Promise.all(pending);
  return { offered: events.length, maxInflight, maxScheduleLagMs, elapsedMs: performance.now() - start };
}
async function verify(fixture, apis, drained) {
  const failures = [];
  const check = (kind, fn) => { try { fn(); } catch (error) { failures.push({ kind, error: error.message }); } };
  check('drain', () => assert.equal(drained.drained, true));
  check('resolution failures', () => assert.equal(drained.last.resolution_failed, 0));
  check('post-task failures', () => assert.equal(drained.last.post_failed, 0));
  const expectedBonus = new Map(fixture.members.map((p) => [p.id, 10000]));
  const memberByRaceUser = new Map(fixture.members.map((p) => [`${p.raceId}/${p.userId}`, p]));
  const powerRows = await prisma.racePowerup.findMany({ where: { id: { in: [...fixture.commands.map((c) => c.item.id), fixture.outage.item.id] } } });
  const powersById = new Map(powerRows.map((p) => [p.id, p]));
  for (const r of results.filter((r) => r.kind === 'powerup' && r.status > 0)) {
    const item = powersById.get(r.powerupId);
    check('terminal contract', () => {
      if (r.status === 200) { assert.ok(r.body.result && typeof r.body.result === 'object'); assert.equal(item.status, 'USED'); }
      else if (r.status < 500) { assert.equal(typeof r.body.error, 'string'); assert.equal(item.status, 'HELD'); }
    });
    if (r.status === 200 && ['PROTEIN_SHAKE', 'TRAIL_MIX'].includes(r.powerupType)) {
      const p = memberByRaceUser.get(`${r.raceId}/${r.userId}`);
      check('bonus response', () => assert.ok(Number.isInteger(r.body.result.bonus) && r.body.result.bonus > 0));
      expectedBonus.set(p.id, expectedBonus.get(p.id) + r.body.result.bonus);
    }
  }
  // Immutable successful Shortcut feed rows preserve actual reflected source
  // and landing recipient even when the wire response omits a redirected ID.
  const steals = await prisma.racePowerupEvent.findMany({ where: { powerupType: 'SHORTCUT', eventType: 'POWERUP_USED' } });
  for (const event of steals) {
    const stolen = event.metadata?.stolen;
    check('shortcut ledger', () => assert.ok(Number.isInteger(stolen) && stolen >= 0));
    const caster = memberByRaceUser.get(`${event.raceId}/${event.actorUserId}`);
    const target = memberByRaceUser.get(`${event.raceId}/${event.targetUserId}`);
    if (!caster || !target) { failures.push({ kind: 'shortcut ledger', error: 'Missing participant' }); continue; }
    expectedBonus.set(caster.id, expectedBonus.get(caster.id) + stolen);
    expectedBonus.set(target.id, expectedBonus.get(target.id) - stolen);
  }
  check('shortcut result count', () => assert.equal(steals.length, results.filter((r) => r.kind === 'powerup' && r.powerupType === 'SHORTCUT' && r.status === 200 && !r.body.result.blocked).length));
  const stored = await prisma.raceParticipant.findMany({ where: { raceId: { in: fixture.races.map((r) => r.id) } }, select: { id: true, raceId: true, userId: true, rawSteps: true, totalSteps: true, bonusSteps: true } });
  for (const p of stored) {
    check('stored raw steps', () => assert.equal(p.rawSteps, fixture.expectedRaw.get(p.userId), p.id));
    check('stored bonus', () => assert.equal(p.bonusSteps, expectedBonus.get(p.id), p.id));
    check('stored total', () => assert.equal(p.totalSteps, fixture.expectedRaw.get(p.userId) + expectedBonus.get(p.id), p.id));
  }
  const beforeReadsFailures = failures.length;
  for (const race of [...new Map([fixture.races[0], fixture.races.at(-1)].map((r) => [r.id, r])).values()]) {
    const response = await fetch(`${apis[0].baseUrl}/races/${race.id}/progress`, { headers: { Authorization: `Bearer ${fixture.tokens.get(race.creatorId)}`, 'X-Timezone': 'UTC' }, signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    check('public progress', () => {
      assert.equal(response.status, 200);
      const participant = body.progress.participants.find((p) => p.userId === race.creatorId);
      const expected = stored.find((p) => p.raceId === race.id && p.userId === race.creatorId);
      assert.equal(participant.totalSteps, expected.totalSteps);
    });
  }
  return { passed: failures.length === 0, participantsChecked: stored.length, beforeReadsFailures, failures };
}
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const evidence = { arm, profile, rate, syncRate, seconds, epoch, sourceRoot, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
    drainMs, hashes: Object.fromEntries(['load.js', 'process.js', 'queue.js', 'queueBatch.js'].map((name) => [name, createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex')])),
    sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff'], { cwd: sourceRoot })).digest('hex'),
    topology: { http: 2, resolution: 1, pools: [10, 10, 8], sharedWorkConcurrency: 3 },
    results, samples, startedCommands };
  try {
    const fixture = await seed();
    if (arm === 'C' || arm === 'D') await require('./queue').installQueueSchema();
    const apis = [await boot('http', 0), await boot('http', 1)];
    await boot('worker', 0);
    await delay(1000);
    evidence.processStart = await measureProcesses();
    sampleDbCpu();
    const measuredStart = Date.now();
    let sampling = false;
    const timer = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try { samples.push(await snapshot()); } catch (error) { evidence.samplingError = error.message; }
      finally { sampling = false; }
    }, 1000);
    try {
      evidence.load = await workload(fixture, apis);
      evidence.loadDbCpu = { ...sampleDbCpu(), elapsedMs: Date.now() - measuredStart };
      evidence.processLoadEnd = await measureProcesses();
      const { item, body } = fixture.outage;
      await call(apis[0], 'powerup', item.userId, `/races/${item.raceId}/powerups/${item.id}/use`, body, fixture,
        { powerupId: item.id, powerupType: item.type, raceId: item.raceId, phase: 'fanout-probe' });
      evidence.drain = await drain(drainMs);
    } finally { clearInterval(timer); while (sampling) await delay(10); }
    evidence.measuredElapsedMs = Date.now() - measuredStart;
    evidence.processDrainEnd = await measureProcesses();
    evidence.postTaskOutcomes = await prisma.$queryRawUnsafe('SELECT state,snapshot_state,snapshot_error_code,COUNT(*)::int AS count FROM race_resolution_post_tasks GROUP BY 1,2,3');
    if (arm === 'C' || arm === 'D') evidence.commandOutcomes = await prisma.$queryRawUnsafe('SELECT state,status,post_done,post_error,post_attempts,COUNT(*)::int AS count FROM experiment_powerup_commands GROUP BY 1,2,3,4,5');
    evidence.dbCpu = { cpuSeconds: dbCpuSeconds, percentOneCore: dbCpuSeconds * 100000 / evidence.measuredElapsedMs,
      method: 'sum positive ps CPU-time deltas for dedicated PostgreSQL parent and children; one-second sampling; excludes unknown CPU before a newly seen PID first sample' };
    evidence.oracle = await verify(fixture, apis, evidence.drain);
    for (const kind of ['powerup', 'sync']) {
      const rows = results.filter((r) => r.kind === kind && r.phase !== 'fanout-probe');
      evidence[kind] = { statuses: rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}),
        latency: quantiles(rows.filter((r) => r.status > 0).map((r) => r.ms)),
        successfulLatency: quantiles(rows.filter((r) => r.status === (kind === 'sync' ? 202 : 200)).map((r) => r.ms)),
        deadlineMisses: rows.filter((r) => r.ms > 15000).length };
    }
    evidence.byPowerupType = Object.fromEntries([...new Set(results.filter(r => r.kind === 'powerup').map(r => r.powerupType))].map(type => {
      const rows = results.filter(r => r.powerupType === type);
      return [type, { statuses: rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {}),
        latency: quantiles(rows.filter(r => r.status > 0).map(r => r.ms)), successfulLatency: quantiles(rows.filter(r => r.status === 200).map(r => r.ms)) }];
    }));
  } catch (error) { evidence.fatal = { message: error.message, stack: error.stack }; }
  finally {
    await stopChildren();
    evidence.processes = children.map(({ role, index, metrics, exitCode, forcedStop }) => ({ role, index, metrics, exitCode, forcedStop }));
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    await prisma.$disconnect();
    await fromSource('src/shared/cache/redisCache').close();
  }
  // All owned children, DB and Redis connections are closed and evidence is
  // persisted. Imported application timers must not prolong the experiment.
  process.stdout.write(JSON.stringify({ output, fatal: evidence.fatal?.message, oracle: evidence.oracle, powerup: evidence.powerup, sync: evidence.sync, dbCpu: evidence.dbCpu }) + '\n',
    () => process.exit(evidence.fatal || !evidence.oracle?.passed ? 1 : 0));
}
main().catch(async (error) => { console.error(error); await stopChildren(); await prisma.$disconnect(); process.exitCode = 1; });
