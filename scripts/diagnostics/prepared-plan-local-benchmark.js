// Experiment only: real Prisma adapter and model SQL through local PgBouncer.
const assert = require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const pg=require('pg');
const {PrismaPg}=require('@prisma/adapter-pg');
const {PrismaClient}=require('@prisma/client');
const target=new URL(process.env.DATABASE_URL);
// Set this to the owned local PostgreSQL datadir; never a production process.
const pgDataDir=process.env.BENCHMARK_PG_DATA_DIR;
assert.ok(pgDataDir,'BENCHMARK_PG_DATA_DIR is required');
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55438');
assert.match(target.pathname,/_test$/);
const {buildRaceResolutionInputFingerprint}=require('../../src/modules/races/services/raceResolutionInputFingerprint');
const {findRowsForUserRangesOn}=require('../../src/modules/steps/models/stepSample');
const admin=new pg.Client({connectionString:target.toString()});
const seedPool=new pg.Pool({connectionString:target.toString()});
const seed=new PrismaClient({adapter:new PrismaPg(seedPool)});
const now=new Date('2026-09-08T00:00:00Z');
const users=Array.from({length:1000},()=>({id:randomUUID(),appleId:randomUUID(),timezone:'UTC'}));
const races=[];const events=[];const connections=[];
function connect(port,named) {
 const url=new URL(target);url.port=String(port);
 const pool=new pg.Pool({connectionString:url.toString(),max:6});
 const shapes=new Set();
 pool.on('connect',client=>{
  const original=client.query.bind(client);
  client.query=(query,...args)=>{
   if(named && query && typeof query==='object' && typeof query.text==='string') {
    assert.ok(shapes.has(query.text)||shapes.size<128,'experiment cache budget');
    shapes.add(query.text);
    query={...query,name:'bench_'+createHash('sha256').update(query.text).digest('hex').slice(0,48)};
   }
   return original(query,...args);
  };
 });
 const prisma=new PrismaClient({adapter:new PrismaPg(pool)});
 const result={pool,prisma,shapes};connections.push(result);return result;
}
const normalized=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const outputs=new Map();
async function unit(client,index,check=true) {
 const race=races[index%races.length];
 const presentation=Math.floor(index/4)%2===0;
 const result=await buildRaceResolutionInputFingerprint({raceId:race.id,now,client,includePresentation:presentation});
 assert.equal(result.participantCount,race.size);
 const bounds=users.slice(index%10,index%10+25).map((u,ordinal)=>({userId:u.id,ordinal,
  rangeStart:new Date(+now-(index%2+1)*86400000),rangeEnd:now}));
 const samples=await findRowsForUserRangesOn(client,bounds,{maxRows:50000});
 assert.ok(samples.length>0);
 const key=index%40;const value=normalized({result,samples});
 if(check && outputs.has(key))assert.equal(value,outputs.get(key),'fingerprint and sample result parity');
 else outputs.set(key,value);
 return samples.length;
}
async function stats() {
 return (await admin.query(`SELECT queryid::text,query,calls,plans,total_plan_time,total_exec_time FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_%'`)).rows;
}
function cpuSeconds() {
 const pid=Number(fs.readFileSync(require('node:path').join(pgDataDir,'postmaster.pid'),'utf8').split('\n')[0]);
 const rows=execFileSync('ps',['-axo','pid=,ppid=,time='],{encoding:'utf8'}).trim().split('\n');
 return rows.reduce((sum,line)=>{const [p,parent,time]=line.trim().split(/\s+/);if(+p!==pid&&+parent!==pid)return sum;
 const parts=time.split(':').map(Number);return sum+parts.reduce((a,v)=>a*60+v,0);},0);
}
async function measure(mode,connection,concurrency,round) {
 // Warm the connection/statement caches before taking each measurement.
 for(let i=0;i<40;i++)await unit(connection.prisma,i);
 const before=await stats(),old=new Map(before.map(r=>[r.queryid,r]));
 const cpu=cpuSeconds(),start=performance.now();const latencies=[];
 let next=0;const count=3000;
 await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=next++;if(i>=count)return;
 const at=performance.now();await unit(connection.prisma,i);latencies.push(performance.now()-at);}}));
 const wallMs=performance.now()-start,cpuMs=(cpuSeconds()-cpu)*1000,after=await stats();
 const delta=after.map(r=>{const p=old.get(r.queryid)||{};return {query:r.query,...Object.fromEntries(['calls','plans','total_plan_time','total_exec_time'].map(k=>[k,Number(r[k])-Number(p[k]||0)]))};}).filter(r=>r.calls>0);
 latencies.sort((a,b)=>a-b);
 const sum=k=>delta.reduce((a,r)=>a+r[k],0);
 console.log(JSON.stringify({type:'measurement',mode,round,concurrency,units:count,wallMs,cpuMs,
  unitsPerSecond:count*1000/wallMs,p50Ms:latencies[Math.floor(latencies.length*.5)],p95Ms:latencies[Math.floor(latencies.length*.95)],
  calls:sum('calls'),plans:sum('plans'),planningMs:sum('total_plan_time'),executionMs:sum('total_exec_time'),shapes:connection.shapes.size,
  queries:delta.map(r=>({...r,query:r.query.slice(0,100)}))}));
}
(async()=>{
 await admin.connect();await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
 await seed.user.createMany({data:users});
 await seed.userScoringInputVersion.createMany({data:users.map(u=>({userId:u.id,generation:1}))});
 await admin.query(`INSERT INTO step_samples(id,user_id,period_start,period_end,steps,created_at)
 SELECT md5(u || ':' || n),u,$2::timestamp+n*interval '50 minutes',$2::timestamp+(n+1)*interval '50 minutes',n%100,now()
 FROM unnest($1::text[]) u CROSS JOIN generate_series(0,799) n`,[users.map(u=>u.id),new Date(+now-28*86400000)]);
 for(const size of [1,25,100,500]) {
  const race=await seed.race.create({data:{creatorId:users[0].id,name:'Prepared plan experiment',status:'ACTIVE',startedAt:new Date(+now-7*86400000),endsAt:new Date(+now+86400000),targetSteps:1000000,powerupsEnabled:true}});
  races.push({id:race.id,size});await seed.raceParticipant.createMany({data:users.slice(0,size).map(u=>({raceId:race.id,userId:u.id,status:'ACCEPTED',joinedAt:new Date(+now-7*86400000)}))});
 }
 for(let i=0;i<105;i++){const event=await seed.globalStepEvent.create({data:{startsAt:new Date(+now-(i-2)*3600000),endsAt:new Date(+now-(i-3)*3600000),label:'Prepared plan fixture'}});events.push(event.id);}
 for(const table of ['step_samples','users','races','race_participants','global_step_events','user_scoring_input_versions'])await admin.query('ANALYZE '+table);
 const baseline=connect(56438,false),prepared=connect(56439,true);
 for(const concurrency of [1,3])for(let round=0;round<2;round++){
  const order=round%2? [['named',prepared],['unnamed',baseline]]:[['unnamed',baseline],['named',prepared]];
  for(const [mode,c] of order)await measure(mode,c,concurrency,round);
 }
 // Force transaction-pool backend replacement without replacing adapter clients.
 const poolAdmin=new pg.Client({host:'127.0.0.1',port:56439,user:target.username,database:'pgbouncer'});
 await poolAdmin.connect();
 try { await poolAdmin.query('RECONNECT steps_query_efficiency_test'); }
 finally { await poolAdmin.end(); }
 for(let i=0;i<40;i++)await unit(prepared.prisma,i);
 console.log(JSON.stringify({type:'compatibility',passed:true,case:'pool backend reconnect'}));
 // Additive DDL invalidates table plans; explicit selected fields stay compatible.
 await admin.query('ALTER TABLE races ADD COLUMN prepared_plan_probe integer');
 try { for(let i=0;i<40;i++)await unit(prepared.prisma,i); }
 finally { await admin.query('ALTER TABLE races DROP COLUMN prepared_plan_probe'); }
 for(let i=0;i<40;i++)await unit(prepared.prisma,i);
 console.log(JSON.stringify({type:'compatibility',passed:true,case:'add/drop unused column on races'}));
 // Verify real committed changes remain visible behind reused prepared plans.
 await seed.user.update({where:{id:users[0].id},data:{displayName:'Renamed fixture'}});
 for(const c of [baseline,prepared]){
  const r=await buildRaceResolutionInputFingerprint({raceId:races[0].id,now,client:c.prisma});
  assert.equal(r.participants[0].user.displayName,'Renamed fixture');
 }
 console.log(JSON.stringify({type:'parity',passed:true,case:'changed parameters, race sizes, committed rename'}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 for(const c of connections){await c.prisma.$disconnect();await c.pool.end();}
 await seed.raceParticipant.deleteMany({where:{raceId:{in:races.map(r=>r.id)}}});
 await seed.race.deleteMany({where:{id:{in:races.map(r=>r.id)}}});
 await seed.globalStepEvent.deleteMany({where:{id:{in:events}}});
 await seed.stepSample.deleteMany({where:{userId:{in:users.map(u=>u.id)}}});
 await seed.user.deleteMany({where:{id:{in:users.map(u=>u.id)}}});
 await seed.$disconnect();await seedPool.end();await admin.end();
 await require('../../src/db').prisma.$disconnect();
});
