// SQL protocol research only: this is not an application integration test or
// performance benchmark. NOWAIT establishes conflicts without artificial delay.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
// pg connection-string query parameters can override the URL hostname.
assert.equal(url.search, '');
assert.equal(url.hash, '');
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.equal(url.port, '5432');
assert.equal(url.pathname, '/steps_race_locks_research_test');
const clients = [];
const evidence = [];
async function client() {
  const c = new Client({ connectionString: url.toString() });
  await c.connect(); clients.push(c); return c;
}
async function blocked(c, sql, name) {
  await assert.rejects(c.query(sql), e => e.code === '55P03');
  evidence.push({ name, result: 'blocked', sqlstate: '55P03' });
  await c.query('ROLLBACK');
}
async function guards(c, mode) {
  await c.query(`SELECT id FROM lock_probe.jobs WHERE id=1 FOR ${mode} NOWAIT`);
  await c.query(`SELECT id FROM lock_probe.races WHERE id=1 FOR ${mode} NOWAIT`);
}
async function main() {
  let a;
  let createdSchema = false;
  try {
    a = await client();
    const b = await client(), c = await client();
    await a.query('CREATE SCHEMA lock_probe');
    createdSchema = true;
    await a.query(`CREATE TABLE lock_probe.jobs(id int PRIMARY KEY, generation int DEFAULT 0);
      CREATE TABLE lock_probe.races(id int PRIMARY KEY, status text DEFAULT 'active');
      CREATE TABLE lock_probe.players(id int PRIMARY KEY, total int DEFAULT 1000);
      INSERT INTO lock_probe.jobs(id) VALUES(1);
      INSERT INTO lock_probe.races(id) VALUES(1);
      INSERT INTO lock_probe.players(id) VALUES(1),(2),(3),(4);`);
    await a.query('BEGIN'); await guards(a, 'UPDATE');
    await a.query('SELECT id FROM lock_probe.players WHERE id IN (1,2) FOR UPDATE');
    await b.query('BEGIN');
    await blocked(b, 'SELECT id FROM lock_probe.jobs WHERE id=1 FOR UPDATE NOWAIT', 'current race guard serializes disjoint uses');
    await a.query('ROLLBACK');

    await a.query('BEGIN'); await guards(a, 'SHARE');
    await a.query('SELECT id FROM lock_probe.players WHERE id IN (1,2) ORDER BY id FOR UPDATE');
    await b.query('BEGIN'); await guards(b, 'SHARE');
    await b.query('SELECT id FROM lock_probe.players WHERE id IN (3,4) ORDER BY id FOR UPDATE NOWAIT');
    evidence.push({ name: 'shared guards admit both disjoint player sets concurrently', result: 'granted' });
    await c.query('BEGIN');
    await blocked(c, 'SELECT id FROM lock_probe.jobs WHERE id=1 FOR UPDATE NOWAIT', 'exclusive scoring/outage guard waits for local uses');
    await c.query('BEGIN'); await guards(c, 'SHARE');
    await blocked(c, 'SELECT id FROM lock_probe.players WHERE id=2 FOR UPDATE NOWAIT', 'overlapping target still waits');
    await c.query('BEGIN');
    await blocked(c, 'SELECT id FROM lock_probe.races WHERE id=1 FOR NO KEY UPDATE NOWAIT', 'shared lifecycle guard blocks non-key status updates');
    await blocked(b, 'SELECT id FROM lock_probe.jobs WHERE id=1 FOR UPDATE NOWAIT', 'upgrading a shared guard is not a concurrency escape');
    await a.query('ROLLBACK');

    await a.query('BEGIN');
    await a.query('SELECT id FROM lock_probe.jobs WHERE id=1 FOR KEY SHARE');
    await b.query('BEGIN');
    await b.query('SELECT id FROM lock_probe.jobs WHERE id=1 FOR NO KEY UPDATE NOWAIT');
    evidence.push({ name: 'KEY SHARE permits a non-key writer and is too weak as the general guard', result: 'granted' });
    await a.query('ROLLBACK'); await b.query('ROLLBACK');
    console.log(JSON.stringify({ kind: 'SQL semantics, not gameplay or speed proof', checks: evidence.length, evidence }, null, 2));
  } finally {
    for (const connection of clients) await connection.query('ROLLBACK').catch(() => {});
    if (createdSchema) await a.query('DROP SCHEMA lock_probe CASCADE');
    await Promise.all(clients.map(connection => connection.end()));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
