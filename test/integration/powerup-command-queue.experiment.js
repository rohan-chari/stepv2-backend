const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { Client } = require('pg');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, 'localhost');
assert.equal(url.pathname, '/steps_powerup_queue_unit_test');
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
const { installQueueSchema, createPowerupCommandQueue } = require('../../scripts/experiments/powerup-command-comparison/queue');
let server, queue;
const headers = { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' };
before(async () => { await installQueueSchema(); });
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE experiment_powerup_commands, experiment_powerup_inboxes, experiment_powerup_admissions');
  await cleanDatabase();
  queue = createPowerupCommandQueue();
  server = await startServer({ usePowerup: (args) => queue.execute(args) });
});
after(async () => { await prisma.$disconnect(); });
let fixtureNumber = 0;
async function fixture(type = 'PROTEIN_SHAKE') {
  const number = ++fixtureNumber;
  const player = await createTestUser({ displayName: `Queue caster ${number}` });
  const other = await createTestUser({ displayName: `Other ${number}` });
  const race = await prisma.race.create({ data: { creatorId: player.user.id, name: 'Queue integration', status: 'ACTIVE', timeBased: true, maxDurationDays: 7, targetSteps: 1000000, powerupsEnabled: true, startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000), timezone: 'UTC' } });
  for (const p of [player, other]) p.participant = await prisma.raceParticipant.create({ data: { raceId: race.id, userId: p.user.id, status: 'ACCEPTED', totalSteps: 10000, bonusSteps: 10000, nextBoxAtSteps: 900000 } });
  const held = await prisma.racePowerup.create({ data: { raceId: race.id, participantId: player.participant.id, userId: player.user.id, type, rarity: 'RARE', status: 'HELD', earnedAtSteps: 1 } });
  return { player, other, race, held };
}
function post(f, body = {}) { return request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${f.held.id}/use`, { token: f.player.token, headers, body }); }
async function untilPending(count = 1) {
  for (let n = 0; n < 200; n++) {
    const [{ count: found }] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM experiment_powerup_commands WHERE state='pending'");
    if (found >= count) return;
    await delay(10);
  }
  assert.fail('HTTP requests did not enter durable inbox');
}
it('HTTP response waits for atomic use and replay returns the same terminal body', async () => {
  const f = await fixture(); const pending = post(f);
  await untilPending();
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
  await queue.tick(); const response = await pending; const body = await response.json();
  assert.equal(response.status, 200); assert.equal(typeof body.result.bonus, 'number');
  const replay = await post(f); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), body);
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'USED');
  assert.equal((await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM experiment_powerup_commands'))[0].count, 1);
  await server.close();
});
it('a gameplay inbox lock cannot stall same-race or other-race HTTP admission', async () => {
  const f = await fixture(); const g = await fixture();
  const second = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: f.other.participant.id, userId: f.other.user.id, type: 'PROTEIN_SHAKE', rarity: 'RARE', status: 'HELD', earnedAtSteps: 2 } });
  const first = post(f); await untilPending(); const lease = await queue.claim();
  const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  await client.query('BEGIN'); await client.query('SELECT race_id FROM experiment_powerup_inboxes WHERE race_id=$1 FOR UPDATE', [f.race.id]);
  const same = post({ ...f, player: f.other, held: second }); const other = post(g);
  let admitted = false;
  try {
    for (let n = 0; n < 100; n++) {
      const [{ count }] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM experiment_powerup_commands WHERE state='pending'");
      if (count === 2) { admitted = true; break; } await delay(10);
    }
  } finally { await client.query('ROLLBACK'); await client.end(); }
  await queue.runClaim(lease); for (let n = 0; n < 3; n++) await queue.tick();
  await Promise.all([first, same, other]); await server.close();
  assert.equal(admitted, true, 'short admission must remain independent of the gameplay ownership lock');
});
it('pending expires atomically after five seconds without consuming the item', async () => {
  const f = await fixture(); const pending = post(f); await untilPending();
  await delay(5050); await queue.tick();
  const response = await pending; assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Powerup service busy. Please try again.' });
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
  await server.close();
});
it('same in-flight request attaches and changed payload conflicts', async () => {
  const f = await fixture(); const first = post(f); await untilPending(); const second = post(f);
  const conflict = await post(f, { upgradeLevel: 1 }); assert.equal(conflict.status, 409);
  await queue.tick(); const a = await first; const b = await second;
  assert.equal(a.status, 200); assert.deepEqual(await a.json(), await b.json());
  await server.close();
});
it('a rejected HELD item permits a corrected command', async () => {
  const f = await fixture('SHORTCUT'); const bad = post(f); await untilPending(); await queue.tick();
  assert.equal((await bad).status, 400);
  const good = post(f, { targetUserId: f.other.user.id }); await untilPending(); await queue.tick();
  assert.equal((await good).status, 200);
  assert.equal((await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM experiment_powerup_commands'))[0].count, 2);
  await server.close();
});
it('a replaced lease rejects a resumed stale executor inside the gameplay fence', async () => {
  const f = await fixture(); const pending = post(f); await untilPending();
  const stale = await queue.claim();
  await prisma.$executeRawUnsafe("UPDATE experiment_powerup_inboxes SET lease_until=clock_timestamp()-interval '1 second'");
  const replacement = await queue.claim(); assert.notEqual(replacement.token, stale.token);
  await assert.rejects(queue.runClaim(stale), /lease/i);
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
  await queue.runClaim(replacement); assert.equal((await pending).status, 200);
  await server.close();
});
it('batch mode reuses race reads and bulk inserts feed consequences for ordered self buffs', async () => {
  queue = createPowerupCommandQueue({ mode: 'BATCH', batchSize: 4 });
  const f = await fixture('RUNNERS_HIGH'); const second = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: f.other.participant.id, userId: f.other.user.id, type: 'RUNNERS_HIGH', rarity: 'RARE', status: 'HELD', earnedAtSteps: 2 } });
  const a = post(f); const b = post({ ...f, player: f.other, held: second });
  await untilPending(2); await queue.tick();
  assert.equal((await a).status, 200); assert.equal((await b).status, 200);
  assert.ok(queue.metrics.sharedReads > 0, 'shared state must avoid an actual repeated read');
  assert.ok(queue.metrics.bulkFeedRows >= 2, 'consequence rows must actually be written together');
  assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id } }), 2);
  await server.close();
});
it('an unexpected SQL failure rolls back every effect and terminal result, then retries once', async () => {
  const f = await fixture('RUNNERS_HIGH');
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION experiment_reject_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'experiment terminal fault'; END $$`);
  await prisma.$executeRawUnsafe("CREATE TRIGGER experiment_reject_result BEFORE UPDATE OF body ON experiment_powerup_commands FOR EACH ROW WHEN (NEW.status=200) EXECUTE FUNCTION experiment_reject_result()");
  try {
    const pending = post(f); await untilPending(); await queue.tick();
    assert.match(queue.metrics.lastError, /experiment terminal fault/);
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.held.id } }), 0);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
    assert.equal((await prisma.$queryRawUnsafe('SELECT status FROM experiment_powerup_commands'))[0].status, null);
    await prisma.$executeRawUnsafe('DROP TRIGGER experiment_reject_result ON experiment_powerup_commands');
    await queue.tick(); assert.equal((await pending).status, 200);
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.held.id } }), 1);
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS experiment_reject_result ON experiment_powerup_commands'); }
  await server.close();
});
it('three failed execution attempts terminalize without consuming a poison item', async () => {
  const f = await fixture('RUNNERS_HIGH');
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION experiment_reject_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'experiment poison'; END $$`);
  await prisma.$executeRawUnsafe("CREATE TRIGGER experiment_reject_use BEFORE UPDATE OF status ON race_powerups FOR EACH ROW WHEN (NEW.status='used') EXECUTE FUNCTION experiment_reject_use()");
  try {
    const pending = post(f); await untilPending();
    for (let n = 0; n < 4; n++) await queue.tick();
    const response = await pending; assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error' });
    assert.equal(queue.metrics.retries, 3);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS experiment_reject_use ON race_powerups'); }
  await server.close();
});
it('ordered outage rejects the next caster attack and leaves the victim Socks intact', async () => {
  queue = createPowerupCommandQueue({ mode: 'BATCH', batchSize: 8 });
  const f = await fixture('COMPRESSION_SOCKS');
  const socks = post(f); await untilPending(); await queue.tick(); assert.equal((await socks).status, 200);
  const outage = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: f.player.participant.id, userId: f.player.user.id, type: 'POWER_OUTAGE', rarity: 'RARE', status: 'HELD', earnedAtSteps: 2 } });
  const attack = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: f.other.participant.id, userId: f.other.user.id, type: 'SHORTCUT', rarity: 'RARE', status: 'HELD', earnedAtSteps: 3 } });
  const first = post({ ...f, held: outage }); await untilPending();
  const second = post({ ...f, player: f.other, held: attack }, { targetUserId: f.player.user.id }); await untilPending(2);
  await queue.tick(); await queue.tick();
  assert.equal((await first).status, 200); const rejected = await second;
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'Your powerups are jammed for another 30m!' });
  assert.equal((await prisma.racePowerup.findUnique({ where: { id: attack.id } })).status, 'HELD');
  assert.equal((await prisma.raceActiveEffect.findFirst({ where: { powerupId: f.held.id } })).status, 'ACTIVE');
  await server.close();
});
it('one poison command does not roll a healthy peer into a terminal failure', async () => {
  queue = createPowerupCommandQueue({ mode: 'BATCH', batchSize: 4 });
  const f = await fixture('RUNNERS_HIGH');
  const poison = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: f.other.participant.id, userId: f.other.user.id, type: 'RUNNERS_HIGH', rarity: 'RARE', status: 'HELD', earnedAtSteps: 2 } });
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION experiment_reject_peer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${poison.id}' THEN RAISE EXCEPTION 'experiment poison peer'; END IF; RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe("CREATE TRIGGER experiment_reject_peer BEFORE UPDATE OF status ON race_powerups FOR EACH ROW WHEN (NEW.status='used') EXECUTE FUNCTION experiment_reject_peer()");
  try {
    const good = post(f); await untilPending(); const bad = post({ ...f, player: f.other, held: poison }); await untilPending(2);
    for (let n = 0; n < 5; n++) await queue.tick();
    assert.equal((await good).status, 200); assert.equal((await bad).status, 500);
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.held.id } }), 1);
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: poison.id } }), 0);
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS experiment_reject_peer ON race_powerups'); }
  await server.close();
});
it('a killed worker rolls back gameplay and a replacement recovers the durable command', async () => {
  const f = await fixture('RUNNERS_HIGH');
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION experiment_pause_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
  await prisma.$executeRawUnsafe("CREATE TRIGGER experiment_pause_use BEFORE UPDATE OF status ON race_powerups FOR EACH ROW WHEN (NEW.status='used') EXECUTE FUNCTION experiment_pause_use()");
  let child;
  try {
    const pending = post(f); await untilPending();
    child = spawn(process.execPath, ['-e', "require('./scripts/experiments/powerup-command-comparison/queue').createPowerupCommandQueue().tick().then(()=>process.exit(0)).catch(()=>process.exit(1))"], { cwd: path.resolve(__dirname, '../..'), env: process.env, stdio: 'ignore' });
    let sleeping = false;
    for (let n = 0; n < 300; n++) {
      const [row] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%race_powerups%'");
      if (row.count > 0) { sleeping = true; break; } await delay(10);
    }
    assert.ok(sleeping, 'worker must reach the uncommitted inventory mutation');
    const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.held.id } }), 0);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.held.id } })).status, 'HELD');
    await prisma.$executeRawUnsafe('DROP TRIGGER experiment_pause_use ON race_powerups');
    await prisma.$executeRawUnsafe("UPDATE experiment_powerup_inboxes SET lease_until=clock_timestamp()-interval '1 second'");
    await queue.tick(); const response = await pending; assert.equal(response.status, 200);
    const body = await response.json(); const replay = await post(f); assert.deepEqual(await replay.json(), body);
    assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.held.id } }), 1);
  } finally { child?.kill('SIGKILL'); await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS experiment_pause_use ON race_powerups'); }
  await server.close();
});
it('unfinished response work remains inside the bounded admission capacity', async () => {
  let release; const paused = new Promise(resolve => { release = resolve; });
  queue = createPowerupCommandQueue({ maxPending: 1, afterGameplayCommit: () => paused });
  const f = await fixture(); const g = await fixture();
  const first = post(f); await untilPending(); const worker = queue.tick();
  for (let n=0;n<200;n++) { const [row]=await prisma.$queryRawUnsafe('SELECT status,post_done FROM experiment_powerup_commands'); if(row.status===200&&!row.post_done)break; await delay(5); }
  let response;
  try { response = await post(g); }
  finally { release(); await worker; }
  assert.equal((await first).status,200);
  assert.equal(response.status,503); assert.deepEqual(await response.json(),{error:'Powerup service busy. Please try again.'});
  assert.equal((await prisma.racePowerup.findUnique({where:{id:g.held.id}})).status,'HELD');
  await server.close();
});
it('death after gameplay commit preserves scoring handoff and recovers inventory before success delivery', async () => {
  const f=await fixture('RUNNERS_HIGH');
  await prisma.race.update({where:{id:f.race.id},data:{powerupStepInterval:5000}});
  const box=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.player.participant.id,userId:f.player.user.id,type:'MYSTERY_BOX',rarity:'COMMON',status:'QUEUED',earnedAtSteps:2}});
  let delivered=false;
  const pending=post(f).then(response=>{delivered=true;return response;}); await untilPending();
  const child=spawn(process.execPath,['-e',"require('./scripts/experiments/powerup-command-comparison/queue').createPowerupCommandQueue({afterGameplayCommit:()=>process.exit(0)}).tick().catch(()=>process.exit(1))"],{cwd:path.resolve(__dirname,'../..'),env:process.env,stdio:'ignore'});
  const [exitCode]=await once(child,'exit'); assert.equal(exitCode,0);
  const [committed]=await prisma.$queryRawUnsafe('SELECT status,post_done FROM experiment_powerup_commands');
  assert.equal(committed.status,200);assert.equal(committed.post_done,false);assert.equal(delivered,false);
  assert.equal((await prisma.racePowerup.findUnique({where:{id:f.held.id}})).status,'USED');
  assert.equal((await prisma.racePowerup.findUnique({where:{id:box.id}})).status,'QUEUED');
  const [job]=await prisma.$queryRawUnsafe('SELECT generation FROM race_resolution_jobs_v2 WHERE race_id=$1',f.race.id);
  assert.ok(Number(job.generation)>0,'durable scoring handoff must commit with gameplay');
  const eventCount=await prisma.domainEventOutbox.count();
  const replay=post(f); await queue.tick();
  const response=await pending; assert.equal(response.status,200);assert.deepEqual(await (await replay).json(),await response.json());
  assert.equal((await prisma.racePowerup.findUnique({where:{id:box.id}})).status,'MYSTERY_BOX');
  assert.equal(await prisma.domainEventOutbox.count(),eventCount);
  assert.equal((await prisma.$queryRawUnsafe('SELECT post_done FROM experiment_powerup_commands'))[0].post_done,true);
  await server.close();
});
// Transport/admission coverage, not a claim that every type's complete gameplay
// decision tree is covered here. Complex rejection preconditions are preserved.
const TYPES = ['LEG_CRAMP','RED_CARD','SHORTCUT','COMPRESSION_SOCKS','PROTEIN_SHAKE','RUNNERS_HIGH','SECOND_WIND','STEALTH_MODE','WRONG_TURN','FANNY_PACK','TRAIL_MIX','DETOUR_SIGN','LUCKY_HORSESHOE','CAMPFIRE_REST','TRAIL_MAGNET','POCKET_WATCH','TRAIL_MINE','PINECONE_TOSS','SNEAKY_SWAP','MIRROR','CLEANSE','IMPOSTER','RAINSTORM','SIGNAL_JAMMER','LEECH','DEFENSE_SCAN','HITCHHIKE','QUICK_RINSE','QUICKSAND','UPRISING','GHOST_PEPPER','COIN_FLIP','MYSTERY_POTION','DECOY','POWER_OUTAGE','UMBRELLA','RALLY_FLAG','DRILL_SERGEANT','PIGGY_BANK','BOUNTY','MYSTERY_BOX'];
const TARGETED = new Set(['LEG_CRAMP','RED_CARD','SHORTCUT','WRONG_TURN','DETOUR_SIGN','PINECONE_TOSS','SNEAKY_SWAP','SIGNAL_JAMMER','LEECH','HITCHHIKE','COIN_FLIP','DRILL_SERGEANT','BOUNTY']);
for (const type of TYPES) it(`${type} retains a terminal HTTP contract through the same scheduler`, async () => {
  queue = createPowerupCommandQueue({ mode: 'BATCH', batchSize: 8 });
  const f = await fixture(type);
  const body = TARGETED.has(type) ? { targetUserId: f.other.user.id } : type === 'QUICKSAND' ? { targetUserIds: [f.other.user.id] } : {};
  const pending = post(f, body); await untilPending(); for (let n = 0; n < 4; n++) await queue.tick(); const response = await pending; const result = await response.json();
  assert.ok(response.status >= 200 && response.status < 500, `${type}: ${JSON.stringify(result)}, ${queue.metrics.lastError || ''}`);
  const [terminal] = await prisma.$queryRawUnsafe('SELECT status,body FROM experiment_powerup_commands');
  assert.equal(terminal.status, response.status); assert.deepEqual(terminal.body, result);
  const stored = await prisma.racePowerup.findUnique({ where: { id: f.held.id } });
  assert.equal(stored.status, response.status === 200 ? 'USED' : 'HELD');
  if (type === 'IMPOSTER') { assert.equal(response.status, 410); assert.equal(result.powerupType, 'IMPOSTER'); }
  if (type === 'DEFENSE_SCAN') { assert.equal(response.status, 200); assert.equal(result.ok, true); assert.deepEqual(result.scan, result.result.scan); }
  await server.close();
});
