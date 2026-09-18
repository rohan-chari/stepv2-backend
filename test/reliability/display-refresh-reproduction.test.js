// Diagnostic reproduction, not a change to refresh policy. Public reads and
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
  if(row?.state==='QUEUED'||row?.state==='RUNNING'){phase='worker';await worker.processRace({raceId:f.race.id});}
  phase='posttasks';
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
 const start=events.length,m={sql:0,sourceSql:0,queries:{}};phase='http-and-harness';observed=m;const at=performance.now();
 try{const response=await read(f);await new Promise(r=>setTimeout(r,50));await drain(f);return {...m,wallMs:performance.now()-at,response,attempts:events.slice(start).map(e=>({plan:e.resolutionPlan,reasons:e.reasonClasses,changedRows:e.changedRows,coreMs:e.coreMs}))};}
 finally{observed=null;}
}
for(const size of [10,100])it(`${size} participants: compare fresh and >15s-old reads with unchanged source steps`,{timeout:90000},async(t)=>{
 const f=await fixture(size);
 const initial=await measured(f);
 assert.deepEqual(initial.attempts,[],'fresh snapshot must not trigger resolution');
 await new Promise(r=>setTimeout(r,16050));
 const stale=await measured(f);
 assert.equal(Object.entries(stale.queries).filter(([q])=>q.includes('race_participants\".\"id\", \"public\".\"race_participants\".\"user_id\", \"public\".\"race_participants\".\"joined_at\" FROM')).reduce((n,[q,count])=>n+count,0),0,'no entitlement means no membership lookup');
 assert.deepEqual(stale.response,initial.response,'same source inputs preserve displayed totals');
 assert.deepEqual(stale.attempts,[],'expired display cache must not trigger scoring');
 assert.ok(stale.attempts.every(e=>e.changedRows===0),'refresh has no participant total/bonus writes');
 await new Promise(r=>setTimeout(r,16050));
 const repeated=await measured(f);
 assert.deepEqual(repeated.response,initial.response);
 assert.deepEqual(repeated.attempts,[],'repeated unchanged reads must never trigger scoring');
 assert.ok(repeated.attempts.every(e=>e.changedRows===0));
 t.diagnostic(JSON.stringify({size,repeated:{...repeated,response:undefined},fresh:{...initial,response:undefined},stale:{...stale,response:undefined}}));
 await upload(f,125);await drain(f);
 const changed=await read(f);
 assert.equal(changed.find(p=>p.userId===f.viewer.user.id).totalSteps,125,'real step correction must reach the client');
});

it('snapshot priority lane finishes an empty HTTP-generated task without a delivery pass',async()=>{
 const f=await fixture(2);
 await upload(f,125);await worker.processRace({raceId:f.race.id});
 const taskId=await post.snapshotTick();assert.ok(taskId);
 const task=await prisma.raceResolutionPostTask.findUniqueOrThrow({where:{id:taskId}});
 assert.equal(task.state,'succeeded','empty snapshot task must finish without a second queue claim');
 assert.equal(task.snapshotState,'succeeded');
 assert.ok(await prisma.raceResolutionPostTaskReceipt.findUnique({where:{raceId_sourceGeneration:{raceId:f.race.id,sourceGeneration:task.sourceGeneration}}}));
 const rows=await read(f);assert.equal(rows.find(p=>p.userId===f.viewer.user.id).totalSteps,125);
});
it('snapshot lane preserves delivery despite stale zero intent metadata',async()=>{
 const f=await fixture(2);await upload(f,125);await worker.processRace({raceId:f.race.id});
 const task=await prisma.raceResolutionPostTask.findFirstOrThrow({where:{raceId:f.race.id,state:'queued'},orderBy:{sourceGeneration:'desc'}});
 await prisma.raceResolutionDeliveryIntent.create({data:{taskId:task.id,ordinal:0,kind:'STATE_NOTIFICATION',recipientUserId:null,payload:{},payloadBytes:2,deliveryKeyHash:require('node:crypto').createHash('sha256').update(randomUUID()).digest('hex'),state:'pending'}});
 assert.equal(task.intentCount,0);
 assert.equal(await post.snapshotTick(),task.id);
 const published=await prisma.raceResolutionPostTask.findUniqueOrThrow({where:{id:task.id}});
 assert.equal(published.state,'queued');assert.equal(published.snapshotState,'succeeded');
 await post.tick();
 const done=await prisma.raceResolutionPostTask.findUniqueOrThrow({where:{id:task.id}});
 assert.equal(done.state,'succeeded_with_failures');
});
it('snapshot lane rolls back combined completion on an immutable receipt collision',async()=>{
 const f=await fixture(2);await upload(f,125);await worker.processRace({raceId:f.race.id});
 const task=await prisma.raceResolutionPostTask.findFirstOrThrow({where:{raceId:f.race.id,state:'queued'},orderBy:{sourceGeneration:'desc'}});
 const originalReceipt=await prisma.raceResolutionPostTaskReceipt.create({data:{raceId:f.race.id,sourceGeneration:task.sourceGeneration,dedupeKey:task.dedupeKey,terminalState:'succeeded',snapshotState:'succeeded',intentCount:0,failureCount:0,completedAt:new Date(Date.now()-60000)}});
 await assert.rejects(post.snapshotTick(),/post-task receipt immutable identity mismatch/);
 const pending=await prisma.raceResolutionPostTask.findUniqueOrThrow({where:{id:task.id}});
 assert.equal(pending.completedAt,null);assert.equal(pending.snapshotCompletedAt,null);assert.equal(pending.snapshotState,'attempting');
 assert.deepEqual(await prisma.raceResolutionPostTaskReceipt.findUnique({where:{raceId_sourceGeneration:{raceId:f.race.id,sourceGeneration:task.sourceGeneration}}}),originalReceipt);
 await assert.rejects(post.tick(),/post-task receipt immutable identity mismatch/);
 const recovered=await prisma.raceResolutionPostTask.findUniqueOrThrow({where:{id:task.id}});
 assert.equal(recovered.snapshotAttemptId,pending.snapshotAttemptId,'receipt failure must not retry publication');
});
