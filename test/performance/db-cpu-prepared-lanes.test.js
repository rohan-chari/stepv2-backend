const observation=require('./fixtures/query-efficiency/observe-cpu-remediation.cjs');
const assert=require('node:assert/strict');const {test}=require('node:test');
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS='0';process.env.RACE_RESOLVE_DEBOUNCE_MS='0';
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
const {buildRaceResolutionWorkerV2}=require('../../src/modules/races/jobs/raceResolutionQueueV2');
const {buildRaceEffectDeadlineScheduler}=require('../../src/modules/races/jobs/raceEffectDeadlineScheduler');
test('full recovery and snapshot repair lanes preserve public progress and use stable named SQL',async()=>{
 await cleanDatabase();observation.events.length=0;
 const server=await getSharedServer(),account=await createTestUser({timezone:'UTC'}),now=Date.now();
 const race=await prisma.race.create({data:{creatorId:account.user.id,name:'Prepared recovery',status:'ACTIVE',targetSteps:1000000,startedAt:new Date(now-7200000),endsAt:new Date(now+86400000),powerupsEnabled:false}});
 await prisma.raceParticipant.create({data:{raceId:race.id,userId:account.user.id,status:'ACCEPTED',joinedAt:new Date(now-7200000)}});
 const accepted=await request(server.baseUrl,'POST','/steps/samples',{token:account.token,headers:{'X-Timezone':'UTC'},body:{samples:[{periodStart:new Date(now-3600000).toISOString(),periodEnd:new Date(now-1800000).toISOString(),steps:100}]}});assert.equal(accepted.status,200);
 // Simulate an older producer's conservative FULL envelope, the exact durable
 // recovery input supported by the current worker alongside ordinary intake.
 await prisma.raceResolutionJobV2.update({where:{raceId:race.id},data:{dirtyReasons:['FULL']}});
 const worker=buildRaceResolutionWorkerV2({bootAt:0});assert.ok(await worker.processOne());
 await buildRaceEffectDeadlineScheduler().tick();
 const response=await request(server.baseUrl,'GET',`/races/${race.id}/progress`,{token:account.token,headers:{'X-Client-Features':'powerups2,powerups3,powerups4,powerups5'}});assert.equal(response.status,200);
 assert.equal((await response.json()).progress.participants.find(p=>p.userId===account.user.id).totalSteps,100);
 for(const family of ['full-trigger-drain','snapshot-repair-claim','seeded-preparation']){
  const rows=observation.events.filter(row=>row.family===family);assert.ok(rows.length,`${family} must execute via the actual worker`);
  assert.ok(rows.every(row=>/^steps_(read|query)_v1_[a-f0-9]{48}$/.test(row.name||'')),`${family} must be admitted to bounded preparation`);
 }
});
