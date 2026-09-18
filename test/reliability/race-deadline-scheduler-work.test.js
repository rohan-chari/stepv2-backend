const assert = require('node:assert/strict');
const { before, beforeEach, after, test } = require('node:test');
// Guard before loading services: this suite creates real rows.
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
assert.equal(process.env.NODE_ENV, 'test');
if (process.env.REDIS_URL) {
  const redis = new URL(process.env.REDIS_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(redis.hostname));
  assert.equal(redis.pathname, '/15');
}
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
const { buildRaceEffectDeadlineScheduler, buildRaceResolutionWorkerV2,
  buildRaceResolutionPostTaskRunner } = require('../../src/modules/races');
let server;
let queries = null;
prisma.$on('query', q => { if (queries) queries.push(q.query); });
before(async () => { server = await startServer(); });
beforeEach(cleanDatabase);
after(async () => { await server.close(); await prisma.$disconnect(); });

async function raceFixture() {
  const viewer = await createTestUser();
  const race = await prisma.race.create({ data: { creatorId: viewer.user.id,
    name: 'Polling public lifecycle', status: 'ACTIVE', targetSteps: 200000,
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
    timezone: 'UTC', powerupsEnabled: true, powerupStepInterval: 5000 } });
  const participant = await prisma.raceParticipant.create({ data: { raceId: race.id,
    userId: viewer.user.id, status: 'ACCEPTED', nextBoxAtSteps: 5000 } });
  return { viewer, race, participant };
}
async function publicProgress(f) {
  const responses = [];
  for (const features of ['powerups3', 'powerups3,powerups4,powerups5']) {
    const res = await request(server.baseUrl, 'GET', `/races/${f.race.id}/progress`, {
      token: f.viewer.token, headers: { 'X-Timezone': 'UTC',
        'X-App-Version': features === 'powerups3' ? '2.3.0' : '99.0.0', 'X-Client-Features': features } });
    assert.equal(res.status, 200);
    responses.push(await res.json());
  }
  assert.equal(responses[0].progress.participants.find(p => p.userId === f.viewer.user.id).totalSteps,
    responses[1].progress.participants.find(p => p.userId === f.viewer.user.id).totalSteps);
  return responses;
}
const discovery = q => q.includes('steps:deadline-scheduler-discovery:v1');
const oldRefresh = q => q.includes('SELECT race_id FROM race_progress_refresh_intents');
const oldRepair = q => q.includes('UPDATE race_snapshot_repair_intents i SET lease_token=');

test('idle public scheduler uses one discovery and no empty claims per pass', async () => {
  const scheduler = buildRaceEffectDeadlineScheduler();
  // Exclude one-minute health instrumentation from discovery accounting.
  await scheduler.tick();
  queries = [];
  for (let n = 0; n < 3; n++) assert.equal(await scheduler.tick(), 0);
  const observed = queries; queries = null;
  assert.equal(observed.filter(discovery).length, 3, 'one actual SQL discovery per tick');
  assert.equal(observed.filter(oldRefresh).length, 0, 'no empty refresh discovery');
  assert.equal(observed.filter(oldRepair).length, 0, 'no empty repair UPDATE');
  assert.equal(observed.length, 3, 'no hidden extra database commands');
});

test('repair-only work remains discoverable without any effect rows', async () => {
  const f = await raceFixture();
  const scheduler = buildRaceEffectDeadlineScheduler();
  await scheduler.tick();
  await prisma.$executeRawUnsafe(`INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation)
    VALUES($1,$2,0)`, 'polling-repair', f.race.id);
  queries = [];
  await scheduler.tick();
  const observed = queries; queries = null;
  assert.equal(observed.filter(discovery).length, 1);
  const [row] = await prisma.$queryRawUnsafe('SELECT terminal_at FROM race_snapshot_repair_intents WHERE task_id=$1', 'polling-repair');
  assert.ok(row.terminal_at);
  await buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId: f.race.id });
  await buildRaceResolutionPostTaskRunner().tick();
  await publicProgress(f);
});

