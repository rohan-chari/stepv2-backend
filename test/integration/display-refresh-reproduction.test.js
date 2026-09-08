// Regression and measurements for guarded display refresh. Public reads and
// step intake feed the actual worker + post-task runner, with real PG/Redis.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, after, beforeEach, it } = require('node:test');
const { Client } = require('pg');
process.env.STEPS_PROCESS_ROLE = 'http';
process.env.DATABASE_POOL_MAX_HTTP = '10';
process.env.CACHE_ENV_PREFIX = `t:display-reproduction:${randomUUID()}:`;
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = '0';
process.env.RACE_RESOLVE_DEBOUNCE_MS = '0';
// Validate before loading anything that can connect to a database.
assert.match(new URL(process.env.DATABASE_URL).hostname, /^(127\.0\.0\.1|localhost|\[::1\])$/);
assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
if (process.env.REDIS_TEST_URL) assert.equal(new URL(process.env.REDIS_TEST_URL).hostname, '127.0.0.1');
let appSettings, prisma, cleanDatabase, createTestUser, getSharedServer, request, redis, worker, post;
const { startTestRedis } = require('./redisTestServer');
let server, liveRedis, observed = null;
let beforeWrite = null;
let workerClock = null;
const events = [];
const logger = { log(line) { try { const x=JSON.parse(line);if(x.event==='race_resolution_v2')events.push(x); } catch {} }, error: console.error };
const original=Client.prototype.query;
before(async()=>{
 assert.match(new URL(process.env.DATABASE_URL).hostname, /^(127\.0\.0\.1|localhost|\[::1\])$/);
 assert.match(new URL(process.env.DATABASE_URL).pathname,/_test$/);
 liveRedis = await startTestRedis();
 assert.ok(liveRedis, 'This diagnostic requires a real local Redis');
 process.env.REDIS_URL = liveRedis.url;
 ({ appSettings } = require('../../src/shared/config/appSettings'));
 process.env.NODE_ENV = 'production';
 ({ prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup'));
 redis = require('../../src/shared/cache/redisCache');
 const { buildRaceResolutionWorkerV2 } = require('../../src/modules/races/jobs/raceResolutionQueueV2');
 const { buildRaceResolutionPostTaskRunner } = require('../../src/modules/races/jobs/raceResolutionPostTaskRunner');
 worker = buildRaceResolutionWorkerV2({bootAt:0,processRole:'resolution',logger,now:()=>workerClock || new Date(),beforeWriteTransaction:async(args)=>{if(beforeWrite)await beforeWrite(args);}});
 post = buildRaceResolutionPostTaskRunner({logger});
 Client.prototype.query=function(...args){
  const text=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(observed&&text){observed.sql++;if(/step_samples|durable_capture_/i.test(text))observed.sourceSql++;}
  return original.apply(this,args);
 };
 server=await getSharedServer();
});
beforeEach(async()=>{
 beforeWrite=null;workerClock=null;
 await cleanDatabase();events.length=0;
 await appSettings.setFlag('redisStandingsEnabled',true);
 await appSettings.setFlag('raceResolutionReasonAwareV1Enabled',true);
 await appSettings.setFlag('raceResolutionPostTasksV1Enabled',true);
});
after(async()=>{Client.prototype.query=original;await redis?.close();await liveRedis?.close();});
async function fixture(size){
 const viewer=await createTestUser();
 const others=Array.from({length:size-1},()=>({id:randomUUID(),appleId:randomUUID()}));
 await prisma.user.createMany({data:others});
 const ids=[viewer.user.id,...others.map(u=>u.id)],now=Date.now();
 const race=await prisma.race.create({data:{creatorId:viewer.user.id,name:'Display reproduction',status:'ACTIVE',targetSteps:1000000,maxParticipants:null,
  startedAt:new Date(now-86400000),endsAt:new Date(now+86400000),timezone:'UTC',powerupsEnabled:true}});
 await prisma.raceParticipant.createMany({data:ids.map(userId=>({raceId:race.id,userId,status:'ACCEPTED',joinedAt:new Date(now-86400000)}))});
 await prisma.userScoringInputVersion.createMany({data:others.map(u=>({userId:u.id,generation:1n}))});
 await prisma.stepSample.createMany({data:others.map(u=>({userId:u.id,periodStart:new Date(now-7200000),periodEnd:new Date(now-3600000),steps:50}))});
 const sample={periodStart:new Date(now-7200000).toISOString(),periodEnd:new Date(now-3600000).toISOString(),steps:50};
 const f={race,viewer,sample,size};await upload(f,50);await drain(f);return f;
}
async function upload(f,steps){
 const r=await request(server.baseUrl,'POST','/steps/sync-v2',{token:f.viewer.token,headers:{'Idempotency-Key':randomUUID(),'X-Timezone':'UTC'},
 body:{date:new Date().toISOString().slice(0,10),steps,samples:[{...f.sample,steps}]}});
 assert.equal(r.status,202,JSON.stringify(r.body));
}
async function drain(f){
 for(let i=0;i<5;i++){
  const row=await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}});
  if(row?.state==='QUEUED'||row?.state==='RUNNING')await worker.processRace({raceId:f.race.id});
  await post.snapshotTick();await post.tick();
  const after=await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}});
  if(after?.state==='SUCCEEDED')return;
  await new Promise(r=>setTimeout(r,30));
 }
 assert.fail('fixture resolution did not drain');
}
async function read(f){
 const r=await request(server.baseUrl,'GET',`/races/${f.race.id}/progress`,{token:f.viewer.token,headers:{'X-Timezone':'UTC'}});
 assert.equal(r.status,200);const b=await r.json();
 assert.equal(b.progress.participants.length,f.size);
 return b.progress.participants.map(p=>({userId:p.userId,totalSteps:p.totalSteps})).sort((a,b)=>a.userId.localeCompare(b.userId));
}
async function measured(f){
 const start=events.length,m={sql:0,sourceSql:0};observed=m;const at=performance.now();
 try{const response=await read(f);await new Promise(r=>setTimeout(r,50));await drain(f);return {...m,wallMs:performance.now()-at,response,attempts:events.slice(start).map(e=>({plan:e.resolutionPlan,reasons:e.reasonClasses,changedRows:e.changedRows,coreMs:e.coreMs,fenceRejections:e.sourceInputFenceRejections}))};}
 finally{observed=null;}
}
for(const size of [10,100])it(`${size} participants: compare fresh and >15s-old reads with unchanged source steps`,{timeout:90000},async(t)=>{
 const f=await fixture(size);
 const initial=await measured(f);
 assert.deepEqual(initial.attempts,[],'fresh snapshot must not trigger resolution');
 await new Promise(r=>setTimeout(r,16050));
 const stale=await measured(f);
 assert.deepEqual(stale.response,initial.response,'same source inputs preserve displayed totals');
 assert.ok(stale.attempts.some(e=>e.plan==='FULL'&&JSON.stringify(e.reasons)===JSON.stringify(['DISPLAY_REFRESH'])),'reproduce full display refresh');
 assert.ok(stale.attempts.every(e=>e.changedRows===0),'refresh has no participant total/bonus writes');
 await new Promise(r=>setTimeout(r,16050));
 const repeated=await measured(f);
 assert.deepEqual(repeated.response,initial.response);
 assert.ok(repeated.attempts.some(e=>e.plan==='COMMITTED_DISPLAY'&&JSON.stringify(e.reasons)===JSON.stringify(['DISPLAY_REFRESH'])),'an unchanged completed calculation is reused');
 assert.ok(repeated.attempts.every(e=>e.changedRows===0));
 t.diagnostic(JSON.stringify({size,repeated:{...repeated,response:undefined},fresh:{...initial,response:undefined},stale:{...stale,response:undefined}}));
 // Race a real upload against a reused candidate before its write fence.
 // It must invalidate the old calculation rather than publish old scores.
 if(size===10){
  beforeWrite=async()=>{beforeWrite=null;await upload(f,125);};
  await new Promise(r=>setTimeout(r,16050));
  const raced=await measured(f);
  assert.ok(raced.attempts.some(e=>e.fenceRejections>0),'concurrent upload must reject the stale candidate at its fence');
 }else{await upload(f,125);}
 await drain(f);
 const changed=await read(f);
 assert.equal(changed.find(p=>p.userId===f.viewer.user.id).totalSteps,125,'real step correction must reach the client');
 if(size===10){
  // Crossing the race's end excludes reuse even if sources did not change.
  workerClock=new Date(new Date(f.race.endsAt).getTime()+1000);
  await new Promise(r=>setTimeout(r,16050));
  const ended=await measured(f);
  assert.ok(ended.attempts.some(e=>e.plan==='FULL'),'race-end clock must use canonical resolution');
  assert.ok(ended.attempts.every(e=>e.plan!=='COMMITTED_DISPLAY'));
 }else{
  const participant=await prisma.raceParticipant.findUniqueOrThrow({where:{raceId_userId:{raceId:f.race.id,userId:f.viewer.user.id}}});
  const powerup=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:participant.id,userId:f.viewer.user.id,type:'FANNY_PACK',rarity:'RARE',status:'HELD',earnedAtSteps:0}});
  const used=await request(server.baseUrl,'POST',`/races/${f.race.id}/powerups/${powerup.id}/use`,{token:f.viewer.token,body:{},headers:{'X-Client-Features':'powerups3,powerups4,powerups5'}});
  assert.equal(used.status,200,JSON.stringify(await used.json()));
  await drain(f);
  for(let i=0;i<2;i++){
   await new Promise(r=>setTimeout(r,16050));
   const effect=await measured(f);
   assert.ok(effect.attempts.some(e=>e.plan==='FULL'),'an effect never enters the closed-input shortcut');
   assert.ok(effect.attempts.every(e=>e.plan!=='COMMITTED_DISPLAY'));
  }
 }

});
it('open-ended source samples never enter committed display reuse',{timeout:60000},async()=>{
 const f=await fixture(2);
 const at=Date.now();
 f.sample={periodStart:new Date(at-60000).toISOString(),periodEnd:new Date(at+3600000).toISOString(),steps:1};
 await upload(f,1);await drain(f);
 for(let i=0;i<2;i++){
  await new Promise(r=>setTimeout(r,16050));
  const cycle=await measured(f);
  assert.ok(cycle.attempts.some(e=>e.plan==='FULL'),'time-sensitive source uses canonical scoring');
  assert.ok(cycle.attempts.every(e=>e.plan!=='COMMITTED_DISPLAY'));
 }
});
