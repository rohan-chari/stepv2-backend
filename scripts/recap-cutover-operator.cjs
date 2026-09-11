#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const guard = require('./pm2-topology-guard');
const PROD = '/var/www/step-tracker-backend';
const NAMES = ['steps-tracker', 'steps-tracker-cron', 'steps-tracker-resolution'];
const APP_NAMES = new Set(['steps-http-0', 'steps-http-1', 'steps-resolution-0', 'steps-cron-0']);
const CENSUS_SQL = `SELECT pid,backend_start::text,application_name,query_start::text,state,xact_start::text,usename
  FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
  AND backend_type='client backend' ORDER BY pid LIMIT 33`;
const TERMINATE_SQL = `SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
  WHERE pid=$1 AND backend_start=$2::timestamptz AND application_name=$3 AND query_start=$4::timestamptz
  AND state='idle' AND xact_start IS NULL AND datname=current_database() AND usename=current_user
  AND pid<>pg_backend_pid() AND backend_type='client backend'`;
function validateIdleBackends(rows) {
  if (!Array.isArray(rows) || rows.length > 32) throw Error('unbounded database clients');
  if (new Set(rows.map(row => row.pid)).size !== rows.length) throw Error('duplicate database identity');
  for (const row of rows) {
    if (!Number.isInteger(row.pid) || row.pid <= 0 || !APP_NAMES.has(row.application_name) ||
      row.state !== 'idle' || row.xact_start !== null ||
      typeof row.backend_start !== 'string' || !row.backend_start ||
      typeof row.query_start !== 'string' || !row.query_start) throw Error('unknown or active database client');
  }
  return rows;
}
function pgEnvironment(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.port !== '25060' ||
    !url.hostname || !url.username || !url.password || url.pathname.length < 2 || url.hash ||
    [...url.searchParams.keys()].some(key => key !== 'sslmode')) throw Error('invalid direct database target');
  const sslmode = url.searchParams.get('sslmode') || 'require';
  if (sslmode !== 'require') throw Error('direct database requires reviewed TLS require mode');
  return { PGHOST: url.hostname, PGPORT: url.port, PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: sslmode,
    PGAPPNAME: 'steps-recap-cutover-operator', PGCONNECT_TIMEOUT: '10',
    PGOPTIONS: '-c timezone=UTC -c statement_timeout=120000 -c lock_timeout=5000' };
}
function verifyInput(input) {
  const allowed = new Set(['backupPath','backupSha256','directUrl','expectedCommit','expectedPackageLockSha256']);
  if (!input || Object.keys(input).some(key => !allowed.has(key)) ||
    !/^[a-f0-9]{40}$/.test(input.expectedCommit) || !/^[a-f0-9]{64}$/.test(input.backupSha256) ||
    (input.expectedPackageLockSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedPackageLockSha256)) ||
    typeof input.backupPath !== 'string' || !path.isAbsolute(input.backupPath)) throw Error('invalid operator input');
  return pgEnvironment(input.directUrl);
}
function verifyBackup(input) {
  const fd = fs.openSync(input.backupPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !before.size || (before.mode & 0o077) !== 0 || before.uid !== process.getuid()) {
      throw Error('backup must be a private owned regular file');
    }
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      hash.digest('hex') !== input.backupSha256) throw Error('backup checksum changed or mismatched');
  } finally { fs.closeSync(fd); }
}
function proc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
    const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    return { pid, ppid: Number(fields[1]), startTimeTicks: Number(fields[19]),
      cwd: fs.readlinkSync(`/proc/${pid}/cwd`), executable: fs.readlinkSync(`/proc/${pid}/exe`),
      argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
      pmExecPath: environment.find(value => value.startsWith('pm_exec_path='))?.slice(13) };
  } catch (error) {
    if (['ENOENT','ESRCH'].includes(error.code)) return null;
    throw Error('cannot prove OS process identity');
  }
}
function command(binary, args, env = process.env) {
  // Never inherit stdout/stderr: PM2/pg errors may contain environment secrets.
  return execFileSync(binary, args, { cwd: PROD, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'],
    timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
}
function snapshot() {
  const entries = JSON.parse(command('pm2', ['jlist']));
  const variables = ['NODE_APP_INSTANCE','STEPS_PROCESS_ROLE','DATABASE_POOL_MAX_HTTP',
    'DATABASE_POOL_MAX_RESOLUTION','DATABASE_POOL_MAX_CRON','DATABASE_POOL_TOTAL_BUDGET',
    'MIN_SUPPORTED_APP_VERSION','LATEST_APP_VERSION'];
  const pm2 = entries.map(entry => ({ pid: entry.pid, name: entry.name, status: entry.pm2_env?.status,
    cwd: entry.pm2_env?.pm_cwd, maxMemoryRestartBytes: entry.pm2_env?.max_memory_restart,
    environment: Object.fromEntries(variables.filter(key => Object.hasOwn(entry.pm2_env || {}, key))
      .map(key => [key, String(entry.pm2_env[key])])) }));
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(proc).filter(Boolean);
  const registered = pm2.filter(row => row.status === 'online' && row.cwd === PROD && NAMES.includes(row.name));
  const parents = new Set(registered.map(row => processes.find(candidate => candidate.pid === row.pid)?.ppid));
  if (parents.size !== 1 || parents.has(undefined)) throw Error('cannot establish one PM2 daemon');
  const daemonPid = [...parents][0];
  if (pm2.some(row => row.name === 'steps-tracker-staging' && row.status !== 'stopped')) throw Error('staging must remain stopped');
  return { pm2, processes, daemonPid };
}
function validateOperatorTopology(state) {
  // The generic rolling guard scopes to the PM2 daemon. A stopped-writer
  // cutover must also reject standalone/reparented copies of production code.
  if (!guard.classifyTopology({ ...state, daemonPid: undefined }).healthy) throw Error('unhealthy operator topology');
  const registered = new Set(state.pm2.filter(row => row.status === 'online' && row.cwd === PROD && NAMES.includes(row.name)).map(row => row.pid));
  if (state.processes.some(row => isAnyProductionWriter(row) && !registered.has(row.pid))) throw Error('unhealthy operator topology');
}
function isAnyProductionWriter(row) {
  if (guard.isProductionNodeProcess(row)) return true;
  return row.cwd === PROD && path.basename(row.executable || '') === 'node' &&
    Array.isArray(row.argv) && row.argv.some(arg => path.resolve(PROD, arg) === path.join(PROD,'src/index.js') || /^node (?:\.\/)?src\/index\.js$/.test(arg));
}
async function quiesceDatabase(directUrl) {
  const env = pgEnvironment(directUrl);
  const { Client } = require('pg');
  const client = new Client({ host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE,
    user: env.PGUSER, password: env.PGPASSWORD, ssl: { rejectUnauthorized: false },
    application_name: env.PGAPPNAME, connectionTimeoutMillis: 10000, query_timeout: 10000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000 -c timezone=UTC' });
  await client.connect();
  try {
    const rows = validateIdleBackends((await client.query(CENSUS_SQL)).rows);
    if (rows.some(row => row.usename !== env.PGUSER)) throw Error('unexpected database owner');
    // Validate the entire bounded census before terminating even one backend.
    for (const row of rows) {
      const result = await client.query(TERMINATE_SQL,
        [row.pid, row.backend_start, row.application_name, row.query_start]);
      if (result.rowCount !== 1 || result.rows[0].terminated !== true) throw Error('database identity changed');
    }
    const deadline = Date.now() + 10000;
    while ((await client.query(CENSUS_SQL)).rowCount) {
      if (Date.now() >= deadline) throw Error('database clients did not drain');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { await client.end(); }
}
async function runCutover(input, io) {
  io.stage?.('preflight');
  verifyInput(input);
  const state = await io.preflight(input);
  io.stage?.('stop-http');
  await io.stop('steps-tracker');
  io.stage?.('stop-cron');
  await io.stop('steps-tracker-cron');
  const cronStoppedAt = io.now();
  io.stage?.('stop-resolution');
  await io.stop('steps-tracker-resolution');
  const deadline = io.now() + 120000;
  io.stage?.('prove-old-writers-gone');
  while ((await Promise.all(state.old.map(row => io.stillOld(row)))).some(Boolean)) {
    if (io.now() >= deadline) throw Error('old processes did not exit');
    await io.sleep(Math.min(1000, deadline - io.now()));
  }
  await io.ensureStopped();
  io.stage?.('drain-validated-idle-pool-backends');
  await io.quiesce(input.directUrl);
  await io.ensureStopped();
  io.stage?.('sql-cutover');
  await io.sql('simple-event-recap-cutover.sql');
  io.stage?.('sql-verify');
  await io.sql('simple-event-recap-verify.sql');
  const leaseRemaining = cronStoppedAt + 30000 - io.now();
  io.stage?.('legacy-cron-lease-wait');
  if (leaseRemaining > 0) await io.sleep(leaseRemaining);
  await io.verifyBeforeRestart(input);
  for (const name of ['steps-tracker-resolution','steps-tracker-cron','steps-tracker']) {
    io.stage?.('start-' + name); await io.start(name);
  }
  io.stage?.('final-topology-config-budget');
  await io.verifyFinal(state);
  io.stage?.('save-verified-topology');
  await io.save();
}
function realIO(input, report = () => {}) {
  let versions, apps, pgEnv;
  function verifyReviewedTree() {
    if (command('git', ['rev-parse','HEAD']).trim() !== input.expectedCommit) throw Error('HEAD does not match reviewed commit');
    const dirty = command('git', ['status','--porcelain','--untracked-files=no']).trimEnd();
    if (dirty && (dirty !== ' M package-lock.json' || !input.expectedPackageLockSha256)) {
      throw Error('unreviewed tracked deployment changes');
    }
    if (input.expectedPackageLockSha256) {
      const filename = path.join(PROD, 'package-lock.json');
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(fd).isFile() || crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== input.expectedPackageLockSha256) {
          throw Error('preserved package lock checksum differs');
        }
      } finally { fs.closeSync(fd); }
    }
  }
  function ensureStopped() {
    const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).map(proc).filter(Boolean);
    if (processes.some(isAnyProductionWriter)) throw Error('production writer still exists');
  }
  return {
    stage: report,
    now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    preflight: async () => {
      if (process.cwd() !== PROD || process.getuid() !== 0) throw Error('operator requires production cwd and root');
      pgEnv = verifyInput(input);
      // One explicitly checksummed pre-existing lockfile modification is allowed;
      // no other tracked difference or automatic overwrite is permitted.
      verifyReviewedTree();
      report('preflight-backup-checksum');
      verifyBackup(input);
      report('preflight-config-and-topology');
      const stored = require('dotenv').parse(fs.readFileSync(path.join(PROD, '.env')));
      const safe = require('../src/shared/validation/appVersion').isSafeAppVersion;
      versions = { MIN_SUPPORTED_APP_VERSION: stored.MIN_SUPPORTED_APP_VERSION,
        LATEST_APP_VERSION: stored.LATEST_APP_VERSION || stored.MIN_SUPPORTED_APP_VERSION };
      if (Object.values(versions).some(value => !safe(value) || value === 'unknown')) throw Error('invalid deployed app versions');
      const pooled = new URL(stored.DATABASE_URL);
      if (pooled.port !== '25061' || pooled.hostname !== pgEnv.PGHOST ||
        decodeURIComponent(pooled.pathname) !== '/step-tracker-pool' || pgEnv.PGDATABASE !== 'step-tracker' ||
        decodeURIComponent(pooled.username) !== pgEnv.PGUSER) {
        throw Error('direct target does not match deployed application database');
      }
      Object.assign(process.env, versions);
      apps = require('../ecosystem.config').apps;
      if (guard.validateStaticPoolBudget(apps).totalBudget !== 32) throw Error('reviewed budget must remain 32');
      const initial = snapshot();
      validateOperatorTopology(initial);
      const baseline = guard.captureLivePoolBaseline(initial.pm2);
      const old = initial.pm2.filter(row => row.status === 'online' && row.cwd === PROD && NAMES.includes(row.name))
        .map(row => initial.processes.find(candidate => candidate.pid === row.pid));
      if (old.length !== 4 || old.some(row => !Number.isSafeInteger(row.startTimeTicks))) throw Error('old process snapshot incomplete');
      return { baseline, old };
    },
    stop: async name => { command('pm2', ['stop', name]); },
    stillOld: async old => guard.isSameProcess(old, proc(old.pid)),
    ensureStopped: async () => { ensureStopped(); },
    quiesce: quiesceDatabase,
    sql: async file => { command('psql', ['--no-psqlrc','--set=ON_ERROR_STOP=1','--file='+path.join(PROD,'scripts',file)],
      { PATH: process.env.PATH, LANG: 'C', ...pgEnv }); },
    verifyBeforeRestart: async () => { verifyReviewedTree(); ensureStopped(); },
    start: async name => { command('pm2', ['start', path.join(PROD,'ecosystem.config.js'), '--only', name, '--update-env'],
      { ...process.env, ...versions }); },
    verifyFinal: async state => {
      // No orphan remediation or memory restarts: any mismatch holds save and
      // requires explicit recovery, not a new unreviewed topology mutation.
      const final = snapshot();
      validateOperatorTopology(final);
      const budget = guard.validateLivePoolBudget(final.pm2, { mode: 'final', apps, baseline: state.baseline });
      if (budget.aggregate !== 32) throw Error('final pool budget is not 32');
      for (const row of final.pm2.filter(row => row.name === 'steps-tracker' && row.status === 'online')) {
        if (row.maxMemoryRestartBytes !== 100 * 1024 ** 3 ||
          Object.entries(versions).some(([key,value]) => row.environment[key] !== value)) throw Error('live HTTP configuration differs');
      }
    },
    save: async () => { command('pm2', ['save']); },
  };
}
module.exports = { runCutover, validateIdleBackends, pgEnvironment, TERMINATE_SQL, CENSUS_SQL, verifyInput, verifyBackup, validateOperatorTopology };
if (require.main === module) {
  let stage = 'input';
  (async () => {
    let text = ''; for await (const chunk of process.stdin) {
      text += chunk; if (Buffer.byteLength(text) > 65536) throw Error('oversized input');
    }
    const input = JSON.parse(text);
    await runCutover(input, realIO(input, name => {
      stage = name; process.stdout.write(`Recap cutover stage: ${name}\n`);
    }));
    process.stdout.write('Recap cutover verified; production topology saved.\n');
  })().catch(() => {
    // Do not print Error/stack/child output: they can embed stdin credentials.
    process.stderr.write(`Recap cutover failed closed at stage: ${stage}. Do not restart old code; inspect the stopped-writer state and recover explicitly.\n`);
    process.exitCode = 1;
  });
}
