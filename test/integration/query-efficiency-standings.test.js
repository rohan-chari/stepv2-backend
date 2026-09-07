process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
let server;after(async()=>{if(server)await server.close();await prisma.$disconnect();});
test('standings narrow projection experiment through real compact race list',async()=>{
 await cleanDatabase();const viewer=await createTestUser();
 const now=new Date();const raceId=randomUUID();
 await prisma.race.create({data:{id:raceId,name:'Standings benchmark',creatorId:viewer.user.id,status:'ACTIVE',targetSteps:1000000,powerupsEnabled:true,startedAt:new Date(+now-3600000),endsAt:new Date(+now+86400000)}});
 const users=Array.from({length:1999},(_,i)=>({id:randomUUID(),email:`standings-${i}@example.test`,displayName:`Member ${i}`}));
 await prisma.user.createMany({data:users});
 await prisma.raceParticipant.createMany({data:[viewer.user,...users].map((u,i)=>({raceId,userId:u.id,status:'ACCEPTED',totalSteps:i*10,totalsUpdatedAt:now,joinedAt:new Date(+now-3600000+i),buyInStatus:'NONE'}))});
 for(const table of ['race_participants','races'])await prisma.$executeRawUnsafe(`ANALYZE ${table}`);
 for (const key of ['redisCacheRaceListEnabled','raceListSqlSummaryV1Enabled','apiRaceListCompactV1Enabled']) await prisma.appSetting.upsert({where:{key},create:{key,value:true},update:{value:true}});
 const queries=[];prisma.$on('query',e=>queries.push(e));server=await getSharedServer();
 const response=await request(server.baseUrl,'GET','/races?view=compact-v1',{token:viewer.token,headers:{'X-Client-Features':'characters,remote_assets,api_payload_compact_v1,race_participants_paging,team_races,tournaments,powerups3,powerups4,powerups5'}});
 assert.equal(response.status,200);const body=await response.json();const returned=body.active.find(r=>r.id===raceId);assert.ok(returned);assert.equal(returned.participantCount,2000);assert.equal(returned.myPlacement,2000);assert.equal(returned.myStatus,'ACCEPTED');
 const query=queries.find(e=>e.query.includes('WITH accepted AS'));assert.ok(query,'real HTTP standings SQL observed');
 const columns='rp.id, rp.race_id, rp.user_id, rp.finished_at, rp.placement, rp.total_steps, rp.joined_at, rp.team, rp.forfeited_at, rp.payout_coins, rp.totals_updated_at';
 const original=query.query.includes('rp.*')?query.query:query.query.replace(columns,'rp.*');
 const candidate=original.replace('rp.*',columns);assert.notEqual(candidate,original);
 const parameters=JSON.parse(query.params);const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try{
  assert.deepEqual((await db.query(candidate,parameters)).rows,(await db.query(original,parameters)).rows);
  const plan=async sql=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,parameters)).rows[0]['QUERY PLAN'][0];
  const sortMemory=node=>(node['Sort Space Type']==='Memory'?node['Sort Space Used']||0:0)+(node.Plans||[]).reduce((sum,child)=>sum+sortMemory(child),0);
  const comparisons=[];
  for(let i=0;i<5;i++){
   const a=await plan(original),b=await plan(candidate);
   comparisons.push({beforeSortKb:sortMemory(a.Plan),afterSortKb:sortMemory(b.Plan),beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks'],beforeTemp:a.Plan['Temp Written Blocks'],afterTemp:b.Plan['Temp Written Blocks']});
  }
  console.log(JSON.stringify({experiment:'standings projection',comparisons}));
  for(const comparison of comparisons) assert.ok(comparison.afterSortKb < comparison.beforeSortKb*.95,'candidate must reduce ranking sort memory');
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1') {
   const actual=await plan(query.query);
   assert.ok(sortMemory(actual.Plan)<comparisons[0].beforeSortKb*.95,'HTTP must execute narrower standings query');
  }
 }finally{await db.end();}
});
