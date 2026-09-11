const test = require('node:test');
const assert = require('node:assert/strict');
const { runCutover, validateIdleBackends, pgEnvironment, TERMINATE_SQL, verifyBackup,
  validateOperatorTopology } = require('../../scripts/recap-cutover-operator.cjs');
const input = { directUrl: 'postgresql://operator:secret@db.example:25060/app?sslmode=require',
  expectedCommit: 'a'.repeat(40), backupPath: '/root/backups/verified.dump', backupSha256: 'b'.repeat(64) };
const idle = { pid: 88, backend_start: '2026-09-11 10:00:00.123456+00',
  application_name: 'steps-http-0', query_start: '2026-09-11 10:01:00.123456+00',
  state: 'idle', xact_start: null };
function fixture(overrides = {}) {
  const calls = []; let time = 0; let checks = 0;
  const io = { now: () => time, sleep: async ms => { calls.push(['wait', ms]); time += ms; },
    preflight: async () => { calls.push(['preflight']); return { old: [1,2,3,4].map(pid => ({ pid, startTimeTicks: 1 })), baseline: {} }; },
    stop: async name => calls.push(['stop', name]),
    stillOld: async () => false,
    ensureStopped: async () => calls.push(['all-writers-gone']),
    quiesce: async () => calls.push(['quiesce']),
    sql: async name => calls.push(['sql', name]),
    verifyBeforeRestart: async () => calls.push(['restart-preflight']),
    start: async name => calls.push(['start', name, time]),
    verifyFinal: async () => { calls.push(['final']); checks++; },
    save: async () => calls.push(['save']), ...overrides };
  return { io, calls, get checks() { return checks; } };
}
test('all four old writers exit before SQL; lease expires before ordered restart; save last', async () => {
  const f = fixture(); await runCutover(input, f.io);
  assert.deepEqual(f.calls.filter(x => x[0] === 'stop').map(x => x[1]),
    ['steps-tracker', 'steps-tracker-cron', 'steps-tracker-resolution']);
  assert.deepEqual(f.calls.filter(x => x[0] === 'sql').map(x => x[1]),
    ['simple-event-recap-cutover.sql', 'simple-event-recap-verify.sql']);
  assert.deepEqual(f.calls.filter(x => x[0] === 'start').map(x => x[1]),
    ['steps-tracker-resolution', 'steps-tracker-cron', 'steps-tracker']);
  assert.ok(f.calls.filter(x => x[0] === 'start').every(x => x[2] >= 30000));
  assert.equal(f.calls.at(-1)[0], 'save');
});
test('preflight failure cannot stop, start, write SQL or save', async () => {
  const f = fixture({ preflight: async () => { throw Error('bad backup'); } });
  await assert.rejects(runCutover(input, f.io)); assert.deepEqual(f.calls, []);
});
test('old process timeout holds traffic and never touches database or starts', async () => {
  const f = fixture({ stillOld: async () => true });
  await assert.rejects(runCutover(input, f.io), /old processes/);
  assert.ok(f.io.now() <= 120000);
  assert.equal(f.calls.some(x => ['quiesce', 'sql', 'start', 'save'].includes(x[0])), false);
});
for (const phase of ['quiesce', 'sql']) test(`${phase} failure never restarts or saves`, async () => {
  const f = fixture({ [phase]: async () => { throw Error('blocked'); } });
  await assert.rejects(runCutover(input, f.io));
  assert.equal(f.calls.some(x => ['start','save'].includes(x[0])), false);
});
test('final guard failure cannot save', async () => {
  const f = fixture({ verifyFinal: async () => { throw Error('bad topology'); } });
  await assert.rejects(runCutover(input, f.io)); assert.equal(f.calls.some(x => x[0] === 'save'), false);
});
test('post-cutover SQL verifier failure holds every application stopped', async () => {
  const f = fixture({ sql: async file => { if (file.includes('verify')) throw Error('catalog mismatch'); } });
  await assert.rejects(runCutover(input, f.io));
  assert.equal(f.calls.some(x => ['start','save'].includes(x[0])), false);
});
test('preserved file drift detected before restart leaves all applications stopped', async () => {
  const f = fixture({ verifyBeforeRestart: async () => { throw Error('preserved lockfile changed'); } });
  await assert.rejects(runCutover(input, f.io));
  assert.equal(f.calls.some(x => ['start','save'].includes(x[0])), false);
});
test('pool cleanup accepts only bounded exact idle no-transaction application identities', () => {
  assert.deepEqual(validateIdleBackends([idle]), [idle]);
  for (const change of [{ state: 'active' }, { state: 'idle in transaction' }, { xact_start: 'now' },
    { application_name: 'psql' }, { application_name: 'steps-http-2' }, { query_start: null }, { pid: 0 }]) {
    assert.throws(() => validateIdleBackends([{ ...idle, ...change }]));
  }
  assert.throws(() => validateIdleBackends(Array.from({ length: 33 }, (_, i) => ({ ...idle, pid: i + 1 }))));
});
test('termination revalidates every identity field atomically and never targets active clients', () => {
  for (const term of ['pid=$1', 'backend_start=$2', 'application_name=$3', 'query_start=$4',
    "state='idle'", 'xact_start IS NULL', 'pid<>pg_backend_pid()', "backend_type='client backend'"]) {
    assert.ok(TERMINATE_SQL.includes(term), term);
  }
});
test('direct libpq secrets are env-only; pooled endpoint and unsafe input rejected', () => {
  const env = pgEnvironment(input.directUrl);
  assert.equal(env.PGPASSWORD, 'secret'); assert.equal(env.PGPORT, '25060');
  assert.equal(env.PGSSLMODE, 'require');
  assert.throws(() => pgEnvironment(input.directUrl.replace('25060', '25061')));
  assert.throws(() => pgEnvironment('postgresql://operator:secret@db.example/app?options=unsafe'));
});
test('backup identity requires private owned regular file and exact SHA256, rejecting symlinks', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recap-operator-test-'));
  const backupPath = path.join(dir, 'backup.dump'), link = path.join(dir, 'link.dump');
  fs.writeFileSync(backupPath, 'synthetic test-only backup', { mode: 0o600 });
  t.after(() => { fs.unlinkSync(link); fs.unlinkSync(backupPath); fs.rmdirSync(dir); });
  const good = { ...input, backupPath,
    backupSha256: crypto.createHash('sha256').update('synthetic test-only backup').digest('hex') };
  assert.doesNotThrow(() => verifyBackup(good));
  assert.throws(() => verifyBackup({ ...good, backupSha256: '0'.repeat(64) }), /checksum/);
  fs.chmodSync(backupPath, 0o644); assert.throws(() => verifyBackup(good), /private/);
  fs.chmodSync(backupPath, 0o600); fs.symlinkSync(backupPath, link);
  assert.throws(() => verifyBackup({ ...good, backupPath: link }));
});
test('operator failures never echo credentials supplied through stdin', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/recap-cutover-operator.cjs'], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: require('node:path').resolve(__dirname, '../..'),
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /secret|db\.example|operator:|backupSha256|stack/i);
  assert.match(result.stderr, /failed closed/);
});
test('wrapper holds the existing shared flock and never interpolates secret input', () => {
  const wrapper = require('node:fs').readFileSync(require('node:path').resolve(__dirname,
    '../../scripts/pm2-safe-recap-cutover.sh'), 'utf8');
  assert.match(wrapper, /exec flock -w 120 \/run\/steps-tracker-pm2\.lock node scripts\/recap-cutover-operator\.cjs/);
  assert.doesNotMatch(wrapper, /\$\*|\$@|read |eval |psql|pm2 (?:save|start|stop)/);
});
test('operator topology rejects standalone production writers regardless of their parent', () => {
  const names = ['steps-tracker','steps-tracker','steps-tracker-resolution','steps-tracker-cron'];
  const pm2 = names.map((name,i) => ({ name, pid: i + 10, status: 'online', cwd: '/var/www/step-tracker-backend' }));
  const processes = pm2.map(row => ({ pid: row.pid, ppid: 9, cwd: row.cwd, executable: '/usr/bin/node',
    argv: ['/var/www/step-tracker-backend/src/index.js'], startTimeTicks: 1 }));
  assert.doesNotThrow(() => validateOperatorTopology({ pm2, processes, daemonPid: 9 }));
  assert.throws(() => validateOperatorTopology({ pm2, daemonPid: 9,
    processes: [...processes, { ...processes[0], pid: 123, ppid: 1 }] }), /topology/);
  assert.throws(() => validateOperatorTopology({ pm2, daemonPid: 9,
    processes: [...processes, { ...processes[0], pid: 124, ppid: 1, argv: ['node','src/index.js'] }] }), /topology/);
});
