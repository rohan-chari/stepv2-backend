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
let commandDraws = 0;
const originalRandom = Math.random;
Math.random = () => { commandDraws += 1; return 0.375; };
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
Math.random = originalRandom;
const HEADERS = { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' };
const SELF = ['PROTEIN_SHAKE', 'TRAIL_MIX', 'RUNNERS_HIGH', 'STEALTH_MODE', 'COMPRESSION_SOCKS', 'MIRROR', 'UMBRELLA', 'DECOY', 'CAMPFIRE_REST'];
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
    // Still accepted (the old broad lock includes them), but never a Decoy candidate.
    forfeitedAt: i === 3 ? new Date() : null,
  } });
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
async function withParticipantLock(participant, run, table = 'race_participants') {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
    assert.ok(['race_participants', 'race_active_effects'].includes(table));
    await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [participant.id]);
    let released = false;
    const release = async () => { if (!released) { released = true; await client.query('ROLLBACK'); } };
    try { return await run({ pid, release, client }); } finally { await release(); }
  } finally { await client.end(); }
}
async function blockedQueries(pid) {
  return prisma.$queryRawUnsafe('SELECT query, wait_event_type FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', pid);
}
async function waitUntil(probe, timeout = 5000) {
  const until = performance.now() + timeout;
  do { const value = await probe(); if (value) return value; await delay(10); } while (performance.now() < until);
  return null;
}
async function probeUnrelatedLock(f, held, body) {
  return withParticipantLock(f.unrelated.participant, async ({ pid, release }) => {
    const started = performance.now();
    let responseAt;
    const pending = use(f, held, f.caster, body).then((result) => { responseAt = performance.now() - started; return result; });
    let commitMs = null;
    let blocked = [];
    // Observe committed authoritative state on a separate connection. HTTP may
    // still await inventory/projection work; it is deliberately a separate clock.
    await waitUntil(async () => {
      const row = await prisma.racePowerup.findUnique({ where: { id: held.id } });
      if (row.status === 'USED') { commitMs = performance.now() - started; return true; }
      blocked = await blockedQueries(pid);
      return blocked.length > 0;
    });
    if (commitMs === null) {
      assert.ok(blocked.length, 'request must either commit or demonstrably wait on the held row');
      await delay(500);
      const row = await prisma.racePowerup.findUnique({ where: { id: held.id } });
      if (row.status === 'USED') commitMs = performance.now() - started;
    }
    const committedWhileLocked = commitMs !== null;
    const releasedMs = performance.now() - started;
    await release();
    if (!committedWhileLocked) await waitUntil(async () => {
      const row = await prisma.racePowerup.findUnique({ where: { id: held.id } });
      if (row.status !== 'USED') return false;
      commitMs = performance.now() - started; return true;
    });
    const result = await pending;
    console.log('LOCK_BENCHMARK ' + JSON.stringify({ type: held.type, scenario: body?.scenario || 'direct',
      commitMs, responseMs: responseAt, releasedMs, committedWhileLocked, blockedQueries: blocked.map((r) => r.query) }));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return { result: result.body.result, committedWhileLocked };
  });
}
describe('Powerup participant lock scope — real HTTP and PostgreSQL', () => {
  before(async () => { server = await startServer(); });
  beforeEach(cleanDatabase);
  after(async () => { await server?.close(); });
  for (const type of SELF) it(`${type} commits while an unrelated accepted participant is locked`, { timeout: 30000 }, async () => {
    const f = await fixture();
    const held = await item(f, type);
    const observed = await probeUnrelatedLock(f, held, {});
    if (type === 'PROTEIN_SHAKE') assert.equal(observed.result.bonus, 1500);
    else if (type === 'TRAIL_MIX') { assert.equal(observed.result.uniqueTypes, 1); assert.ok(observed.result.bonus > 0); }
    else {
      const effects = await prisma.raceActiveEffect.findMany({ where: { powerupId: held.id } });
      assert.equal(effects.length, 1); assert.equal(effects[0].targetUserId, f.caster.user.id);
    }
    assert.equal(observed.committedWhileLocked, true, `${type} must not lock an unrelated participant before committing`);
  });
  for (const type of ['SHORTCUT', 'DETOUR_SIGN', 'SIGNAL_JAMMER']) {
    for (const chain of ['direct', 'mirror', 'decoy', 'decoy-mirror-socks']) it(`${type} ${chain} locks only its complete dependency set`, { timeout: 30000 }, async () => {
      const f = await fixture();
      let decoy; let mirror; let socks;
      if (chain.includes('decoy')) decoy = await defense(f, 'DECOY', f.target);
      if (chain === 'mirror') mirror = await defense(f, 'MIRROR', f.target);
      if (chain === 'decoy-mirror-socks') {
        mirror = await defense(f, 'MIRROR', f.redirect);
        socks = await defense(f, 'COMPRESSION_SOCKS', type === 'SIGNAL_JAMMER' ? f.redirect : f.caster);
      }
      const held = await item(f, type);
      const observed = await probeUnrelatedLock(f, held, { targetUserId: f.target.user.id });
      if (decoy) assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: decoy.id } })).status, 'EXPIRED');
      if (mirror) assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: mirror.id } })).status, type === 'SIGNAL_JAMMER' ? 'ACTIVE' : 'EXPIRED');
      if (socks) { assert.equal(observed.result.blockedBy, 'COMPRESSION_SOCKS'); assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, 'BLOCKED'); }
      assert.equal(observed.committedWhileLocked, true, `${type} ${chain} must not lock an unrelated participant before committing`);
    });
  }
  it('two concurrent attacks consume a shield once and apply the other attack', async () => {
    const f = await fixture();
    const socks = await defense(f, 'COMPRESSION_SOCKS', f.target);
    const attacks = await Promise.all([item(f, 'SHORTCUT'), item(f, 'SHORTCUT', f.redirect)]);
    const results = await Promise.all([use(f, attacks[0], f.caster, { targetUserId: f.target.user.id }),
      use(f, attacks[1], f.redirect, { targetUserId: f.target.user.id })]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.equal(results.filter((r) => r.body.result.blockedBy === 'COMPRESSION_SOCKS').length, 1);
    const applied = results.find((r) => !r.body.result.blocked);
    assert.ok(applied.body.result.stolen > 0);
    assert.equal((await prisma.raceParticipant.findUnique({ where: { id: f.target.participant.id } })).totalSteps, 10000 - applied.body.result.stolen);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, 'BLOCKED');
  });
  it('revalidates a Decoy that expires while acquiring the planned participant locks', async () => {
    const f = await fixture();
    const decoy = await defense(f, 'DECOY', f.target);
    const attack = await item(f, 'DETOUR_SIGN');
    await withParticipantLock(f.target.participant, async ({ pid, release }) => {
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id });
      try {
        assert.ok(await waitUntil(async () => (await blockedQueries(pid)).length), 'attack waits for involved participant');
        // Equivalent to the independent expiry writer: effect status can change
        // without owning the race fence while participant acquisition is waiting.
        await prisma.raceActiveEffect.update({ where: { id: decoy.id }, data: { status: 'EXPIRED' } });
      } finally { await release(); }
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.result.outcome, 'APPLIED');
      assert.equal(result.body.result.effect.targetUserId, f.target.user.id);
      assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, eventType: 'POWERUP_REDIRECTED' } }), 0);
      assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: attack.id } }), 1);
    });
  });
  it('revalidates race end after waiting on an involved participant', async () => {
    const f = await fixture(); const attack = await item(f, 'DETOUR_SIGN');
    const endsAt = new Date(Date.now() + 500);
    await prisma.race.update({ where: { id: f.race.id }, data: { endsAt } });
    await withParticipantLock(f.target.participant, async ({ pid, release }) => {
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id });
      try {
        assert.ok(await waitUntil(async () => (await blockedQueries(pid)).length));
        await waitUntil(async () => Date.now() > endsAt.getTime());
      } finally { await release(); }
      const result = await pending;
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.deepEqual(result.body, { error: 'Race has ended' });
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: attack.id } })).status, 'HELD');
      assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: attack.id } }), 0);
    });
  });
  it('revalidates target totals changed while participant acquisition waits', async () => {
    const f = await fixture(); const attack = await item(f, 'SHORTCUT');
    await withParticipantLock(f.target.participant, async ({ pid, release, client }) => {
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id });
      try {
        assert.ok(await waitUntil(async () => (await blockedQueries(pid)).length));
        // Commit the independent writer, rather than roll it back with the lock.
        await client.query('UPDATE race_participants SET total_steps = 0, bonus_steps = 0 WHERE id = $1', [f.target.participant.id]);
        await client.query('COMMIT');
      } finally { await release(); }
      const result = await pending;
      assert.equal(result.status, 400, JSON.stringify(result.body));
      assert.deepEqual(result.body, { error: 'Target has 0 steps. Nothing to steal' });
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: attack.id } })).status, 'HELD');
    });
  });
  it('reuses the Decoy random draw when a landing shield changes during acquisition', async () => {
    const f = await fixture();
    const decoy = await defense(f, 'DECOY', f.target);
    const socks = await defense(f, 'COMPRESSION_SOCKS', f.redirect);
    const attack = await item(f, 'DETOUR_SIGN');
    commandDraws = 0;
    await withParticipantLock(f.target.participant, async ({ pid, release }) => {
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id });
      try {
        assert.ok(await waitUntil(async () => (await blockedQueries(pid)).length));
        await prisma.raceActiveEffect.update({ where: { id: socks.id }, data: { status: 'EXPIRED' } });
      } finally { await release(); }
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.result.outcome, 'REDIRECTED');
      assert.equal(result.body.result.effect.targetUserId, f.redirect.user.id);
      assert.equal(commandDraws, 1, 'a replan must not redraw the Decoy outcome');
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: decoy.id } })).status, 'EXPIRED');
      assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, eventType: 'POWERUP_REDIRECTED' } }), 1);
    });
  });
  for (const type of ['DETOUR_SIGN', 'SIGNAL_JAMMER']) it(`${type} does not lock a validation-only expired effect`, async () => {
    const f = await fixture();
    const existing = await defense(f, type, f.target, new Date(Date.now() - 1000));
    const attack = await item(f, type);
    await withParticipantLock(existing, async ({ pid, release }) => {
      let settled = null;
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id }).then((result) => { settled = result; return result; });
      await waitUntil(async () => settled || (await blockedQueries(pid)).length);
      const settledWhileLocked = Boolean(settled);
      await release();
      const result = await pending;
      assert.equal(result.status, type === 'DETOUR_SIGN' ? 400 : 200, JSON.stringify(result.body));
      assert.equal(settledWhileLocked, true, 'validation-only rows must never become new expiry lock dependencies');
    }, 'race_active_effects');
  });
  it('Decoy fizzle does not lock unused Socks on its holder', async () => {
    const f = await fixture();
    await prisma.raceParticipant.update({ where: { id: f.redirect.participant.id }, data: { forfeitedAt: new Date() } });
    await defense(f, 'DECOY', f.target);
    const socks = await defense(f, 'COMPRESSION_SOCKS', f.target);
    const attack = await item(f, 'SHORTCUT');
    await withParticipantLock(socks, async ({ pid, release }) => {
      let settled = null;
      const pending = use(f, attack, f.caster, { targetUserId: f.target.user.id }).then((result) => { settled = result; return result; });
      await waitUntil(async () => settled || (await blockedQueries(pid)).length);
      const settledWhileLocked = Boolean(settled);
      await release();
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.result.blockedBy, 'DECOY');
      assert.equal(settledWhileLocked, true, 'fizzle never consumes Socks');
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: socks.id } })).status, 'ACTIVE');
    }, 'race_active_effects');
  });
  it('duplicate simultaneous use consumes and awards only once', async () => {
    const f = await fixture(); const held = await item(f, 'PROTEIN_SHAKE');
    const results = await Promise.all([use(f, held), use(f, held)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const rejected = results.find((r) => r.status === 400);
    assert.equal(rejected.body.error, 'This powerup has already been used or discarded');
    assert.equal((await prisma.raceParticipant.findUnique({ where: { id: f.caster.participant.id } })).bonusSteps, 11500);
    assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, powerupType: 'PROTEIN_SHAKE', eventType: 'POWERUP_USED' } }), 1);
  });
  for (const type of ['PROTEIN_SHAKE', 'TRAIL_MIX', 'SHORTCUT']) it(`${type} preserves jam rejection and allows use after jam expiry`, async () => {
    const f = await fixture(); const held = await item(f, type);
    const jam = await defense(f, 'POWER_OUTAGE', f.caster);
    const body = type === 'SHORTCUT' ? { targetUserId: f.target.user.id } : {};
    const rejected = await use(f, held, f.caster, body);
    assert.equal(rejected.status, 409); assert.match(rejected.body.error, /jammed/);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: held.id } })).status, 'HELD');
    await prisma.raceActiveEffect.update({ where: { id: jam.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await use(f, held, f.caster, body)).status, 200);
  });
});
