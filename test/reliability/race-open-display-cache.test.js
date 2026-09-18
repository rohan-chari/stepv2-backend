process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const IORedis = require('ioredis');
const dbUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(dbUrl.hostname) && dbUrl.pathname.endsWith('_test'));
process.env.CACHE_ENV_PREFIX = `t:race-open:${randomUUID()}:`;
process.env.REDIS_URL = process.env.REDIS_TEST_URL || 'redis://127.0.0.1:6403';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_URL).hostname));
// Initialize query telemetry in the test harness, then construct real handlers
// with the deployed worker-owned read contract. Production itself rejects telemetry.
require('../../src/db');
require('../../src/shared/config/appSettings');
process.env.NODE_ENV = 'production';
process.env.STEPS_PROCESS_ROLE = 'http';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
const HEADERS = { 'X-Client-Features': 'characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,api_payload_compact_v1,race_leave,team_races,race_preview', 'X-Timezone': 'UTC', 'X-Release-Channel': 'prod' };
let server, sibling, child, redis, observed, previousSettings;
const FLAGS = ['apiRaceBootstrapV1Enabled','apiRaceBootstrapCompactV1Enabled'];
prisma.$on('query', event => { if (observed) observed.push(event); });
async function fixture() {
  const alice = await createTestUser({ displayName: 'Cached race owner', timezone: 'UTC', globalEventTimezone: 'UTC' });
  const bob = await createTestUser({ displayName: 'Cached race rival', timezone: 'UTC', globalEventTimezone: 'UTC' });
  const race = await prisma.race.create({ data: { creatorId: alice.user.id, name: 'Race display cache', status: 'ACTIVE', startedAt: new Date(Date.now()-3600000), endsAt: new Date(Date.now()+86400000), targetSteps: 100000, timeBased: true, isPublic: true, timezone: 'UTC', powerupsEnabled: true, powerupStepInterval: 5000 } });
  const participants = [];
  for (const user of [alice,bob]) participants.push(await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: 'ACCEPTED', totalSteps: 2500, rawSteps: 2500, boxProgressSteps: 2500, nextBoxAtSteps: 5000 } }));
  const trailMix = await prisma.racePowerup.create({ data: { raceId: race.id, userId: alice.user.id, participantId: participants[0].id, type: 'TRAIL_MIX', rarity: 'RARE', status: 'HELD' } });
  return { alice, bob, race, participants, trailMix };
}
async function get(f, { base = server.baseUrl, user = f.alice, path = 'bootstrap?view=participants-v1&limit=15&shape=compact-v1', headers = HEADERS } = {}) {
  const response = await request(base, 'GET', `/races/${f.race.id}/${path}`, { token: user.token, headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
const families = {
  summary: q => q.includes('AS "activeFundedPlayerCount"'),
  preview: q => q.includes('BOOL_AND(raw_steps IS NOT NULL)'),
  effects: q => q.includes('FROM "public"."race_active_effects"') && q.includes('ORDER BY "public"."race_active_effects"."created_at"'),
  history: q => q.includes('FROM "public"."race_powerups"') && q.includes('"type" IS NOT NULL'),
  participant: q => q.includes('FROM "public"."race_participants"') && q.includes('"max_bonus_steps"'),
  core: q => q.includes('FROM "public"."races"') && q.includes('"payout_rounding_version"'),
};
describe('race-open Redis display inputs through real HTTP', () => {
  before(async () => {
    redis = new IORedis(process.env.REDIS_URL);
    await cleanDatabase();
    previousSettings = await prisma.appSetting.findMany({ where: { key: { in: FLAGS } } });
    for (const key of FLAGS) await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
    server = await getSharedServer();
    child = spawn(process.execPath, ['test/integration/helpers/standaloneServer.js'], { cwd: process.env.CACHE_TEST_WRITER_ROOT || process.cwd(), env: { ...process.env, PORT: '0', PRISMA_QUERY_EVENTS_ENABLED: 'false', DATABASE_POOL_MAX_HTTP: '10' }, stdio: ['ignore','pipe','pipe'] });
    let childErrors = ''; child.stderr.on('data', bytes => { childErrors = (childErrors + String(bytes)).slice(-2500).replace(/(?:postgres(?:ql)?|rediss?):\/\/[^\s]+/g, '[connection]'); });
    sibling = await new Promise((resolve,reject) => { const timer = setTimeout(() => reject(new Error('Sibling API startup timeout')),10000); child.once('exit',code => {clearTimeout(timer);reject(new Error(`Sibling API exited ${code}: ${childErrors}`));}); child.stdout.on('data',bytes=>{const m=String(bytes).match(/LISTENING (http:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}}); });
  });
  beforeEach(async () => { observed=null; await cleanDatabase(); const keys=await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`); if(keys.length)await redis.del(...keys); });
  after(async () => { if(child?.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}await redis.quit(); await prisma.appSetting.deleteMany({ where: { key: { in: FLAGS } } }); if (previousSettings?.length) await prisma.appSetting.createMany({ data: previousSettings }); });
  for(const [name, matches] of Object.entries(families)) it(`warm bootstrap eliminates ${name} SQL`, async () => {
    const f=await fixture(); const first=await get(f); assert.equal(first.progressError,null); assert.ok(first.progress.powerupData);
    observed=[]; const warm=await get(f); const queries=[...observed]; observed=null;
    assert.deepEqual(warm.race,first.race); assert.deepEqual(warm.progress.powerupData,first.progress.powerupData);
    assert.equal(queries.filter(e=>matches(e.query)).length,0,JSON.stringify(queries.filter(e=>matches(e.query))));
  });
  for (const mode of ['legacy','null-timezone','team']) it(`warm ${mode} bootstrap reuses display scalars`, async () => {
    const f = await fixture();
    if (mode === 'null-timezone') await prisma.race.update({ where: { id: f.race.id }, data: { timezone: null } });
    if (mode === 'team') {
      await prisma.race.update({ where: { id: f.race.id }, data: { isTeamRace: true, teamSize: 1 } });
      for (const [i,row] of f.participants.entries()) await prisma.raceParticipant.update({ where: { id: row.id }, data: { team: i ? 'TEAM_B' : 'TEAM_A' } });
    }
    const options = mode === 'legacy' ? { path: 'bootstrap', headers: { 'X-Timezone': 'UTC' } } : {};
    const first = await get(f, options); assert.equal(first.progressError, null);
    observed = []; const warm = await get(f, options); const queries = [...observed]; observed = null;
    assert.deepEqual(warm.race, first.race); assert.deepEqual(warm.progress.powerupData, first.progress.powerupData);
    for (const name of ['core','participant']) assert.equal(queries.filter(e=>families[name](e.query)).length,0,`${mode} ${name}: ${JSON.stringify(queries.filter(e=>families[name](e.query)))}`);
  });
  it('shares one authoritative gate for modern clients on every race-open GET', async () => {
    const f = await fixture(); await get(f);
    for (const suffix of ['/bootstrap?view=participants-v1&shape=compact-v1','/progress?view=participants-v1','?view=participants-v1']) {
      observed=[];
      const response=await request(server.baseUrl,'GET',`/races/${f.race.id}${suffix}`,{token:f.alice.token,headers:{...HEADERS,'X-Client-Features':`${HEADERS['X-Client-Features']},team_races_10v10_v1`}});
      const queries=[...observed];observed=null;assert.equal(response.status,200);
      assert.equal(queries.filter(e=>e.query.includes('race-open:authoritative-access')).length,1);
      assert.equal(queries.filter(e=>e.query.includes('FROM "public"."races"')).length,0,'duplicate capability/core SELECT');
    }
  });
  it('retains frozen-client preflight before the authoritative handler gate', async () => {
    const f=await fixture();await get(f);
    for(const suffix of ['/bootstrap','/progress','']) {
      observed=[];
      const response=await request(server.baseUrl,'GET',`/races/${f.race.id}${suffix}`,{token:f.alice.token,headers:HEADERS});
      const queries=[...observed];observed=null;assert.equal(response.status,200);
      const preflight=queries.findIndex(e=>e.query.includes('FROM "public"."races"')&&e.query.includes('"team_size"'));
      const gate=queries.findIndex(e=>e.query.includes('race-open:authoritative-access'));
      assert.ok(preflight>=0&&gate>preflight,'frozen preflight must precede fresh handler access');
      assert.equal(queries.filter(e=>e.query.includes('race-open:authoritative-access')).length,1);
    }
  });
  it('retains old-client large-team errors and private/absent race status codes', async () => {
    const f=await fixture();
    await prisma.race.update({where:{id:f.race.id},data:{isTeamRace:true,teamSize:10,isPublic:false}});
    for(const suffix of ['/bootstrap','/progress','']) {
      const old=await request(server.baseUrl,'GET',`/races/${f.race.id}${suffix}`,{token:f.alice.token,headers:{'X-Timezone':'UTC'}});
      assert.equal(old.status,400);assert.equal((await old.json()).code,'UPDATE_REQUIRED');
      const unknown=await request(server.baseUrl,'GET',`/races/${randomUUID()}${suffix}`,{token:f.alice.token,headers:HEADERS});assert.equal(unknown.status,404);
    }
  });
  for (const client of ['old', 'modern']) it(`reports actual cold/warm SQL and Redis work for ${client} clients and keeps paged standalone reads warm`, async (t) => {
    const f = await fixture();
    const headers = client === 'modern' ? {...HEADERS,'X-Client-Features':`${HEADERS['X-Client-Features']},team_races_10v10_v1`} : HEADERS;
    const redisStats = async () => {
      const [[,stats],[,commands]] = await redis.pipeline().info('stats').info('commandstats').exec();
      return { commands: Number(stats.match(/total_commands_processed:(\d+)/)[1]),
        evalCalls: Number(commands.match(/cmdstat_eval:calls=(\d+)/)?.[1] || 0),
        evalshaCalls: Number(commands.match(/cmdstat_evalsha:calls=(\d+)/)?.[1] || 0) };
    };
    const measure = async (options) => {
      const before = await redisStats(); observed = [];
      const body = await get(f, {headers, ...options}); const queries = [...observed]; observed = null;
      const after = await redisStats();
      const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:*`);
      const payloads = keys.length ? await redis.mget(...keys) : [];
      return { body, queries, redisCommands: after.commands - before.commands - 2,
        redisEvalCalls: after.evalCalls - before.evalCalls, redisEvalshaCalls: after.evalshaCalls - before.evalshaCalls,
        raceOpenPayloadBytes: payloads.reduce((sum,payload)=>sum+Buffer.byteLength(payload || ''),0) };
    };
    const jobsBefore = await prisma.raceResolutionJobV2.count({ where: { raceId: f.race.id } });
    const cold = await measure(); const warm = await measure();
    const jobsAfter = await prisma.raceResolutionJobV2.count({ where: { raceId: f.race.id } });
    assert.equal(jobsAfter, jobsBefore);
    const shape = result => ({ sql: result.queries.length, sqlWrites: result.queries.filter(e => /^(?:INSERT|UPDATE|DELETE)\b/.test(e.query.trim())).length,
      redisCommands: result.redisCommands, redisEvalCalls: result.redisEvalCalls, redisEvalshaCalls: result.redisEvalshaCalls, raceOpenPayloadBytes: result.raceOpenPayloadBytes, families: Object.fromEntries(Object.entries(families).map(([name,matches]) => [name,result.queries.filter(e=>matches(e.query)).length])) });
    t.diagnostic(JSON.stringify({ client, cold: shape(cold), warm: shape(warm), queueJobsAdded: jobsAfter - jobsBefore, remainingWarmSql: warm.queries.map(e=>e.query) }));
    assert.equal(shape(warm).sqlWrites, 0);
    const progress = await measure({ path: 'progress?view=participants-v1&limit=15' });
    assert.deepEqual(progress.body.progress.powerupData, warm.body.progress.powerupData);
    assert.equal(progress.queries.filter(e=>Object.values(families).some(matches=>matches(e.query))).length,0);
    const response = await request(server.baseUrl,'GET',`/races/${f.race.id}?view=participants-v1&limit=15`,{token:f.alice.token,headers});
    assert.equal(response.status,200); assert.equal((await response.json()).myChatMuted,false);
  });
  it('sibling mute writes invalidate immediately without leaking viewer state', async () => {
    const f=await fixture(); assert.equal((await get(f)).race.myChatMuted,false);
    for (const path of ['chat/mute','placement/mute']) {const r=await request(sibling,'PUT',`/races/${f.race.id}/${path}`,{token:f.alice.token,body:{muted:true}});assert.equal(r.status,200);}
    const changed=await get(f);assert.equal(changed.race.myChatMuted,true);assert.equal(changed.race.myPlacementAlertsMuted,true);
    const other=await get(f,{user:f.bob});assert.equal(other.race.myChatMuted,false);assert.equal(other.race.myPlacementAlertsMuted,false);
  });
  it('public team settlement refreshes a warm payout artifact before later completion invalidations', async () => {
    const f = await fixture();
    await prisma.race.update({ where: { id: f.race.id }, data: { isTeamRace: true, teamSize: 2, maxParticipants: 4, powerupsEnabled: false,
      fundedPrize: true, payoutRoundingVersion: 1, teamPayoutVersion: 1, teamWinnerRewardCoins: 500, maxDurationDays: 1 } });
    for (const [i,row] of f.participants.entries()) await prisma.raceParticipant.update({ where: { id: row.id }, data: { team: i ? 'TEAM_B' : 'TEAM_A' } });
    // Model a durable credit committed before participant/result persistence.
    await prisma.coinTransaction.create({ data: { userId: f.alice.user.id, amount: 500, reason: 'race_prize_pool_payout', refId: `${f.race.id}:1`,
      payoutMetadata: { recipientId: f.alice.user.id, rawAwardCoins: 500, awardCoins: 500, roundingSubsidyCoins: 0 } } });
    const locks = new (require('pg').Client)({ connectionString: process.env.DATABASE_URL });
    await locks.connect();
    let settling;
    const waitForBarrier = async key => {
      for(let attempt=0;attempt<200;attempt++) {
        const rows=await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=$1::oid`,key);
        if(rows.length)return;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error(`Settlement did not reach barrier ${key}`);
    };
    await prisma.$executeRawUnsafe('CREATE TABLE race_open_recovery_probe (race_id text, participant_id text)');
    await prisma.$executeRawUnsafe('INSERT INTO race_open_recovery_probe VALUES ($1,$2)',f.race.id,f.participants[0].id);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION race_open_recovery_participant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id IN (SELECT participant_id FROM race_open_recovery_probe) AND OLD.payout_coins=0 AND NEW.payout_coins=500 THEN PERFORM pg_advisory_xact_lock(31415920); END IF;
      RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER race_open_recovery_participant BEFORE UPDATE OF payout_coins ON race_participants FOR EACH ROW EXECUTE FUNCTION race_open_recovery_participant()');
    await prisma.$executeRawUnsafe(`CREATE FUNCTION race_open_recovery_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id IN (SELECT race_id FROM race_open_recovery_probe) AND EXISTS (SELECT 1 FROM race_participants WHERE id IN (SELECT participant_id FROM race_open_recovery_probe) AND payout_coins=500) THEN PERFORM pg_advisory_xact_lock(31415921); END IF;
      RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER race_open_recovery_race BEFORE UPDATE ON races FOR EACH ROW EXECUTE FUNCTION race_open_recovery_race()');
    try {
      await locks.query('SELECT pg_advisory_lock(31415920), pg_advisory_lock(31415921)');
      settling=request(sibling,'POST',`/races/${f.race.id}/forfeit`,{token:f.bob.token,headers:HEADERS,body:{}});
      await waitForBarrier(31415920);
      const before=await get(f);assert.equal(before.race.status,'COMPLETED');
      assert.equal(before.race.participants.find(row=>row.userId===f.alice.user.id).payoutCoins,0);
      observed=[];await get(f);const warmQueries=[...observed];observed=null;assert.equal(warmQueries.filter(e=>families.summary(e.query)).length,0);
      await locks.query('SELECT pg_advisory_unlock(31415920)');
      await waitForBarrier(31415921);
      observed=[];const reconciled=await get(f);const freshQueries=[...observed];observed=null;
      assert.equal(reconciled.race.participants.find(row=>row.userId===f.alice.user.id).payoutCoins,500);
      assert.equal(freshQueries.filter(e=>families.summary(e.query)).length,1,'final payout overwrite invalidates warmed summary before race metadata and later forfeit hooks');
      assert.equal(await prisma.coinTransaction.count({where:{userId:f.alice.user.id,reason:'race_prize_pool_payout',refId:`${f.race.id}:1`}}),1);
      await locks.query('SELECT pg_advisory_unlock(31415921)');
      const finished=await settling;assert.equal(finished.status,200,await finished.text());
    } finally {
      observed=null;await locks.query('SELECT pg_advisory_unlock_all()');if(settling)await settling;
      await locks.end();
      await prisma.$executeRawUnsafe('DROP TRIGGER race_open_recovery_participant ON race_participants');
      await prisma.$executeRawUnsafe('DROP TRIGGER race_open_recovery_race ON races');
      await prisma.$executeRawUnsafe('DROP FUNCTION race_open_recovery_participant()');
      await prisma.$executeRawUnsafe('DROP FUNCTION race_open_recovery_race()');
      await prisma.$executeRawUnsafe('DROP TABLE race_open_recovery_probe');
    }
  });
  it('malformed fragments and evicted generations reload authoritative SQL', async () => {
    const f=await fixture(); const first=await get(f);
    const keys=await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:race-open:*`);assert.ok(keys.length>=6);
    for(const key of keys)await redis.set(key,'{broken','EX',30);
    const repaired=await get(f);assert.deepEqual(repaired.race,first.race);assert.deepEqual(repaired.progress.powerupData,first.progress.powerupData);
    const markers=await redis.keys(`${process.env.CACHE_ENV_PREFIX}ce:v1:g:*`);if(markers.length)await redis.del(...markers);
    assert.deepEqual((await get(f)).race,first.race);
  });
});