test('refresh-only rows arriving after an empty pass are processed by the next pass', async () => {
  const f = await raceFixture();
  // Public activation creates the durable race job through the normal handler.
  const powerup = await prisma.racePowerup.create({ data: { raceId: f.race.id,
    participantId: f.participant.id, userId: f.viewer.user.id, type: 'FANNY_PACK',
    rarity: 'RARE', status: 'HELD', earnedAtSteps: 0 } });
  const use = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${powerup.id}/use`,
    { token: f.viewer.token, body: {} });
  assert.equal(use.status, 200);
  const scheduler = buildRaceEffectDeadlineScheduler();
  await scheduler.tick();
  await prisma.$executeRawUnsafe(`INSERT INTO race_progress_refresh_intents
    (race_id,user_id,minimum_committed_generation,resolution_time_zone)
    VALUES($1,$2,0,'UTC')`, f.race.id, f.viewer.user.id);
  queries = [];
  await scheduler.tick();
  const observed = queries; queries = null;
  assert.equal(observed.filter(discovery).length, 1);
  assert.equal((await prisma.$queryRawUnsafe('SELECT race_id FROM race_progress_refresh_intents WHERE race_id=$1', f.race.id)).length, 0);
  await buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId: f.race.id });
  await buildRaceResolutionPostTaskRunner().tick();
  await publicProgress(f);
});

test('HTTP activation and legacy extension preserve latest expiry for frozen/current clients', async () => {
  const f = await raceFixture();
  const powerup = await prisma.racePowerup.create({ data: { raceId: f.race.id,
    participantId: f.participant.id, userId: f.viewer.user.id, type: 'FANNY_PACK',
    rarity: 'RARE', status: 'HELD', earnedAtSteps: 0 } });
  const use = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${powerup.id}/use`,
    { token: f.viewer.token, body: {} });
  assert.equal(use.status, 200);
  const effect = await prisma.raceActiveEffect.findFirstOrThrow({ where: { powerupId: powerup.id } });
  await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const a = buildRaceEffectDeadlineScheduler(), b = buildRaceEffectDeadlineScheduler();
  await Promise.all([a.tick(), b.tick()]);
  const extension = new Date(Date.now() + 3600000);
  await prisma.raceActiveEffect.update({ where: { id: effect.id }, data: { expiresAt: extension } });
  await a.tick();
  await buildRaceResolutionWorkerV2({ bootAt: 0 }).processRace({ raceId: f.race.id });
  await buildRaceResolutionPostTaskRunner().tick();
  for (const body of await publicProgress(f)) {
    assert.equal(body.progress.powerupData.activeEffects.find(e => e.id === effect.id)?.expiresAt, extension.toISOString());
    assert.equal(body.progress.powerupData.powerupSlots, 4);
  }
  assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, eventType: 'EFFECT_EXPIRED' } }), 0);
});

async function background(t) {
  const { fork } = require('node:child_process');
  const { join } = require('node:path');
  const worker = fork(join(__dirname,'fixtures/deadline-scheduler-worker.cjs'),[],{
    env:{...process.env},stdio:['ignore','ignore','ignore','ipc'] });
  let sequence=0;const pending=new Map();
  const ready=new Promise((resolve,reject)=>{
    worker.on('message',m=>{if(m.ready)resolve();else{const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error)):p.resolve(m);}}});
    worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error(`worker exited ${code}`));});
  });
  t.after(()=>{if(worker.exitCode===null)worker.kill('SIGKILL');});
  await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('worker boot timeout')),10000).unref())]);
  const send=kind=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(new Error('worker reply timeout')),10000);pending.set(id,{resolve,reject,timer});worker.send({kind,id});});
  return {send};
}
async function eventually(check, timeout=5000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,30));}
  assert.fail('condition did not converge before timeout');
}
test('real background timer performs one idle read and stops without later SQL',async t=>{
  const child=await background(t);
  const snapshot=await eventually(async()=>{const s=await child.send('snapshot');return s.queries.filter(q=>discovery(q.sql)).length>=3?s:null;});
  assert.equal(snapshot.queries.filter(q=>oldRefresh(q.sql)||oldRepair(q.sql)).length,0);
  const stopped=await child.send('stop');assert.equal(stopped.count,stopped.after);
});

