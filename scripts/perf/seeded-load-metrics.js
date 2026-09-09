const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
function sourceIdentity(root) {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src', 'prisma', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) { digest.update(file); digest.update('\0'); digest.update(readFileSync(resolve(root, file))); }
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceSha256: digest.digest('hex'), node: process.version };
}
function cpuMilliseconds(value) {
  const [daysPart, clockPart] = value.includes('-') ? value.split('-') : ['0', value];
  const fields = clockPart.split(':').map(Number);
  let seconds = 0;
  for (const field of fields) seconds = seconds * 60 + field;
  return (Number(daysPart) * 86400 + seconds) * 1000;
}
async function databaseSnapshot(client) {
  const [stats, processes] = await Promise.all([
    client.query('/*seeded_load_monitor*/ SELECT xact_commit,xact_rollback,tup_inserted,tup_updated,tup_deleted,tup_returned,tup_fetched,blks_read,blks_hit,temp_bytes,deadlocks FROM pg_stat_database WHERE datname=current_database()'),
    client.query("/*seeded_load_monitor*/ SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name <> 'seeded_load_monitor'"),
  ]);
  const cpu = {};
  if (processes.rows.length) {
    const output = execFileSync('ps', ['-p', processes.rows.map(row => row.pid).join(','), '-o', 'pid=', '-o', 'time='], { encoding: 'utf8' });
    for (const line of output.trim().split('\n')) {
      const [pid, time] = line.trim().split(/\s+/);
      if (pid && time) cpu[pid] = cpuMilliseconds(time);
    }
  }
  return { counters: stats.rows[0], backendCpuByPid: cpu };
}
function databaseDelta(before, after) {
  return {
    counters: Object.fromEntries(Object.keys(before.counters).map(key => [key, Number(after.counters[key]) - Number(before.counters[key])])),
    backendCpuMs: Object.entries(after.backendCpuByPid).reduce((sum, [pid, value]) => sum + Math.max(0, value - (before.backendCpuByPid[pid] || 0)), 0),
    limitations: ['CPU sums PostgreSQL connection backends; shared WAL/checkpointer CPU excluded', 'Cumulative PostgreSQL counters may lag; row-return/fetch counts are not an EXPLAIN estimate of rows scanned'],
  };
}
async function queueSample(client, now = new Date()) {
  const result = await client.query(`/*seeded_load_monitor*/ SELECT
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name <> 'seeded_load_monitor' AND wait_event_type='Lock') lock_waiters,
    (SELECT count(*)::int FROM race_resolution_jobs_v2 WHERE state IN ('queued','running')) core_queued,
    (SELECT count(*)::int FROM race_resolution_post_tasks WHERE state IN ('queued','running','retry')) post_queued,
    (SELECT count(*)::int FROM race_placement_transition_jobs WHERE state IN ('queued','running','retry')) placement_queued,
    (SELECT greatest(0,COALESCE(max(EXTRACT(EPOCH FROM ($1::timestamptz-requested_at))),0))::float FROM race_resolution_jobs_v2 WHERE state='queued') oldest_queue_seconds`, [now]);
  return result.rows[0];
}
module.exports = { databaseSnapshot, databaseDelta, queueSample, sourceIdentity };
