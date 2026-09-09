const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');

// Validate before importing the app or running any fixture writes.
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
let server;
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);
after(async () => { if (server) await server.close(); await prisma.$disconnect(); });

function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(check, message) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(message);
}
async function fixture() {
  const account = await createTestUser({ timezone: 'UTC' });
  const date = new Date().toISOString().slice(0, 10);
  const normalKey = randomUUID();
  const homeKey = randomUUID();
  // The observed production failure was locking an existing input-version row.
  await prisma.userScoringInputVersion.create({ data: { userId: account.user.id, generation: 1 } });
  const send = (home, idempotencyKey = home ? homeKey : normalKey, steps = home ? 200 : 100) =>
    request(server.baseUrl, 'POST', '/steps/sync-v2', {
      token: account.token,
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Timezone': 'UTC',
        'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5',
        ...(home ? { 'X-Step-Sync-Intent': 'home-pull' } : {}),
      },
      body: { date, steps, samples: [] },
    });
  return { account, date, normalKey, homeKey, send };
}
async function assertSuccessfulResponses(f, responses) {
  const bodies = await Promise.all(responses.map(r => r.json()));
  assert.deepEqual(responses.map(r => r.status), [202, 202],
    `both valid syncs must be accepted, not fail under contention: ${JSON.stringify(bodies)}`);
  assert.equal(bodies[0].record.steps, 100);
  assert.equal(bodies[1].record.steps, 200);
  assert.equal(bodies[0].record.userId, f.account.user.id);
  assert.equal(bodies[1].record.userId, f.account.user.id);
  // A successful same-key replay must survive the Home cooldown and return its
  // original committed response, without applying that older total again.
  for (let i = 0; i < 2; i++) {
    const replay = await f.send(i === 1);
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), bodies[i]);
  }
  const cooldown = await f.send(true, randomUUID(), 300);
  assert.equal(cooldown.status, 429);
  assert.equal((await cooldown.json()).code, 'STEP_SYNC_COOLDOWN');
  const saved = await prisma.step.findUnique({ where: {
    userId_date: { userId: f.account.user.id, date: new Date(f.date) },
  } });
  assert.equal(saved.steps, 200, 'replays and rejected cooldown must not overwrite the accepted Home total');
  const reservations = await prisma.stepSyncRequest.findMany({ where: { userId: f.account.user.id } });
  assert.equal(reservations.length, 2, 'rejected Home sync must roll back its reservation');
  assert.ok(reservations.every(r => r.state === 'COMPLETE'));
}

it('ordinary and Home sync retain their response, replay and cooldown contracts without overlap', async () => {
  const f = await fixture();
  await assertSuccessfulResponses(f, [await f.send(false), await f.send(true)]);
});

it('overlapping ordinary and Home HTTP syncs must both succeed without a lock-order deadlock',
  { timeout: 20000 }, async t => {
    const f = await fixture();
    const held = latch();
    const release = latch();
    const queryErrors = [];
    let normalPid, homePid, heldOnce = false;
    const original = Client.prototype.query;
    // Scheduling barrier only. Execute every original query with unchanged
    // SQL/parameters and return its real result/error. Delay the ordinary
    // response after PostgreSQL has actually granted its scoring-row lock.
    t.mock.method(Client.prototype, 'query', function (...args) {
      const config = args[0];
      const sql = typeof config === 'string' ? config : config?.text || '';
      const values = config?.values || args[1] || [];
      if (sql.includes('INSERT INTO') && sql.includes('step_sync_requests') && Array.isArray(values)) {
        if (values.includes(f.normalKey)) normalPid = this.processID;
        if (values.includes(f.homeKey)) homePid = this.processID;
      }
      const pause = !heldOnce && this.processID === normalPid &&
        sql.includes('WITH locked AS MATERIALIZED') && sql.includes('user_scoring_input_versions');
      if (pause) heldOnce = true;
      const result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') return result;
      return result.then(async value => {
        if (pause) { held.resolve(); await release.promise; }
        return value;
      }, error => { if (error.code === '40P01') queryErrors.push(error.code); throw error; });
    });
    const observer = new Client({ connectionString: target.toString() });
    await observer.connect();
    let normal, home;
    try {
      normal = f.send(false);
      await waitFor(() => heldOnce && normalPid, 'ordinary request must reach the scoring-lock statement');
      await Promise.race([held.promise, delay(5000).then(() => assert.fail('ordinary scoring lock was not granted'))]);
      home = f.send(true);
      // Wait for a REAL database wait, not an arbitrary sleep or a fabricated
      // DB error. This also works after a fix: Home can safely block on the
      // scoring row without holding the user row, or vice versa if ordinary
      // intake adopts a common user-first order.
      await waitFor(async () => {
        if (!homePid) return false;
        const result = await observer.query('SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked',
          [normalPid, homePid]);
        return result.rows[0].blocked;
      }, 'Home request must be waiting on the ordinary transaction before it resumes');
      release.resolve();
      const responses = await Promise.all([normal, home]);
      console.log(JSON.stringify({ experiment: 'overlapping home/ordinary HTTP sync',
        statuses: responses.map(r => r.status), postgresErrors: queryErrors }));
      await assertSuccessfulResponses(f, responses);
      assert.deepEqual(queryErrors, [], 'consistent lock order must avoid PostgreSQL deadlock detection');
    } finally {
      release.resolve();
      await Promise.allSettled([normal, home].filter(Boolean));
      await observer.end();
    }
  });
