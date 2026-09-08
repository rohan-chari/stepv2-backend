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
test('active event existence check preserves banner and reduces multi-race fanout',async()=>{
 await cleanDatabase();const viewer=await createTestUser({globalEventTimezone:'UTC'}),outsider=await createTestUser();
 const at=new Date();const races=Array.from({length:60},(_,i)=>({id:randomUUID(),name:`Badge ${i}`,creatorId:viewer.user.id,status:'ACTIVE',targetSteps:10000,startedAt:new Date(at-3600000),endsAt:new Date(+at+86400000)}));
 await prisma.race.createMany({data:races});await prisma.raceParticipant.createMany({data:races.map(r=>({raceId:r.id,userId:viewer.user.id,status:'ACCEPTED',buyInStatus:'NONE'}))});
 const events=Array.from({length:10},(_,i)=>({id:randomUUID(),startsAt:new Date(+at-3600000+i*60000),endsAt:new Date(+at+3600000+i*60000),scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2}));
 await prisma.globalStepEvent.createMany({data:events});await prisma.globalStepEventEntitlement.createMany({data:events.map(e=>({eventId:e.id,userId:viewer.user.id,timezone:'UTC',localDate:at.toISOString().slice(0,10),startsAt:e.startsAt,endsAt:e.endsAt,startOutcome:'ACTIVATED_ON_TIME'}))});
 await prisma.globalEventRaceImpact.createMany({data:events.flatMap(e=>races.map(r=>({eventId:e.id,userId:viewer.user.id,raceId:r.id,status:'ENROLLED'})))});
 for(const t of ['race_participants','races','global_step_event_entitlements','global_event_race_impacts'])await prisma.$executeRawUnsafe(`ANALYZE ${t}`);
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try{
  const old=sqlFile('active-event-before.sql'),candidate=sqlFile('active-event-candidate.sql');
  const input=JSON.stringify([{userId:viewer.user.id,at:at.toISOString()},{userId:outsider.user.id,at:at.toISOString()}]);
  for(const raceId of [null,races[0].id,'missing']){
   const a=await db.query(old,[input,raceId]),b=await db.query(candidate,[input,raceId]);assert.deepEqual(b.rows,a.rows);
   if(raceId!=='missing')assert.equal(b.rows[0].eventId,events.at(-1).id);
  }
  const plan=async(sql,params)=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
  const comparisons=[];for(let i=0;i<3;i++){const a=await plan(old,[input,null]),b=await plan(candidate,[input,null]);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
  console.log(JSON.stringify({experiment:'active event',comparisons}));for(const p of comparisons)assert.ok(p.afterHits<p.beforeHits*.8,'EXISTS must reduce fanout buffer work');
  server=await getSharedServer();const captured=[];prisma.$on('query',e=>captured.push(e));
  const response=await request(server.baseUrl,'GET','/home/race-card',{token:viewer.token,headers:{'X-Timezone':'UTC'}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.globalEvent?.active,true);assert.equal(body.globalEvent.multiplier,2);assert.equal(body.globalEvent.endsAt,events.at(-1).endsAt.toISOString());
  const emitted=captured.find(e=>e.query.includes('DISTINCT ON (requested."userId")'));assert.ok(emitted,'real HTTP banner lookup observed');
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1'){
   const actual=await plan(emitted.query,JSON.parse(emitted.params));const baseline=await plan(old,JSON.parse(emitted.params));assert.ok(actual.Plan['Shared Hit Blocks']<baseline.Plan['Shared Hit Blocks']*.8,'HTTP must execute improved query');
  }
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
