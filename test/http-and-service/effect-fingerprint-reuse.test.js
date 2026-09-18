process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
const assert = require('node:assert/strict');
const { it, before, beforeEach } = require('node:test');
const { randomUUID } = require('node:crypto');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
const { reads } = require('./fixtures/observe-event-fingerprint.cjs');
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
const { RaceResolutionJobV2 } = require('../../src/modules/races/models/raceResolutionJobV2');
let baseUrl;
before(async () => { baseUrl = (await getSharedServer()).baseUrl; });
beforeEach(async () => { await cleanDatabase(); reads.length = 0; });
const oldHeaders = { 'X-Timezone': 'UTC', 'X-Client-Features': '' };
const fullReads = list => list.flatMap(r => r.statements || []).filter(s => s.sql.includes('AS "leechCheckpoint"') && s.sql.includes('FROM race_active_effects')).length;
async function fixture(kind = 'none') {
  const now = Date.now(), users = [];
  for (let i = 0; i < 3; i++) users.push(await createTestUser());
  const race = await prisma.race.create({ data: {
    creatorId: users[0].user.id, name: 'Effect proof integration', status: 'ACTIVE', targetSteps: 100000,
    isTeamRace: kind === 'team', teamSize: kind === 'team' ? 2 : null,
    powerupsEnabled: true, timezone: 'UTC', startedAt: new Date(now - 7200000), endsAt: new Date(now + 86400000),
  } });
  const parts = [];
  for (const user of users) parts.push(await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.user.id, status: 'ACCEPTED',
    team: kind === 'team' ? (parts.length < 2 ? 'TEAM_A' : 'TEAM_B') : null, joinedAt: race.startedAt,
  } }));
  const f = { now, users, race, parts };
  if (!['none', 'team'].includes(kind)) f.effect = await addEffect(f, kind);
  await prisma.globalStepEventBoundaryCursor.upsert({ where: { key: 'global' },
    create: { key: 'global', boundaryAt: new Date(now), eventId: 'zz', boundaryKind: 'END' },
    update: { boundaryAt: new Date(now), eventId: 'zz', boundaryKind: 'END' } });
  return f;
}
async function addEffect(f, kind = 'RUNNERS_HIGH', extra = {}) {
  const powerup = await prisma.racePowerup.create({ data: {
    raceId: f.race.id, participantId: f.parts[0].id, userId: f.users[0].user.id, type: kind, status: 'USED',
  } });
  return prisma.raceActiveEffect.create({ data: {
    raceId: f.race.id, targetParticipantId: f.parts[0].id, targetUserId: f.users[0].user.id,
    sourceUserId: f.users[0].user.id, powerupId: powerup.id, type: kind, status: 'ACTIVE',
    startsAt: f.race.startedAt, expiresAt: new Date(f.now + 3600000), ...extra,
  } });
}
async function sync(f, steps = 100) {
  const response = await request(baseUrl, 'POST', '/steps/sync-v2', {
    token: f.users[0].token, headers: { ...oldHeaders, 'Idempotency-Key': randomUUID() },
    body: { date: new Date(f.now).toISOString().slice(0, 10), steps, samples: [{
      periodStart: new Date(f.now - 3600000).toISOString(), periodEnd: new Date(f.now - 1800000).toISOString(), steps,
    }] },
  });
  assert.equal(response.status, 202);
}
async function resolve(f, mutation) {
  const logs = []; let mutated = false;
  reads.length = 0;
  assert.equal(await buildRaceResolutionWorkerV2({ bootAt: 0,
    logger: { log: s => { try { logs.push(JSON.parse(s)); } catch {} }, warn() {}, error: console.error },
    beforeWriteTransaction: mutation ? async () => { if (!mutated) { mutated = true; await mutation(); } } : undefined,
  }).tick(), 1);
  const observations = [...reads];
  const persisted = (await prisma.raceParticipant.findUniqueOrThrow({ where: { id: f.parts[0].id } })).totalSteps;
  const view = await request(baseUrl, 'GET', `/races/${f.race.id}/progress`, { token: f.users[0].token, headers: oldHeaders });
  assert.equal(view.status, 200);
  const body = await view.json();
  assert.equal(body.progress.participants.find(p => p.userId === f.users[0].user.id).totalSteps, persisted);
  return { observations, persisted, done: logs.find(r => r.event === 'race_resolution_v2') };
}
async function proof(f) {
  return (await prisma.$queryRawUnsafe('SELECT incarnation::text, revision::text FROM race_effect_fingerprint_versions WHERE race_id=$1', f.race.id))[0];
}
function rejected(result) {
  assert.ok(result.done.closureFenceRejections + result.done.sourceInputFenceRejections >= 1);
}
for (const [kind, expected] of [['none', 100], ['RUNNERS_HIGH', 200], ['RAINSTORM', 50], ['team', 100]]) {
  it(`old client HTTP sync uses one full effect read (${kind})`, async t => {
    const f = await fixture(kind); await sync(f);
    const result = await resolve(f);
    assert.equal(result.persisted, expected);
    assert.equal(fullReads(result.observations), 1);
    assert.equal(result.observations.length, 2, 'one original planning capture and one final fence');
    if (kind === 'team') {
      assert.equal(
        result.done.computePhaseQueryCount.activeEffects,
        0,
        'team FULL compute must reuse the coherent planning effect snapshot',
      );
      assert.equal(
        result.done.computePhaseQueryCount.raceLoad,
        0,
        'team FULL compute must reuse the coherent planning race snapshot',
      );
    }
    t.diagnostic(JSON.stringify({ kind, plan: result.done.resolutionPlan, fullEffectReads: fullReads(result.observations), rows: result.observations.map(r => r.value.scoringEffects.length) }));
  });
}

