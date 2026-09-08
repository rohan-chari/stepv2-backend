const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { describe, it, before, beforeEach, after } = require('node:test');
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
// Observe the command's captured RNG without injecting collaborators or bypassing
// its transaction. Restore the global immediately after the real app loads.
const originalRandom = Math.random;
Math.random = () => 0.375;
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
Math.random = originalRandom;
const HEADERS = { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' };
let server;
let earned = 0;
async function fixture() {
  const players = [];
  for (const displayName of ['Caster', 'Target', 'Redirect', 'Unrelated']) players.push(await createTestUser({ displayName }));
  const race = await prisma.race.create({ data: { creatorId: players[0].user.id, name: 'Participant lock regression', status: 'ACTIVE',
    timeBased: true, maxDurationDays: 7, targetSteps: 1000000, powerupsEnabled: true,
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 7 * 86400000), timezone: 'UTC' } });
  for (const [i, p] of players.entries()) p.participant = await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: p.user.id, status: 'ACCEPTED', totalSteps: 10000, bonusSteps: 10000,
    nextBoxAtSteps: 900000, joinedAt: new Date(Date.now() - (4 - i) * 60000),
    // All four runners remain eligible for independent attacks.
    forfeitedAt: null,
  } });
  await prisma.$executeRawUnsafe(`INSERT INTO race_resolution_jobs_v2
    (id, race_id, generation, state, requested_at, completed_at, last_completed_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, $1, 0, 'succeeded', NOW(), NOW(), NOW(), NOW(), NOW())`, race.id);
  return { race, players, caster: players[0], target: players[1], redirect: players[2], unrelated: players[3] };
}
async function item(f, type, player = f.caster) {
  return prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: player.participant.id,
    userId: player.user.id, type, rarity: 'RARE', status: 'HELD', earnedAtSteps: ++earned } });
}
async function defense(f, type, player, expiresAt = new Date(Date.now() + 3600000)) {
  const powerup = await item(f, type, player);
  await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: 'USED' } });
  return prisma.raceActiveEffect.create({ data: { raceId: f.race.id, targetParticipantId: player.participant.id,
    targetUserId: player.user.id, sourceUserId: player.user.id, powerupId: powerup.id, type,
    status: 'ACTIVE', startsAt: new Date(Date.now() - 60000), expiresAt } });
}
async function use(f, held, player = f.caster, body = {}) {
  const response = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${held.id}/use`, {
    token: player.token, headers: HEADERS, body,
  });
  return { status: response.status, body: await response.json() };
}
async function waitUntil(probe, timeout = 5000) {
  const until = performance.now() + timeout;
  do { const value = await probe(); if (value) return value; await delay(10); } while (performance.now() < until);
  return null;
}
// Test-only database trigger pauses a REAL command just before item consumption,
// after it has acquired its gameplay locks and applied transactional writes.
// No production hooks, mocked handlers or artificial performance delays.
async function pair(f, first, second, { conflict = false } = {}) {
  const control = new Client({ connectionString: process.env.DATABASE_URL });
  await control.connect();
  const pending = [];
  let observation;
  try {
    await control.query(`CREATE OR REPLACE FUNCTION test_pause_powerup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${first.held.id}' AND NEW.status::text = 'used' THEN
          PERFORM pg_advisory_xact_lock(927401);
        END IF;
        RETURN NEW;
      END $$`);
    await control.query('CREATE TRIGGER test_pause_powerup BEFORE UPDATE ON race_powerups FOR EACH ROW EXECUTE FUNCTION test_pause_powerup()');
    await control.query('SELECT pg_advisory_lock(927401)');
    const { rows: [{ pid }] } = await control.query('SELECT pg_backend_pid() AS pid');
    pending.push(use(f, first.held, first.player, first.body));
    const blockedFirst = await waitUntil(async () => {
      const { rows } = await control.query('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid]);
      return rows[0];
    });
    assert.ok(blockedFirst, 'first real HTTP transaction reaches the consumption barrier');
    pending.push(second.run ? second.run() : use(f, second.held, second.player, second.body));
    observation = await waitUntil(async () => {
      const row = await prisma.racePowerup.findUnique({ where: { id: second.held.id } });
      if (row.status === 'USED') return 'committed';
      const { rows } = await control.query('SELECT query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [blockedFirst.pid]);
      if (rows.length) {
        // The second transaction may have committed between the first item
        // read and this lock probe, then blocked in its post-commit enqueue.
        const fresh = await prisma.racePowerup.findUnique({ where: { id: second.held.id } });
        return fresh.status === 'USED' ? 'committed' : 'waiting';
      }
      return null;
    });
  } finally {
    await control.query('SELECT pg_advisory_unlock(927401)');
    // Await HTTP callbacks too: post-commit enqueue may legitimately wait for
    // the first race guard even after the second gameplay transaction commits.
    const results = await Promise.all(pending);
    await control.query('DROP TRIGGER IF EXISTS test_pause_powerup ON race_powerups');
    await control.query('DROP FUNCTION IF EXISTS test_pause_powerup()');
    await control.end();
    for (const [i, result] of results.entries()) assert.equal(result.status, [first, second][i].status || 200, JSON.stringify(result.body));
    if (results.length === 2) observation = { state: observation, results };
  }
  assert.equal(observation.state, conflict ? 'waiting' : 'committed',
    conflict ? 'shared dependencies must wait' : 'independent gameplay must commit before first transaction is released');
  return observation.results;
}

describe('Shared powerup race guards — real concurrent HTTP', () => {
  before(async () => { server = await startServer(); });
  beforeEach(cleanDatabase);
  after(async () => { await server?.close(); });
  for (const types of [['SHORTCUT', 'SHORTCUT'], ['PROTEIN_SHAKE', 'TRAIL_MIX'], ['COMPRESSION_SOCKS', 'MIRROR'], ['RUNNERS_HIGH', 'RUNNERS_HIGH'], ['DETOUR_SIGN', 'DETOUR_SIGN']]) {
    it(`${types.join(' / ')} on disjoint players overlaps gameplay commits`, { timeout: 30000 }, async () => {
      const f = await fixture();
      const first = await item(f, types[0]);
      const second = await item(f, types[1], f.redirect);
      const results = await pair(f,
        { held: first, player: f.caster, body: ['SHORTCUT', 'DETOUR_SIGN'].includes(types[0]) ? { targetUserId: f.target.user.id } : {} },
        { held: second, player: f.redirect, body: ['SHORTCUT', 'DETOUR_SIGN'].includes(types[1]) ? { targetUserId: f.unrelated.user.id } : {} });
      if (types[0] === 'SHORTCUT') {
        assert.ok(results.every(r => r.body.result.stolen > 0));
        const rows = await prisma.raceParticipant.findMany({ where: { raceId: f.race.id } });
        assert.equal(rows.reduce((sum, p) => sum + p.totalSteps, 0), 40000);
      } else if (types[0] === 'PROTEIN_SHAKE') {
        assert.equal(results[0].body.result.bonus, 1500);
        assert.equal(results[1].body.result.uniqueTypes, 1);
        for (const [i, p] of [f.caster, f.redirect].entries()) {
          const row = await prisma.raceParticipant.findUnique({ where: { id: p.participant.id } });
          assert.equal(row.bonusSteps, 10000 + results[i].body.result.bonus);
        }
      }
    });
  }
  it('two attacks serialize on one shield and only one is blocked', { timeout: 30000 }, async () => {
    const f = await fixture();
    const socks = await defense(f, 'COMPRESSION_SOCKS', f.target);
    const first = await item(f, 'SHORTCUT');
    const second = await item(f, 'SHORTCUT', f.redirect);
    const results = await pair(f,
      { held: first, player: f.caster, body: { targetUserId: f.target.user.id } },
      { held: second, player: f.redirect, body: { targetUserId: f.target.user.id } }, { conflict: true });
    assert.equal(results[0].body.result.blockedBy, 'COMPRESSION_SOCKS');
    assert.ok(results[1].body.result.stolen > 0);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, 'BLOCKED');
  });
  it('a Decoy redirect into the second attack target is a real conflict', { timeout: 30000 }, async () => {
    const f = await fixture();
    // Fixed RNG + stable joinedAt ordering chooses Redirect from the two legal
    // candidates (Redirect, Unrelated). The handler still resolves the real chain.
    await defense(f, 'DECOY', f.target);
    const first = await item(f, 'SHORTCUT');
    const second = await item(f, 'SHORTCUT', f.unrelated);
    const results = await pair(f,
      { held: first, player: f.caster, body: { targetUserId: f.target.user.id } },
      { held: second, player: f.unrelated, body: { targetUserId: f.redirect.user.id } }, { conflict: true });
    assert.equal(results[0].body.result.redirectedToUserId, f.redirect.user.id);
    assert.ok(results[1].body.result.stolen > 0);
  });
  for (const type of ['COMPRESSION_SOCKS', 'STEALTH_MODE', 'MIRROR', 'DECOY']) {
    it(`${type} activation winning the participant lock is revalidated by an attack`, { timeout: 30000 }, async () => {
      const f = await fixture();
      const shield = await item(f, type, f.target);
      const attack = await item(f, 'SHORTCUT');
      const results = await pair(f,
        { held: shield, player: f.target, body: {} },
        { held: attack, player: f.caster, body: { targetUserId: f.target.user.id }, status: type === 'STEALTH_MODE' ? 400 : 200 },
        { conflict: true });
      const result = results[1].body;
      if (type === 'STEALTH_MODE') {
        assert.equal(result.code, 'TARGET_STEALTHED');
        assert.equal((await prisma.racePowerup.findUnique({ where: { id: attack.id } })).status, 'HELD');
      } else if (type === 'COMPRESSION_SOCKS') assert.equal(result.result.blockedBy, type);
      else if (type === 'MIRROR') assert.equal(result.result.reflectedBy, type);
      else assert.equal(result.result.redirectedBy, type);
    });
  }
  it('exclusive Outage winning the race guard prevents the waiting Shortcut', { timeout: 30000 }, async () => {
    const f = await fixture();
    const outage = await item(f, 'POWER_OUTAGE');
    const attack = await item(f, 'SHORTCUT', f.target);
    const results = await pair(f,
      { held: outage, player: f.caster, body: {} },
      { held: attack, player: f.target, body: { targetUserId: f.redirect.user.id }, status: 409 },
      { conflict: true });
    assert.match(results[1].body.error, /jammed/);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: attack.id } })).status, 'HELD');
  });
  it('Shortcut commits before a waiting exclusive Outage', { timeout: 30000 }, async () => {
    const f = await fixture();
    const attack = await item(f, 'SHORTCUT');
    const outage = await item(f, 'POWER_OUTAGE', f.redirect);
    const results = await pair(f,
      { held: attack, player: f.caster, body: { targetUserId: f.target.user.id } },
      { held: outage, player: f.redirect, body: {} }, { conflict: true });
    assert.ok(results[0].body.result.stolen > 0);
    assert.ok(results[1].body.result.affected > 0);
  });
  it('missing coordination row falls back and preserves the old-client response', async () => {
    const f = await fixture(); const held = await item(f, 'PROTEIN_SHAKE');
    await prisma.$executeRawUnsafe('DELETE FROM race_resolution_jobs_v2 WHERE race_id = $1', f.race.id);
    const response = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${held.id}/use`,
      { token: f.caster.token, body: {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.bonus, 1500);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: held.id } })).status, 'USED');
  });

  for (const type of ['RUNNERS_HIGH', 'DETOUR_SIGN']) it(`${type} competing activations cannot stack`, { timeout: 30000 }, async () => {
    const f = await fixture();
    const first = await item(f, type);
    const secondActor = type === 'RUNNERS_HIGH' ? f.caster : f.redirect;
    const second = await item(f, type, secondActor);
    const body = type === 'DETOUR_SIGN' ? { targetUserId: f.target.user.id } : {};
    const results = await pair(f, { held: first, player: f.caster, body },
      { held: second, player: secondActor, body, status: 400 }, { conflict: true });
    assert.match(results[1].body.error, /already/);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: second.id } })).status, 'HELD');
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id, type, status: 'ACTIVE' } }), 1);
  });

  it('step sync queues its update after an in-flight shared powerup transaction', { timeout: 30000 }, async () => {
    const f = await fixture(); const held = await item(f, 'SHORTCUT');
    const unused = await item(f, 'PROTEIN_SHAKE', f.redirect);
    const results = await pair(f, { held, player: f.caster, body: { targetUserId: f.target.user.id } },
      { held: unused, status: 202, run: async () => {
        const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
          token: f.redirect.token, headers: { 'Idempotency-Key': require('node:crypto').randomUUID() },
          body: { date: new Date().toISOString().slice(0, 10), steps: 100, samples: [] },
        });
        return { status: response.status, body: await response.json() };
      } }, { conflict: true });
    const jobs = await prisma.$queryRawUnsafe('SELECT generation FROM race_resolution_jobs_v2 WHERE race_id = $1', f.race.id);
    assert.ok(Number(jobs[0].generation) >= 1);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: unused.id } })).status, 'HELD');
    const beforeWorker = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: f.race.id } });
    const beforeTotals = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.caster.participant.id } });
    // Spawn the real worker process; never import a scorer into this HTTP test.
    const workerMessage = await new Promise((resolve, reject) => {
      const env = { ...process.env, RACE_QUEUE_V2_QUIET_PERIOD_MS: '0' };
      delete env.NODE_TEST_CONTEXT;
      const child = require('node:child_process').fork(
        require('node:path').join(__dirname, '../../scripts/test-race-resolution-worker-once.js'), [],
        { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('worker did not finish')); }, 15000);
      let message;
      child.on('message', m => { message = m; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 && !message?.error
        ? resolve(message) : reject(new Error(message?.error || `worker exited ${code}`)); });
    });
    assert.ok(workerMessage.claimed, 'worker processes the public command/sync queue');
    const completed = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId: f.race.id } });
    assert.equal(completed.state, 'SUCCEEDED', JSON.stringify(completed));
    assert.ok(completed.committedGeneration >= beforeWorker.generation, 'worker commits the enqueued generation');
    assert.ok(completed.lastCompletedAt > beforeWorker.lastCompletedAt, 'completion advances after claim');
    const scored = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.caster.participant.id } });
    assert.ok(scored.totalsUpdatedAt && (!beforeTotals.totalsUpdatedAt || scored.totalsUpdatedAt > beforeTotals.totalsUpdatedAt),
      'worker actually persists scoring, not merely claims a job');
    const progressResponse = await request(server.baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.caster.token, headers: HEADERS });
    assert.equal(progressResponse.status, 200);
    const progress = (await progressResponse.json()).progress;
    const stolen = results[0].body.result.stolen;
    assert.equal(progress.participants.find(p => p.userId === f.caster.user.id).totalSteps, 10000 + stolen);
    assert.equal(progress.participants.find(p => p.userId === f.target.user.id).totalSteps, 10000 - stolen);
  });
  it('team forfeit waits for an in-flight shared powerup transaction', { timeout: 30000 }, async () => {
    const f = await fixture();
    await prisma.race.update({ where: { id: f.race.id }, data: { isTeamRace: true } });
    for (const [i, p] of f.players.entries()) await prisma.raceParticipant.update({
      where: { id: p.participant.id }, data: { team: i % 2 === 0 ? 'TEAM_A' : 'TEAM_B' },
    });
    const held = await item(f, 'SHORTCUT'); const unused = await item(f, 'PROTEIN_SHAKE', f.redirect);
    await pair(f, { held, player: f.caster, body: { targetUserId: f.target.user.id } },
      { held: unused, run: async () => {
        const response = await request(server.baseUrl, 'POST', `/races/${f.race.id}/forfeit`, { token: f.redirect.token, body: {} });
        return { status: response.status, body: await response.json() };
      } }, { conflict: true });
    assert.ok((await prisma.raceParticipant.findUnique({ where: { id: f.redirect.participant.id } })).forfeitedAt);
  });

});
