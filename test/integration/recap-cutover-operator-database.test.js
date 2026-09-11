const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { TERMINATE_SQL, validateIdleBackends } = require('../../scripts/recap-cutover-operator.cjs');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);

test('operator termination SQL rejects stale/active identities and terminates only the exact local idle backend', async () => {
  const observer = new Client({ connectionString: target.toString(), application_name: 'recap-test-observer' });
  const victim = new Client({ connectionString: target.toString(), application_name: 'steps-http-0' });
  const unrelated = new Client({ connectionString: target.toString(), application_name: 'unrelated-test-client' });
  let disconnected = false;
  victim.on('error', () => { disconnected = true; });
  await Promise.all([observer.connect(), victim.connect(), unrelated.connect()]);
  try {
    const pid = (await victim.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const read = async () => (await observer.query(`SELECT pid,backend_start::text,application_name,
      query_start::text,state,xact_start::text FROM pg_stat_activity WHERE pid=$1`, [pid])).rows[0];
    const stale = await read();
    validateIdleBackends([stale]);
    const terminate = row => observer.query(TERMINATE_SQL,
      [row.pid,row.backend_start,row.application_name,row.query_start]);
    await victim.query('SELECT 2');
    assert.equal((await terminate(stale)).rowCount, 0, 'query-start changes must invalidate a prior identity');
    await victim.query('BEGIN');
    const inTransaction = await read();
    assert.throws(() => validateIdleBackends([inTransaction]));
    assert.equal((await terminate(inTransaction)).rowCount, 0, 'idle-in-transaction cannot be terminated');
    await victim.query('ROLLBACK');
    const current = await read();
    const wrongStart = { ...current, backend_start: '1970-01-01 00:00:00+00' };
    assert.equal((await terminate(wrongStart)).rowCount, 0, 'PID lifetime must still match');
    assert.equal((await terminate({ ...current, application_name: 'steps-cron-0' })).rowCount, 0);
    const result = await terminate(current);
    assert.equal(result.rows[0].terminated, true);
    assert.equal((await unrelated.query('SELECT 42 AS answer')).rows[0].answer, 42);
    for (let i = 0; i < 20 && !disconnected; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(disconnected, true);
  } finally { await Promise.allSettled([victim.end(), unrelated.end(), observer.end()]); }
});