it('team FULL with committed STEP_SYNC uses the complete planning snapshot', async () => {
  const f = await fixture('team');
  await sync(f);
  const job = await RaceResolutionJobV2.findByRaceId(f.race.id);
  await prisma.raceResolutionJobV2.update({ where: { id: job.id }, data: {
    dirtyReasons: ['STEP_SYNC'],
    dirtyParticipantIds: [f.parts[0].id],
    dirtyPowerupTypes: [],
    triggeredByUserIds: [f.users[0].user.id],
  } });
  const result = await resolve(f);
  assert.equal(result.done.resolutionPlan, 'FULL');
  assert.equal(result.done.computePhaseQueryCount.raceLoad, 0);
  assert.equal(result.done.computePhaseQueryCount.activeEffects, 0);
});
for (const action of ['insert', 'update', 'delete', 'missing proof', 'replace proof', 'rollback']) {
  it(`final fence handles ${action} after planning`, async () => {
    const f = await fixture(action === 'insert' ? 'none' : 'RUNNERS_HIGH'); await sync(f);
    const result = await resolve(f, async () => {
      if (action === 'insert') await addEffect(f);
      if (action === 'update') await prisma.raceActiveEffect.update({ where: { id: f.effect.id }, data: { type: 'RAINSTORM' } });
      if (action === 'delete') await prisma.raceActiveEffect.delete({ where: { id: f.effect.id } });
      if (action === 'missing proof' || action === 'replace proof') {
        await prisma.$executeRawUnsafe('DELETE FROM race_effect_fingerprint_versions WHERE race_id=$1', f.race.id);
        if (action === 'replace proof') await prisma.$executeRawUnsafe('INSERT INTO race_effect_fingerprint_versions (race_id) VALUES ($1)', f.race.id);
      }
      if (action === 'rollback') await assert.rejects(prisma.$transaction(async tx => {
        await tx.raceActiveEffect.update({ where: { id: f.effect.id }, data: { type: 'RAINSTORM' } });
        throw new Error('rollback effect mutation');
      }), /rollback effect mutation/);
    });
    assert.equal(result.persisted, action === 'update' ? 50 : action === 'delete' ? 100 : 200);
    if (['insert', 'update', 'delete'].includes(action)) rejected(result);
    const firstFence = result.observations.find(r => r.transaction);
    assert.equal(fullReads([firstFence]), action === 'rollback' ? 0 : 1);
  });
}
for (const action of ['insert', 'update', 'delete', 'wrong race_id']) {
  it(`final projection refreshes checkpoint ${action} without effect counter writes`, async () => {
    const f = await fixture('none');
    // Expired local modifier keeps this checkpoint in the canonical fingerprint
    // without asking the worker's Leech materializer to settle a synthetic link.
    f.effect = await addEffect(f, 'RUNNERS_HIGH', { status: 'EXPIRED', expiresAt: new Date(f.now - 900000) });
    const insert = () => prisma.$executeRawUnsafe(`INSERT INTO leech_expiry_checkpoints
      (effect_id,kind,race_id,target_participant_id,target_user_id,expires_at,bonus_steps)
      VALUES ($1,'bonus',$2,$3,$4,$5,0)`, f.effect.id, f.race.id, f.parts[0].id, f.users[0].user.id, f.effect.expiresAt);
    if (action !== 'insert') await insert();
    await sync(f); const before = await proof(f);
    const result = await resolve(f, async () => {
      if (action === 'insert') await insert();
      if (action === 'update') await prisma.$executeRawUnsafe('UPDATE leech_expiry_checkpoints SET bonus_steps=23 WHERE effect_id=$1', f.effect.id);
      if (action === 'delete') await prisma.$executeRawUnsafe('DELETE FROM leech_expiry_checkpoints WHERE effect_id=$1', f.effect.id);
      if (action === 'wrong race_id') await prisma.$executeRawUnsafe("UPDATE leech_expiry_checkpoints SET race_id='deliberately-mismatched-race' WHERE effect_id=$1", f.effect.id);
      assert.deepEqual(await proof(f), before, 'checkpoint changes add zero effect proof writes');
    });
    assert.equal(result.persisted, 200);
    rejected(result);
    assert.equal(fullReads([result.observations.find(r => r.transaction)]), 0, 'fresh checkpoints must invalidate without full effects reload');
  });
}
it('bulk mutations write one proof version per race, no-op and step sync write none; moving effects invalidates both races', async () => {
  const f = await fixture('RUNNERS_HIGH'), other = await fixture('none');
  await addEffect(f); const before = await proof(f);
  await prisma.$executeRawUnsafe('UPDATE race_active_effects SET metadata=metadata WHERE race_id=$1', f.race.id);
  assert.deepEqual(await proof(f), before);
  await sync(f); assert.deepEqual(await proof(f), before);
  await prisma.$executeRawUnsafe("UPDATE race_active_effects SET metadata='{}'::jsonb WHERE race_id=$1", f.race.id);
  assert.equal(BigInt((await proof(f)).revision), BigInt(before.revision) + 1n);
  const first = await proof(f), second = await proof(other);
  await prisma.$executeRawUnsafe('UPDATE race_active_effects SET race_id=$2 WHERE id=$1', f.effect.id, other.race.id);
  assert.equal(BigInt((await proof(f)).revision), BigInt(first.revision) + 1n);
  assert.equal(BigInt((await proof(other)).revision), BigInt(second.revision) + 1n);
  assert.equal((await resolve(f)).persisted, 200);
});