test('real Redis burst during blocked discovery retains one follow-up and delivers durable expiry',async t=>{
  const f=await raceFixture();
  const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.participant.id,
    userId:f.viewer.user.id,type:'FANNY_PACK',rarity:'RARE',status:'HELD',earnedAtSteps:0}});
  const use=await request(server.baseUrl,'POST',`/races/${f.race.id}/powerups/${powerup.id}/use`,{token:f.viewer.token,body:{}});
  assert.equal(use.status,200);
  const effect=await prisma.raceActiveEffect.findFirstOrThrow({where:{powerupId:powerup.id}});
  const child=await background(t);
  await eventually(async()=>{const s=await child.send('snapshot');return s.queries.some(q=>discovery(q.sql));});
  const metric=(s,name)=>Object.entries(s.metrics.counters).filter(([k])=>k.startsWith(name+'{')&&k.includes('queue=effect-deadline')).reduce((n,[,v])=>n+v,0);
  if(process.env.REDIS_URL){
    const Redis=require('ioredis');const client=new Redis(process.env.REDIS_URL);t.after(()=>client.disconnect());
    const channel=(process.env.CACHE_ENV_PREFIX||'')+'durable-queue:wake';
    await eventually(async()=>Number((await client.pubsub('NUMSUB',channel))[1])>0);
    const {Client}=require('pg');const lock=new Client({connectionString:process.env.DATABASE_URL});await lock.connect();
    t.after(async()=>{await lock.query('ROLLBACK').catch(()=>{});await lock.end().catch(()=>{});});
    await lock.query('BEGIN');await lock.query('LOCK TABLE race_effect_deadlines IN ACCESS EXCLUSIVE MODE');
    const before=await child.send('snapshot');
    await client.publish(channel,JSON.stringify({queue:'resolution',workKind:'ordinary'}));
    await eventually(async()=>{const [r]=await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%steps:deadline-scheduler-discovery:v1%'`);return r.n===1;});
    const batch=client.pipeline();for(let n=0;n<1000;n++)batch.publish(channel,JSON.stringify({queue:'resolution',workKind:'ordinary'}));await batch.exec();
    const received=await eventually(async()=>{const s=await child.send('snapshot');return metric(s,'durable_queue_wake_received_total')-metric(before,'durable_queue_wake_received_total')===1001?s:null;});
    assert.ok(metric(received,'durable_queue_wake_coalesced_total')-metric(before,'durable_queue_wake_coalesced_total')>=1000);
    const [blocked]=await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%steps:deadline-scheduler-discovery:v1%'`);
    assert.equal(blocked.n,1,'only one discovery may wait on controlled DB work');
    // Commit real source expiry in the holding transaction. Its existing trigger
    // maintains the durable deadline; the pending read must observe it.
    await lock.query("UPDATE race_active_effects SET expires_at=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE id=$1",[effect.id]);
    await lock.query('COMMIT');
    await eventually(async()=> (await prisma.$queryRawUnsafe('SELECT dispatched_revision FROM race_effect_deadlines WHERE effect_id=$1',effect.id))[0]?.dispatched_revision);
    await new Promise(r=>setTimeout(r,250));
    const drained=await child.send('snapshot');
    const discoveryDelta=drained.queries.filter(q=>discovery(q.sql)).length-before.queries.filter(q=>discovery(q.sql)).length;
    // One blocked read + one retained follow-up. A periodic timer and the
    // dispatch's own real wake can add bounded work; never one per burst signal.
    assert.ok(discoveryDelta<=4,`burst created ${discoveryDelta} completed discovery calls`);
  }else{
    // No Redis client is created; loss of every wake still reaches real expiry.
    await prisma.raceActiveEffect.update({where:{id:effect.id},data:{expiresAt:new Date(Date.now()-1000)}});
    await eventually(async()=> (await prisma.$queryRawUnsafe('SELECT dispatched_revision FROM race_effect_deadlines WHERE effect_id=$1',effect.id))[0]?.dispatched_revision);
  }
  await child.send('startWorkers');
  await eventually(async()=> (await prisma.raceActiveEffect.findUnique({where:{id:effect.id}}))?.status==='EXPIRED',10000);
  await eventually(async()=>{
    const r=await request(server.baseUrl,'GET',`/races/${f.race.id}/progress`,{token:f.viewer.token,headers:{'X-Client-Features':'powerups3','X-Timezone':'UTC'}});
    if(r.status!==200)return false;const b=await r.json();return !b.progress.powerupData.activeEffects.some(e=>e.id===effect.id);
  },10000);
  for(const body of await publicProgress(f)){
    assert.equal(body.progress.powerupData.activeEffects.some(e=>e.id===effect.id),false);
    assert.equal(body.progress.powerupData.powerupSlots,3);
    assert.equal(body.progress.participants.find(p=>p.userId===f.viewer.user.id).totalSteps,0);
  }
  // Once the actual work drains, observe more than two fallback periods to
  // catch an accidental self-sustaining empty-wake loop.
  const stable=await child.send('snapshot');await new Promise(r=>setTimeout(r,2200));const later=await child.send('snapshot');
  assert.ok(later.queries.filter(q=>discovery(q.sql)).length-stable.queries.filter(q=>discovery(q.sql)).length<=5);
  const stopped=await child.send('stop');assert.equal(stopped.count,stopped.after);
});

