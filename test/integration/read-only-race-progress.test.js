// Public reads are display-only. Step intake feeds the actual worker and
// post-task runner against a dedicated local PostgreSQL database and Redis.
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
const events = [];
let phase="outside";
const logger = { log(line) { try { const x=JSON.parse(line);if(x.event==='race_resolution_v2')events.push(x);if(x.event==='race_resolution_v2_phase')phase=x.activePhase||'worker'; } catch {} }, error: console.error };
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
 worker = buildRaceResolutionWorkerV2({bootAt:0,processRole:'resolution',logger});
 post = buildRaceResolutionPostTaskRunner({logger});
 Client.prototype.query=function(...args){
  const text=typeof args[0]==='string'?args[0]:args[0]?.text;
  if(observed&&text){observed.sql++; const k=phase+' '+text.replace(/\s+/g,' ').slice(0,220);observed.queries[k]=(observed.queries[k]||0)+1;if(/step_samples|durable_capture_/i.test(text))observed.sourceSql++;}
  return original.apply(this,args);
 };
 server=await getSharedServer();
});
beforeEach(async()=>{
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
 const race=await prisma.race.create({data:{creatorId:viewer.user.id,name:'Read-only progress',status:'ACTIVE',targetSteps:1000000,maxParticipants:null,
  startedAt:new Date(now-86400000),endsAt:new Date(now+86400000),timezone:'UTC',powerupsEnabled:true,powerupStepInterval:5000}});
 await prisma.raceParticipant.createMany({data:ids.map(userId=>({raceId:race.id,userId,status:'ACCEPTED',joinedAt:new Date(now-86400000)}))});
 await prisma.userScoringInputVersion.createMany({data:others.map(u=>({userId:u.id,generation:1n}))});
 await prisma.stepSample.createMany({data:others.map(u=>({userId:u.id,periodStart:new Date(now-7200000),periodEnd:new Date(now-3600000),steps:50}))});
 const sample={periodStart:new Date(now-7200000).toISOString(),periodEnd:new Date(now-3600000).toISOString(),steps:50};
 const f={race,viewer,sample,size};await upload(f,50);await drain(f);
 assert.equal((await prisma.raceParticipant.findFirst({where:{raceId:race.id,userId:viewer.user.id}})).nextBoxAtSteps,5000,"queue must initialize the box gate without a screen read");return f;
}
async function upload(f,steps){
 const r=await request(server.baseUrl,'POST','/steps/sync-v2',{token:f.viewer.token,headers:{'Idempotency-Key':randomUUID(),'X-Timezone':'UTC'},
 body:{date:new Date().toISOString().slice(0,10),steps,samples:[{...f.sample,steps}]}});
 assert.equal(r.status,202,JSON.stringify(r.body));
}
async function drain(f){
 for(let i=0;i<5;i++){
  const row=await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}});
  if(row?.state==='QUEUED'||row?.state==='RUNNING'){phase='worker';await worker.processRace({raceId:f.race.id});}
  phase='posttasks';
  await post.snapshotTick();await post.tick();
  const after=await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}});
  if(after?.state==='SUCCEEDED')return;
  await new Promise(r=>setTimeout(r,30));
 }
 assert.fail('fixture resolution did not drain');
}
const variants=[['/progress',{}],['/bootstrap',{'X-Client-Features':'race_bootstrap'}],['/progress?view=participants-v1&offset=0&limit=10',{'X-Client-Features':'race_participants_paging'}],['/bootstrap?view=participants-v1&offset=0&limit=10',{'X-Client-Features':'race_participants_paging,race_bootstrap_compact'}]];
async function publicRead(f,path='/progress',headers={}){
 const r=await request(server.baseUrl,'GET',`/races/${f.race.id}${path}`,{token:f.viewer.token,headers:{'X-Timezone':'UTC',...headers}});
 const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));assert.ok(b.progress,JSON.stringify(b));return b.progress;
}
async function observedReads(f){
 const jobBefore=await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}});
 const participantsBefore=await prisma.raceParticipant.findMany({where:{raceId:f.race.id},orderBy:{id:'asc'}});
 observed={sql:0,sourceSql:0,queries:{}};let results,metrics;
 try{results=await Promise.all(variants.map(([p,h])=>publicRead(f,p,h)));await new Promise(r=>setTimeout(r,80));metrics=observed;}finally{observed=null;}
 assert.deepEqual(await prisma.raceResolutionJobV2.findUnique({where:{raceId:f.race.id}}),jobBefore,'reads must not enqueue or change scoring jobs');
 assert.deepEqual(await prisma.raceParticipant.findMany({where:{raceId:f.race.id},orderBy:{id:'asc'}}),participantsBefore,'reads must not write scores or box gates');
 assert.equal(metrics.sourceSql,0,'reads must not query step samples or captures');
 return {results,metrics};
}
it('fresh, expired, and Redis-off progress/bootstrap reads never score or enqueue',{timeout:60000},async(t)=>{
 await appSettings.setFlag('apiRaceBootstrapV1Enabled',true);
 const f=await fixture(10);
 const fresh=await observedReads(f);
 await new Promise(r=>setTimeout(r,16050));
 const expired=await observedReads(f);
 for(const p of expired.results){assert.equal(p.participants.find(x=>x.userId===f.viewer.user.id).totalSteps,50);assert.equal(p.powerupData.stepsUntilNextPowerup,4950);}
 await appSettings.setFlag('redisStandingsEnabled',false);
 const off=await observedReads(f);
 for(const p of off.results)assert.equal(p.powerupData.stepsUntilNextPowerup,4950);
 t.diagnostic(JSON.stringify({fresh:fresh.metrics.sql,expired:expired.metrics.sql,redisOff:off.metrics.sql,requestsPerSample:variants.length}));
 // Only the intake + queue advances scores and awards a crossed box.
 await upload(f,5100);await drain(f);
 assert.equal(await prisma.racePowerup.count({where:{raceId:f.race.id,userId:f.viewer.user.id,status:'MYSTERY_BOX'}}),1,'queue awards the box before any GET');
 const after=await observedReads(f);
 for(const p of after.results){assert.equal(p.participants.find(x=>x.userId===f.viewer.user.id).totalSteps,5100);assert.equal(p.powerupData.stepsUntilNextPowerup,4900);assert.ok(p.powerupData.inventory.some(x=>x.status==='MYSTERY_BOX'));}
 const abroad=await publicRead(f,'/progress',{'X-Timezone':'Pacific/Auckland'});
 assert.equal(abroad.powerupData.stepsUntilNextPowerup,4900,'viewer timezone cannot change committed box progress');
 await upload(f,4000);await drain(f);
 const corrected=await observedReads(f);
 const row=await prisma.raceParticipant.findFirst({where:{raceId:f.race.id,userId:f.viewer.user.id}});
 assert.equal(row.boxProgressSteps,4000,'canonical box progress must accept downward corrections');
 for(const p of corrected.results){assert.equal(p.powerupData.stepsUntilNextPowerup,5000);assert.equal(p.powerupData.inventory.filter(x=>x.status==='MYSTERY_BOX').length,1);}

});
it('cold first screen and an uninitialized box gate do not create a scoring obligation',async()=>{
 await appSettings.setFlag('apiRaceBootstrapV1Enabled',true);
 const viewer=await createTestUser(),at=Date.now();
 const race=await prisma.race.create({data:{creatorId:viewer.user.id,name:'Cold read',status:'ACTIVE',targetSteps:50000,startedAt:new Date(at-3600000),endsAt:new Date(at+86400000),timezone:'UTC',powerupsEnabled:true,powerupStepInterval:5000}});
 await prisma.raceParticipant.create({data:{raceId:race.id,userId:viewer.user.id,status:'ACCEPTED'}});
 const f={viewer,race,size:1};
 assert.equal(await prisma.raceResolutionJobV2.findUnique({where:{raceId:race.id}}),null);
 await observedReads(f);
});