it('caller mutation cannot alter privately retained effect rows, dates, or checkpoint metadata', async () => {
  const f = await fixture('RUNNERS_HIGH'); await sync(f);
  const result = await resolve(f, async () => {
    const effect = reads.find(r => !r.transaction).value.scoringEffects[0];
    effect.type = 'RAINSTORM'; effect.metadata = { leechFinalV1: { total: 999999 } };
    effect.startsAt.setTime(0); effect.expiresAt.setTime(0);
  });
  assert.equal(result.persisted, 200);
  assert.equal(fullReads(result.observations), 1);
  const final = result.observations.find(r => r.transaction).value.scoringEffects[0];
  assert.equal(final.type, 'RUNNERS_HIGH'); assert.equal(final.startsAt.getTime(), f.effect.startsAt.getTime());
  assert.deepEqual(final.metadata, f.effect.metadata);
});
it('oversized effect metadata opts out without truncating canonical score inputs', async () => {
  const f = await fixture('RUNNERS_HIGH');
  await prisma.raceActiveEffect.update({ where: { id: f.effect.id }, data: { metadata: { audit: 'x'.repeat(2 * 1024 * 1024) } } });
  await sync(f); const result = await resolve(f);
  assert.equal(result.persisted, 200); assert.equal(fullReads(result.observations), 2);
});
it('expiry clock boundary changes checkpoint visibility without any database mutation', async () => {
  const f = await fixture('RUNNERS_HIGH');
  const boundary = Date.now() + 1500;
  await prisma.raceActiveEffect.update({ where: { id: f.effect.id }, data: { expiresAt: new Date(boundary) } });
  await prisma.$executeRawUnsafe(`INSERT INTO leech_expiry_checkpoints
    (effect_id,kind,race_id,target_participant_id,target_user_id,expires_at,bonus_steps)
    VALUES ($1,'bonus',$2,$3,$4,$5,7)`, f.effect.id, f.race.id, f.parts[0].id, f.users[0].user.id, new Date(boundary));
  await sync(f); const version = await proof(f);
  const result = await resolve(f, async () => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, boundary - Date.now() + 20)));
    assert.deepEqual(await proof(f), version);
  });
  assert.equal(result.persisted, 200);
  const plan = result.observations.find(r => !r.transaction), final = result.observations.find(r => r.transaction);
  assert.equal(plan.value.scoringEffects[0].leechCheckpoint, null);
  assert.equal(final.value.scoringEffects[0].leechCheckpoint.bonus.bonus_steps, 7);
  assert.equal(fullReads([final]), 1, 'boundary is not admitted as an unchanged attempt');
  rejected(result);
});
it('race end change invalidates the snapshot context even with unchanged effect revision', async () => {
  const f = await fixture('RUNNERS_HIGH'); await sync(f); const version = await proof(f);
  const result = await resolve(f, async () => {
    await prisma.race.update({ where: { id: f.race.id }, data: { endsAt: new Date(f.now + 43200000) } });
    assert.deepEqual(await proof(f), version);
  });
  assert.equal(result.persisted, 200); rejected(result);
  assert.equal(fullReads([result.observations.find(r => r.transaction)]), 1);
});
it('effect truncation invalidates the proof and canonical fence before scores commit', async () => {
  const f = await fixture('RUNNERS_HIGH'); await sync(f); const version = await proof(f);
  const result = await resolve(f, async () => {
    await prisma.$executeRawUnsafe('TRUNCATE race_active_effects CASCADE');
    assert.equal(BigInt((await proof(f)).revision), BigInt(version.revision) + 1n);
  });
  assert.equal(result.persisted, 100); rejected(result);
});
it('race deletion cascades its effect proof and recreating the ID gets a new incarnation', async () => {
  const f = await fixture('RUNNERS_HIGH'), before = await proof(f);
  await prisma.race.delete({ where: { id: f.race.id } });
  assert.equal(await proof(f), undefined);
  await prisma.race.create({ data: {
    id: f.race.id, creatorId: f.users[0].user.id, name: 'Recreated race', status: 'ACTIVE', targetSteps: 100000,
    powerupsEnabled: true, timezone: 'UTC', startedAt: f.race.startedAt, endsAt: f.race.endsAt,
  } });
  f.parts[0] = await prisma.raceParticipant.create({ data: { raceId: f.race.id, userId: f.users[0].user.id, status: 'ACCEPTED', joinedAt: f.race.startedAt } });
  assert.notEqual((await proof(f)).incarnation, before.incarnation);
  await sync(f); assert.equal((await resolve(f)).persisted, 100);
});
it('private checkpoint eligibility cannot be changed through public effect expiry mutation', async () => {
  const f = await fixture('LEECH'); await sync(f);
  const result = await resolve(f, async () => {
    const plan = reads.find(r => !r.transaction);
    assert.equal(plan.value.scoringEffects[0].leechCheckpoint, null);
    plan.value.scoringEffects[0].expiresAt.setTime(0);
    plan.value.scoringEffects[0].metadata = {};
  });
  assert.equal(result.persisted, 100);
  assert.equal(fullReads(result.observations), 1);
  assert.equal(result.observations.find(r => r.transaction).value.scoringEffects[0].leechCheckpoint, null);
});
it('active Leech checkpoint writes and a newer HTTP sync retain effect proof while generation fence rejects stale score', async () => {
  const f = await fixture('LEECH'); await sync(f); const version = await proof(f);
  const result = await resolve(f, async () => {
    await sync(f, 120);
    await prisma.$executeRawUnsafe('UPDATE leech_expiry_checkpoints SET bonus_steps=17 WHERE effect_id=$1', f.effect.id);
    assert.deepEqual(await proof(f), version);
  });
  assert.equal(result.persisted, 120); rejected(result);
  assert.equal(fullReads([result.observations.find(r => r.transaction)]), 0);
});
it('checkpoint projection matches canonical SQL at exact expiry equality and appears only once in the roster response', async () => {
  const f = await fixture('none');
  f.effect = await addEffect(f, 'RUNNERS_HIGH', { status: 'EXPIRED', expiresAt: new Date(f.now - 900000) });
  await prisma.$executeRawUnsafe(`INSERT INTO leech_expiry_checkpoints
    (effect_id,kind,race_id,target_participant_id,target_user_id,expires_at,bonus_steps)
    VALUES ($1,'bonus',$2,$3,$4,$5,9)`, f.effect.id, f.race.id, f.parts[0].id, f.users[0].user.id, f.effect.expiresAt);
  await sync(f); const result = await resolve(f); assert.equal(result.persisted, 200);
  const full = result.observations.flatMap(r => r.statements).find(s => s.sql.includes('/* effect-fingerprint:full */'));
  const projected = result.observations.find(r => r.transaction).statements.find(s => s.sql.includes('effect_checkpoints AS MATERIALIZED'));
  const canonicalRows = await prisma.$queryRawUnsafe(full.sql, ...full.params.slice(0, 2), f.effect.expiresAt);
  const rosterRows = await prisma.$queryRawUnsafe(projected.sql, ...projected.params.slice(0, 2), f.effect.expiresAt);
  assert.deepEqual(rosterRows[0].ef_checkpoints[f.effect.id], canonicalRows[0].leechCheckpoint);
  assert.equal(rosterRows[0].ef_checkpoints[f.effect.id].bonus.bonus_steps, 9);
  assert.ok(rosterRows.slice(1).every(row => row.ef_checkpoints === null));
});
it('missing proof at planning keeps canonical reads through HTTP scoring', async () => {
  const f = await fixture('RUNNERS_HIGH');
  await prisma.$executeRawUnsafe('DELETE FROM race_effect_fingerprint_versions WHERE race_id=$1', f.race.id);
  await sync(f); const result = await resolve(f);
  assert.equal(result.persisted, 200); assert.equal(fullReads(result.observations), 2);
});
it('concurrent old SQL writers serialize proof publication and rollback adds no committed revision', async () => {
  const f = await fixture('RUNNERS_HIGH');
  const other = await addEffect(f, 'RAINSTORM');
  const initial = await proof(f);
  const { Client } = require('pg');
  const a = new Client({ connectionString: process.env.DATABASE_URL });
  const b = new Client({ connectionString: process.env.DATABASE_URL });
  await Promise.all([a.connect(), b.connect()]);
  let pending;
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    await a.query("UPDATE race_active_effects SET metadata='{}'::jsonb WHERE id=$1", [f.effect.id]);
    const { rows: [{ pid }] } = await a.query('SELECT pg_backend_pid() AS pid');
    pending = b.query("UPDATE race_active_effects SET metadata='{}'::jsonb WHERE id=$1", [other.id]);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      const waiting = await prisma.$queryRawUnsafe('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1', pid);
      if (waiting.length) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(blocked, 'second effect writer waits for the transactional race proof');
    assert.deepEqual(await proof(f), initial, 'uncommitted counter is invisible to readers');
    await a.query('ROLLBACK'); await pending; await b.query('COMMIT');
    assert.equal(BigInt((await proof(f)).revision), BigInt(initial.revision) + 1n);
    await sync(f); assert.equal((await resolve(f)).persisted, 100);
  } finally {
    await a.query('ROLLBACK'); await pending; await b.query('ROLLBACK');
    await Promise.all([a.end(), b.end()]);
  }
});
it('bulk effect insert and delete each increment once per race statement', async () => {
  const f = await fixture('none'), initial = await proof(f);
  const powerups = [randomUUID(), randomUUID()];
  await prisma.racePowerup.createMany({ data: powerups.map(id => ({ id, raceId: f.race.id,
    participantId: f.parts[0].id, userId: f.users[0].user.id, type: 'RUNNERS_HIGH', status: 'USED' })) });
  await prisma.raceActiveEffect.createMany({ data: powerups.map(powerupId => ({ raceId: f.race.id,
    targetParticipantId: f.parts[0].id, targetUserId: f.users[0].user.id, sourceUserId: f.users[0].user.id,
    powerupId, type: 'RUNNERS_HIGH', status: 'ACTIVE', startsAt: f.race.startedAt, expiresAt: new Date(f.now + 3600000),
  })) });
  assert.equal(BigInt((await proof(f)).revision), BigInt(initial.revision) + 1n);
  await prisma.raceActiveEffect.deleteMany({ where: { raceId: f.race.id } });
  assert.equal(BigInt((await proof(f)).revision), BigInt(initial.revision) + 2n);
  await sync(f); assert.equal((await resolve(f)).persisted, 100);
});