test('bounded saturated traversal reaches a live deadline behind more than 1000 inapplicable races',async()=>{
  const f=await raceFixture();
  const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.participant.id,
    userId:f.viewer.user.id,type:'FANNY_PACK',rarity:'RARE',status:'HELD',earnedAtSteps:0}});
  const use=await request(server.baseUrl,'POST',`/races/${f.race.id}/powerups/${powerup.id}/use`,{token:f.viewer.token,body:{}});
  assert.equal(use.status,200);
  const effect=await prisma.raceActiveEffect.findFirstOrThrow({where:{powerupId:powerup.id}});
  const at=Date.now();
  await prisma.raceActiveEffect.update({where:{id:effect.id},data:{expiresAt:new Date(at-1000)}});
  const ids=Array.from({length:1101},(_,n)=>`blocked-${String(n).padStart(4,'0')}`);
  await prisma.race.createMany({data:ids.map(id=>({id,name:id,status:'PENDING',targetSteps:100000,timezone:'UTC'}))});
  await prisma.raceParticipant.createMany({data:ids.map(id=>({id:`p-${id}`,raceId:id,userId:f.viewer.user.id,status:'ACCEPTED'}))});
  await prisma.racePowerup.createMany({data:ids.map(id=>({id:`u-${id}`,raceId:id,participantId:`p-${id}`,
    userId:f.viewer.user.id,type:'FANNY_PACK',rarity:'RARE',status:'USED',earnedAtSteps:0}))});
  await prisma.raceActiveEffect.createMany({data:ids.map((id,n)=>({id:`e-${id}`,raceId:id,targetParticipantId:`p-${id}`,
    targetUserId:f.viewer.user.id,sourceUserId:f.viewer.user.id,powerupId:`u-${id}`,type:'FANNY_PACK',
    startsAt:new Date(at-120000),expiresAt:new Date(at-60000+n)}))});
  // Freeze ONLY scheduler cooldown accounting to exercise a >1000-key burst
  // independent of local test machine speed. SQL, fences and writers stay real.
  const scheduler=buildRaceEffectDeadlineScheduler({now:()=>at,logger:{warn(){}}});
  queries=[];
  let dispatched=false;
  for(let n=0;n<36;n++){
    await scheduler.tick();
    const [row]=await prisma.$queryRawUnsafe('SELECT dispatched_revision FROM race_effect_deadlines WHERE effect_id=$1',effect.id);
    if(row.dispatched_revision){dispatched=true;break;}
  }
  const observed=queries;queries=null;
  assert.ok(dispatched,'live tail deadline must not starve behind bounded exclusions');
  assert.ok(observed.some(discovery));
  // Revision moves across traversal cursor; a later future extension must remain
  // undispatched even after wrap, then rediscover when it is made due again.
  await prisma.raceActiveEffect.update({where:{id:effect.id},data:{expiresAt:new Date(at+3600000)}});
  await scheduler.tick();
  assert.equal((await prisma.$queryRawUnsafe('SELECT dispatched_revision FROM race_effect_deadlines WHERE effect_id=$1',effect.id))[0].dispatched_revision,null);
  await prisma.raceActiveEffect.update({where:{id:effect.id},data:{expiresAt:new Date(at-180000)}});
  for(let n=0;n<3;n++)await scheduler.tick();
  assert.ok((await prisma.$queryRawUnsafe('SELECT dispatched_revision FROM race_effect_deadlines WHERE effect_id=$1',effect.id))[0].dispatched_revision);
  await buildRaceResolutionWorkerV2({bootAt:0}).processRace({raceId:f.race.id});
  await buildRaceResolutionPostTaskRunner().tick();
  const bodies=await publicProgress(f);
  for(const body of bodies)assert.equal(body.progress.powerupData.activeEffects.some(e=>e.id===effect.id),false);
});

test('background scheduler independently drains repair-only then refresh-only work with no effects',async t=>{
  const f=await raceFixture();const child=await background(t);
  await child.send('startWorkers');
  await eventually(async()=> (await child.send('snapshot')).queries.some(q=>discovery(q.sql)));
  await prisma.$executeRawUnsafe('INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation) VALUES($1,$2,0)',
    'background-repair-only',f.race.id);
  await eventually(async()=> (await prisma.$queryRawUnsafe('SELECT terminal_at FROM race_snapshot_repair_intents WHERE task_id=$1',
    'background-repair-only'))[0]?.terminal_at,10000);
  await eventually(async()=> (await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}}))?.state==='SUCCEEDED',10000);
  const job=await prisma.raceResolutionJobV2.findUniqueOrThrow({where:{raceId:f.race.id}});
  await prisma.$executeRawUnsafe(`INSERT INTO race_progress_refresh_intents
    (race_id,user_id,minimum_committed_generation,resolution_time_zone) VALUES($1,$2,$3,'UTC')`,
    f.race.id,f.viewer.user.id,job.committedGeneration);
  await eventually(async()=> !(await prisma.$queryRawUnsafe('SELECT 1 FROM race_progress_refresh_intents WHERE race_id=$1',f.race.id)).length,10000);
  for(const body of await publicProgress(f)){
    assert.equal(body.progress.participants.find(p=>p.userId===f.viewer.user.id).totalSteps,0);
    assert.equal(body.progress.powerupData.activeEffects.length,0);
    assert.equal(body.progress.powerupData.powerupSlots,3);
  }
  const stopped=await child.send('stop');assert.equal(stopped.count,stopped.after);
});
