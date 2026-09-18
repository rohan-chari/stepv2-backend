const observation=require('./fixtures/query-efficiency/observe-cpu-remediation.cjs');
const assert=require('node:assert/strict');const {test}=require('node:test');
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
test('legacy and current public lists keep viewer permissions while one stable prepared overlay serves growing responses',async()=>{
 await cleanDatabase();observation.events.length=0;
 const server=await getSharedServer(),other=await createTestUser();
 let viewer,lastCompleted;
 const now=new Date(),past=new Date(+now-86400000);
 for(let count=1;count<=5;count++){
  // Fresh viewer identities force a real first list read even with Redis live;
  // fixture SQL is not assumed to invalidate an already-cached public response.
  viewer=await createTestUser();
  const ids=[];
  for(let row=0;row<count;row++){
  const race=await prisma.race.create({data:{creatorId:viewer.user.id,name:`Viewer ${count}`,status:'COMPLETED',targetSteps:1000,startedAt:past,endsAt:now,completedAt:now}});
  await prisma.raceParticipant.create({data:{raceId:race.id,userId:viewer.user.id,status:'ACCEPTED',totalSteps:1000,placement:1,finishedAt:now}});ids.push(race.id);lastCompleted=race.id;
  }
  for(const features of [null,'api_payload_compact_v1,race_participants_paging,race_preview,privacy_safe_display_ranks']){
   const response=await request(server.baseUrl,'GET','/races',{token:viewer.token,headers:features?{'X-Client-Features':features}:{}});
   assert.equal(response.status,200);const body=await response.json();
   for(const id of ids){const row=body.completed.find(row=>row.id===id);assert.ok(row);assert.equal(row.rematchEligible,true);}
  }
 }
 for(let i=0;i<5;i++)await prisma.race.create({data:{creatorId:other.user.id,name:`Public ${i}`,status:'PENDING',targetSteps:1000,isPublic:true,maxParticipants:10}});
 for(const features of ['home_suggested_races','home_suggested_races,team_races,tournaments']){
  const response=await request(server.baseUrl,'GET','/home/suggested-races',{token:viewer.token,headers:{'X-Client-Features':features,'X-Timezone':'UTC'}});assert.equal(response.status,200);
  assert.equal((await response.json()).suggestions.filter(row=>row.kind==='PUBLIC_RACE').length,4);
 }
 // The same cached/public detail core must still receive distinct viewer
 // permissions. An invitation grants read access, not accepted-member rights.
 await prisma.raceParticipant.create({data:{raceId:lastCompleted,userId:other.user.id,status:'INVITED'}});
 const unrelated=await createTestUser();
 for(const [account,eligible] of [[viewer,true],[other,false]]){
  for(const features of [null,'recurring_races_v1']){
   const response=await request(server.baseUrl,'GET',`/races/${lastCompleted}`,{token:account.token,headers:features?{'X-Client-Features':features}:{}});
   assert.equal(response.status,200);assert.equal((await response.json()).rematchEligible,eligible);
  }
 }
 const denied=await request(server.baseUrl,'GET',`/races/${lastCompleted}`,{token:unrelated.token});assert.equal(denied.status,403);
 const unrelatedList=await request(server.baseUrl,'GET','/races',{token:unrelated.token});assert.equal(unrelatedList.status,200);
 const unrelatedBody=await unrelatedList.json();assert.equal(['active','pending','completed'].flatMap(key=>unrelatedBody[key]||[]).some(row=>row.id===lastCompleted),false);
 const occurrence=await prisma.race.create({data:{creatorId:viewer.user.id,name:'Viewer series',status:'PENDING',targetSteps:1000,maxDurationDays:1}});
 const series=await prisma.raceSeries.create({data:{creatorId:viewer.user.id,settings:{},currentRaceId:occurrence.id}});
 await prisma.race.update({where:{id:occurrence.id},data:{seriesId:series.id}});
 await prisma.raceParticipant.createMany({data:[{raceId:occurrence.id,userId:viewer.user.id,status:'ACCEPTED'},{raceId:occurrence.id,userId:other.user.id,status:'INVITED'}]});
 await prisma.raceSeriesSubscription.create({data:{seriesId:series.id,userId:viewer.user.id,active:true}});
 for(const [account,privileged] of [[viewer,true],[other,false]]){
  const response=await request(server.baseUrl,'GET',`/races/${occurrence.id}`,{token:account.token,headers:{'X-Client-Features':'recurring_races_v1'}});
  assert.equal(response.status,200);assert.deepEqual((await response.json()).series,{id:series.id,enabled:true,subscribed:privileged,canManage:privileged});
 }
 const overlay=observation.events.filter(row=>row.family==='viewer-overlay');assert.ok(overlay.length>=5);
 assert.equal(new Set(overlay.map(row=>row.query)).size,1,'growing response lists must bind an array, preserving one admitted shape');
 for(const family of ['viewer-overlay','race-discovery','tournament-discovery']){
  const queries=observation.events.filter(row=>row.family===family);assert.ok(queries.length,`${family} must run through public HTTP`);
  assert.ok(queries.every(row=>/^steps_read_v1_[a-f0-9]{48}$/.test(row.name||'')),`${family} must reach named preparation`);
 }
});
