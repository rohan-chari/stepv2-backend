process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const fs=require('node:fs'),path=require('node:path');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
let server;after(async()=>{if(server)await server.close();await prisma.$disconnect();});
const sqlFile=name=>fs.readFileSync(path.join(__dirname,'fixtures/query-efficiency',name),'utf8');
test('active event lookup stays indexed amid unrelated users and preserves banner',async()=>{
 await cleanDatabase();const viewer=await createTestUser({globalEventTimezone:'UTC'}),outsider=await createTestUser();
 const at=new Date();const races=Array.from({length:60},(_,i)=>({id:randomUUID(),name:`Badge ${i}`,creatorId:viewer.user.id,status:'ACTIVE',targetSteps:10000,startedAt:new Date(at-3600000),endsAt:new Date(+at+86400000)}));
 await prisma.race.createMany({data:races});await prisma.raceParticipant.createMany({data:races.map(r=>({raceId:r.id,userId:viewer.user.id,status:'ACCEPTED',buyInStatus:'NONE'}))});
 const events=Array.from({length:22},(_,i)=>({id:randomUUID(),startsAt:new Date(+at-3600000+i*60000),endsAt:new Date(+at+3600000+i*60000),scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2}));
 await prisma.globalStepEvent.createMany({data:events});
 await prisma.globalStepEvent.createMany({data:Array.from({length:83},(_,i)=>({startsAt:new Date(+at-(i+2)*86400000),endsAt:new Date(+at-(i+1)*86400000),scheduleMode:'LEGACY_GLOBAL',multiplier:2}))});await prisma.globalStepEventEntitlement.createMany({data:events.map(e=>({eventId:e.id,userId:viewer.user.id,timezone:'UTC',localDate:at.toISOString().slice(0,10),startsAt:e.startsAt,endsAt:e.endsAt,startOutcome:'ACTIVATED_ON_TIME'}))});
 await prisma.globalEventRaceImpact.createMany({data:events.flatMap(e=>races.map(r=>({eventId:e.id,userId:viewer.user.id,raceId:r.id,status:'ENROLLED'})))});
 await prisma.globalStepEventEntitlement.createMany({data:events.map(e=>({eventId:e.id,userId:outsider.user.id,timezone:'UTC',localDate:at.toISOString().slice(0,10),startsAt:e.startsAt,endsAt:e.endsAt,startOutcome:'ACTIVATED_ON_TIME'}))});
 const unrelated=Array.from({length:1000},(_,i)=>({id:randomUUID(),appleId:`badge-unrelated-${i}`}));
 await prisma.user.createMany({data:unrelated});
 await prisma.globalStepEventEntitlement.createMany({data:unrelated.flatMap(u=>events.map(e=>({eventId:e.id,userId:u.id,timezone:'UTC',localDate:at.toISOString().slice(0,10),startsAt:e.startsAt,endsAt:e.endsAt,startOutcome:'ACTIVATED_ON_TIME'})))});
 for(const t of ['race_participants','races','global_step_event_entitlements','global_event_race_impacts','global_step_events'])await prisma.$executeRawUnsafe(`ANALYZE ${t}`);
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try{
  const old=sqlFile('active-event-candidate.sql'),candidate=sqlFile('active-event-lateral-candidate.sql');
  const input=JSON.stringify([{userId:viewer.user.id,at:at.toISOString()},{userId:outsider.user.id,at:at.toISOString()}]);
  for(const raceId of [null,races[0].id,'missing']){
   const a=await db.query(old,[input,raceId]),b=await db.query(candidate,[input,raceId]);assert.deepEqual(b.rows,a.rows);
   if(raceId!=='missing')assert.equal(b.rows[0].eventId,events.at(-1).id);
  }
  const plan=async(sql,params)=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
  const comparisons=[];for(let i=0;i<3;i++){const a=await plan(old,[input,null]),b=await plan(candidate,[input,null]);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
  console.log(JSON.stringify({experiment:'indexed active event',comparisons}));for(const p of comparisons)assert.ok(p.afterHits<p.beforeHits*.8,'indexed per-user lookup must avoid unrelated entitlement scan');
  server=await getSharedServer();const captured=[];prisma.$on('query',e=>captured.push(e));
  const response=await request(server.baseUrl,'GET','/home/race-card',{token:viewer.token,headers:{'X-Timezone':'UTC'}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.globalEvent?.active,true);assert.equal(body.globalEvent.multiplier,2);assert.equal(body.globalEvent.endsAt,events.at(-1).endsAt.toISOString());
  const emitted=captured.find(e=>e.query.includes('DISTINCT ON (requested."userId")'));assert.ok(emitted,'real HTTP banner lookup observed');
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1'){
   const actual=await plan(emitted.query,JSON.parse(emitted.params));const baseline=await plan(old,JSON.parse(emitted.params));assert.ok(actual.Plan['Shared Hit Blocks']<baseline.Plan['Shared Hit Blocks']*.8,'HTTP must execute indexed per-user query');
  }
  const noMembershipStart=captured.length;
  const noMembership=await request(server.baseUrl,'GET','/home/race-card',{token:outsider.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(noMembership.status,200);assert.notEqual((await noMembership.json()).globalEvent?.active,true);
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1') {
   const noMembershipQuery=captured.slice(noMembershipStart).find(e=>e.query.includes('DISTINCT ON (requested."userId")'));
   assert.ok(noMembershipQuery,'no-race HTTP banner query observed');
   const parameters=JSON.parse(noMembershipQuery.params),actual=await plan(noMembershipQuery.query,parameters),baseline=await plan(old,parameters);
   assert.ok(actual.Plan['Shared Hit Blocks']<baseline.Plan['Shared Hit Blocks']*.2,'HTTP without active membership skips event impact probes');
  }
  // A newer entitlement without race eligibility must not hide the older event.
  await prisma.globalEventRaceImpact.deleteMany({where:{eventId:events.at(-1).id,userId:viewer.user.id}});
  const olderResponse=await request(server.baseUrl,'GET','/home/race-card',{token:viewer.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(olderResponse.status,200);assert.equal((await olderResponse.json()).globalEvent.endsAt,events.at(-2).endsAt.toISOString());
  await prisma.globalEventRaceImpact.createMany({data:races.map(r=>({eventId:events.at(-1).id,userId:viewer.user.id,raceId:r.id,status:'ENROLLED'}))});
  await prisma.raceParticipant.create({data:{raceId:races[0].id,userId:outsider.user.id,status:'ACCEPTED',buyInStatus:'NONE'}});
  const memberWithoutImpact=await request(server.baseUrl,'GET','/home/race-card',{token:outsider.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(memberWithoutImpact.status,200);assert.notEqual((await memberWithoutImpact.json()).globalEvent?.active,true);
  await prisma.globalEventRaceImpact.create({data:{eventId:events[0].id,userId:outsider.user.id,raceId:races[0].id,status:'ENROLLED'}});
  const secondViewer=await request(server.baseUrl,'GET','/home/race-card',{token:outsider.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(secondViewer.status,200);assert.equal((await secondViewer.json()).globalEvent.endsAt,events[0].endsAt.toISOString());
  const duplicateRequests=[
   {userId:viewer.user.id,at:at.toISOString()},
   {userId:viewer.user.id,at:at.toISOString()},
   {userId:viewer.user.id,at:events[0].startsAt.toISOString()},
   {userId:viewer.user.id,at:events.at(-1).endsAt.toISOString()},
   {userId:outsider.user.id,at:at.toISOString()},
  ];
  const duplicateParams=[JSON.stringify(duplicateRequests),null];
  const duplicateOld=await db.query(old,duplicateParams),duplicateNew=await db.query(candidate,duplicateParams);
  assert.deepEqual(duplicateNew.rows,duplicateOld.rows);
  assert.equal(duplicateNew.rows.find(r=>r.userId===viewer.user.id).eventId,events.at(-1).id);
  assert.equal(duplicateNew.rows.find(r=>r.userId===outsider.user.id).eventId,events[0].id);
  const batchComparisons=[];
  for(const size of [1,32,256]) {
   const payload=JSON.stringify(unrelated.slice(0,size).map(u=>({userId:u.id,at:at.toISOString()})));
   assert.deepEqual((await db.query(candidate,[payload,null])).rows,(await db.query(old,[payload,null])).rows);
   const before=await plan(old,[payload,null]),after=await plan(candidate,[payload,null]);
   batchComparisons.push({size,beforeMs:before['Execution Time'],afterMs:after['Execution Time'],beforeHits:before.Plan['Shared Hit Blocks'],afterHits:after.Plan['Shared Hit Blocks']});
  }
  console.log(JSON.stringify({experiment:'indexed badge no-impact batches',batchComparisons}));
  for(const comparison of batchComparisons) assert.ok(comparison.afterHits<comparison.beforeHits*.2,'no-membership batches avoid per-event impact probes');
  // Exercise the same public banner path as race eligibility changes.
  for (const data of [
   {forfeitedAt:at},
   {forfeitedAt:null,finishedAt:at},
   {finishedAt:null,status:'INVITED'},
  ]) {
   await prisma.raceParticipant.updateMany({where:{userId:viewer.user.id},data});
   const result=await request(server.baseUrl,'GET','/home/race-card',{token:viewer.token,headers:{'X-Timezone':'UTC'}});
   assert.equal(result.status,200);assert.notEqual((await result.json()).globalEvent?.active,true);
  }
  await prisma.raceParticipant.updateMany({where:{userId:viewer.user.id},data:{status:'ACCEPTED'}});
  await prisma.race.updateMany({where:{id:{in:races.map(r=>r.id)}},data:{status:'PENDING'}});
  const inactive=await request(server.baseUrl,'GET','/home/race-card',{token:viewer.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(inactive.status,200);assert.notEqual((await inactive.json()).globalEvent?.active,true);
  await prisma.race.updateMany({where:{id:{in:races.map(r=>r.id)}},data:{status:'ACTIVE'}});
  // Exact boundary semantics are compared with the original SQL on real Postgres.
  for(const instant of [events[0].startsAt, new Date(+events[0].startsAt-1), events.at(-1).endsAt]) {
   const parameters=[JSON.stringify([{userId:viewer.user.id,at:instant.toISOString()}]),null];
   const before=await db.query(old,parameters),after=await db.query(candidate,parameters);
   assert.deepEqual(after.rows,before.rows);
   assert.equal(after.rows.length,instant===events[0].startsAt?1:0);
  }
 }finally{await db.end();}
});
