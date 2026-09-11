const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const path = require('node:path');

// Test-only initializer. Production migration deployment never invokes cutover.
const target = new URL(process.env.DATABASE_URL || 'postgresql://rohan@localhost:5432/steps-tracker-integration_test');
const database = decodeURIComponent(target.pathname.slice(1));
if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/_test$/.test(database)) {
  throw new Error('Integration runner requires a loopback PostgreSQL *_test database');
}
const env = { ...process.env, DATABASE_URL: target.toString(), NODE_ENV: 'test',
  REDIS_URL: process.env.REDIS_URL || '',
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'admin@test.com',
  SESSION_TOKEN_SECRET: process.env.SESSION_TOKEN_SECRET || 'integration-test-only-session-secret',
  REFERRAL_IP_HMAC_ACTIVE_VERSION: '1',
  REFERRAL_IP_HMAC_SECRET_V1: 'integration-test-only-referral-hmac-secret-material' };
const root = path.resolve(__dirname, '..');
function run(command, args) { execFileSync(command, args, { cwd: root, env, stdio: 'inherit' }); }
async function main() {
  const adminUrl = new URL(target); adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount) {
      await admin.query('CREATE DATABASE "' + database.replaceAll('"', '""') + '"');
    }
  } finally { await admin.end(); }
  run('npx', ['prisma', 'migrate', 'deploy']);
  run('npm', ['run', 'identity-search-indexes:apply']);
  const probe = new Client({ connectionString: target.toString() });
  await probe.connect();
  let retired;
  try { retired = (await probe.query("SELECT to_regclass('public.global_event_summary_work') IS NOT NULL AS present")).rows[0].present; }
  finally { await probe.end(); }
  // The script itself enforces zero other sessions; never terminate another
  // test's connections or weaken the same stopped-writer guard used in prod.
  if (retired) run('psql', [target.toString(), '--set=ON_ERROR_STOP=1', '--file=scripts/simple-event-recap-cutover.sql']);
  const args = process.argv.slice(2);
  if (args[0] === '--prepare-only') return;
  run(process.execPath, ['--test', '--test-concurrency=1', '--test-force-exit',
    ...(args.length ? args : ['test/integration/**/*.test.js'])]);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
