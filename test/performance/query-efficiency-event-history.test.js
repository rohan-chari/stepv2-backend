process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const target=new URL(process.env.DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
let server;after(async()=>{if(server)await server.close();await prisma.$disconnect();});
test('progress filters historical race impacts to eligible entitlements',async()=>{
 await cleanDatabase();const viewer=await createTestUser({timezone:'UTC'});const now=new Date();
 const race=await prisma.race.create({data:{name:'Event history',creatorId:viewer.user.id,status:'ACTIVE',targetSteps:1000000,startedAt:new Date(+now-3600000),endsAt:new Date(+now+86400000),powerupsEnabled:true}});
 await prisma.raceParticipant.create({data:{raceId:race.id,userId:viewer.user.id,status:'ACCEPTED',joinedAt:race.startedAt,buyInStatus:'NONE'}});
 const events=Array.from({length:1000},(_,i)=>({id:randomUUID(),scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2,startsAt:new Date(+now-(i+1)*86400000),endsAt:new Date(+now-i*86400000)}));
 await prisma.globalStepEvent.createMany({data:events});
 await prisma.globalStepEventEntitlement.createMany({data:events.map(e=>({eventId:e.id,userId:viewer.user.id,timezone:'UTC',localDate:e.startsAt.toISOString().slice(0,10),startsAt:e.startsAt,endsAt:e.endsAt,startOutcome:'ACTIVATED_ON_TIME'}))});
 await prisma.globalEventRaceImpact.createMany({data:events.map(e=>({eventId:e.id,raceId:race.id,userId:viewer.user.id,status:'ENROLLED'}))});
 for(const table of ['global_event_race_impacts','global_step_event_entitlements'])await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
 await prisma.stepSample.create({data:{userId:viewer.user.id,periodStart:new Date(+now-30*60000),periodEnd:new Date(+now-20*60000),steps:100}});
 server=await getSharedServer();const queries=[];prisma.$on('query',e=>queries.push(e));
 const response=await request(server.baseUrl,'GET',`/races/${race.id}/progress`,{token:viewer.token,headers:{'X-Timezone':'UTC'}});assert.equal(response.status,200);const body=await response.json();assert.equal(body.progress.participants.find(p=>p.userId===viewer.user.id).totalSteps,200);
 const scans=queries.filter(q=>q.query.includes('FROM "public"."global_event_race_impacts"')&&q.query.includes('"status"'));
 assert.ok(scans.length,'observe eligibility impact lookup through HTTP progress');
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try{
  const old='SELECT id,event_id AS "eventId",user_id AS "userId",status FROM global_event_race_impacts WHERE race_id=$1 AND user_id=$2';
  const candidate=old+' AND event_id=ANY($3::text[])';
  const parameters=[race.id,viewer.user.id];
  const a=await db.query(old,parameters),b=await db.query(candidate,[...parameters,[events[0].id]]);
  assert.deepEqual(b.rows,a.rows.filter(r=>r.eventId===events[0].id));
  const plan=async(sql,params)=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
  const comparisons=[];for(let i=0;i<3;i++){const a=await plan(old,parameters),b=await plan(candidate,[...parameters,[events[0].id]]);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks'],beforeRows:a.Plan['Actual Rows'],afterRows:b.Plan['Actual Rows']});}
  console.log(JSON.stringify({experiment:'event history',comparisons}));
  for(const comparison of comparisons)assert.ok(comparison.afterHits<comparison.beforeHits*.5);
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1'){
   for(const scan of scans){const actual=await plan(scan.query,JSON.parse(scan.params));assert.ok(actual.Plan['Actual Rows']<=1,'HTTP eligibility must avoid historical impact transfer');}
  }
  await prisma.raceParticipant.updateMany({where:{raceId:race.id},data:{joinedAt:new Date(+now-25*60000)}});
  const late=await request(server.baseUrl,'GET',`/races/${race.id}/progress`,{token:viewer.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(late.status,200);assert.equal((await late.json()).progress.participants.find(p=>p.userId===viewer.user.id).totalSteps,100);
  await prisma.raceParticipant.updateMany({where:{raceId:race.id},data:{joinedAt:race.startedAt}});
  await prisma.globalEventRaceImpact.deleteMany({where:{eventId:events[0].id}});
  const absent=await request(server.baseUrl,'GET',`/races/${race.id}/progress`,{token:viewer.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(absent.status,200);assert.equal((await absent.json()).progress.participants.find(p=>p.userId===viewer.user.id).totalSteps,100);
  await prisma.globalStepEventEntitlement.updateMany({where:{userId:viewer.user.id},data:{startOutcome:'PENDING'}});
  queries.length=0;
  const empty=await request(server.baseUrl,'GET',`/races/${race.id}/progress`,{token:viewer.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(empty.status,200);assert.equal((await empty.json()).progress.participants.find(p=>p.userId===viewer.user.id).totalSteps,100);
  assert.equal(queries.filter(q=>q.query.includes('FROM "public"."global_event_race_impacts"')&&q.query.includes('"status"')).length,0,'empty eligibility skips impact lookup');
 }finally{await db.end();}
});
