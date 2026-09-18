process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
let server;
after(async()=>{if(server)await server.close();await prisma.$disconnect();});
const sqlFile=name=>fs.readFileSync(path.join(__dirname,'fixtures/query-efficiency',name),'utf8');

for (const scenario of ['mostly-full','mostly-open','unlimited']) test(`suggestions preserve HTTP results and reduce work: ${scenario}`, async()=>{
 await cleanDatabase();
 const viewer=await createTestUser({displayName:'Viewer'});
 const users=await Promise.all(Array.from({length:40},(_,i)=>createTestUser({displayName:`Member ${i}`})));
 const races=[];
 for(let i=0;i<80;i++) races.push({id:`eff-suggestion-${String(i).padStart(3,'0')}`,name:`Candidate ${i}`,targetSteps:10000,status:'PENDING',maxDurationDays:1,buyInAmount:0,payoutPreset:'TOP_HALF',powerupsEnabled:true,powerupStepInterval:2000,isPublic:true,maxParticipants:scenario==='unlimited'?null:scenario==='mostly-full'&&i<70?40:41,timeBased:true,createdAt:new Date(Date.UTC(2026,0,1,0,80-i))});
 await prisma.race.createMany({data:races});
 await prisma.raceParticipant.createMany({data:races.flatMap((r,i)=>users.slice(0,scenario==='mostly-full'?40:1+i%40).map(({user})=>({raceId:r.id,userId:user.id,status:'ACCEPTED',buyInStatus:'NONE'})))});
 // Remove dead fixture tuples before comparing plans; earlier suites delete large rosters.
 for(const table of ['races','race_participants','users'])await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`);
 server=await getSharedServer();
 let captured=[];prisma.$on('query',e=>captured.push(e));
 const response=await request(server.baseUrl,'GET','/home/suggested-races',{token:viewer.token,headers:{'X-Client-Features':'home_suggested_races,team_races','X-Timezone':'UTC'}});
 assert.equal(response.status,200);
 const body=await response.json();
 const offset=scenario==='mostly-full'?70:0;
 assert.deepEqual(body.suggestions.filter(r=>r.kind==='PUBLIC_RACE').map(r=>r.id),races.slice(offset,offset+4).map(r=>r.id));
 const emitted=captured.find(e=>e.query.includes('r.is_public = TRUE') && e.query.includes('AS \"payoutPreset\"'));
 assert.ok(emitted,'capture actual public suggestion SQL from HTTP');
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try {
  const before=sqlFile('public-suggestions-before.sql'), candidate=sqlFile('public-suggestions-candidate.sql');
  const params=[viewer.user.id,4];
  const [oldRows,newRows]=await Promise.all([db.query(before,params),db.query(candidate,params)]);
  assert.deepEqual(newRows.rows,oldRows.rows,'all SQL projection fields must be identical');
  const plan=async(q,p)=> (await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+q,p)).rows[0]['QUERY PLAN'][0];
  // Alternate repeated trials to reduce cache/order bias. Buffer work is the
  // deterministic gate; elapsed time is recorded, not a flaky CI threshold.
  const comparisons=[];
  for(let i=0;i<3;i++){const a=await plan(before,params),b=await plan(candidate,params);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
  console.log(JSON.stringify({experiment:'public suggestions',scenario,comparisons}));
  for(const p of comparisons)assert.ok(p.afterHits<p.beforeHits*.8,'candidate must save >20% buffer work');
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1'){
   const actual=await plan(emitted.query,JSON.parse(emitted.params));
   assert.ok(actual.Plan['Shared Hit Blocks']<comparisons[0].beforeHits*.8,'HTTP path must use the proven improvement');
  }
 }finally{await db.end();}
});
