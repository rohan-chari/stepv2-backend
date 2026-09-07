process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
const {Client}=require('pg');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
let server;after(async()=>{if(server)await server.close();await prisma.$disconnect();});
for(const isTeamRace of [false,true]) test(`real resolution worker query trace and fence projection: team=${isTeamRace}`,{timeout:120000},async()=>{
 await cleanDatabase();const viewer=await createTestUser({timezone:'UTC',displayName:'Worker Viewer'});
 const now=new Date(),raceId=randomUUID(),startedAt=new Date(+now-8*3600000);
 await prisma.race.create({data:{id:raceId,name:'Worker trace',creatorId:viewer.user.id,status:'ACTIVE',targetSteps:1000000,isTeamRace,teamSize:isTeamRace?50:null,powerupsEnabled:true,startedAt,endsAt:new Date(+now+86400000)}});
 const users=Array.from({length:99},(_,i)=>({id:randomUUID(),appleId:`worker-trace-${i}`,displayName:`Member ${i}`,timezone:'UTC'}));
 await prisma.user.createMany({data:users});
 await prisma.raceParticipant.createMany({data:[viewer.user,...users].map(u=>({raceId,userId:u.id,status:'ACCEPTED',team:isTeamRace?'TEAM_A':null,joinedAt:startedAt,buyInStatus:'NONE'}))});
 server=await getSharedServer();
 const intakeQueries=[];prisma.$on('query',m=>intakeQueries.push(m));
 const upload=await request(server.baseUrl,'POST','/steps/samples',{token:viewer.token,headers:{'X-Timezone':'UTC'},body:{samples:[{periodStart:new Date(+now-3*3600000).toISOString(),periodEnd:new Date(+now-2*3600000).toISOString(),steps:100}]}});
 assert.equal(upload.status,200);const queued=await prisma.raceResolutionJobV2.findUnique({where:{raceId}});assert.ok(queued,'HTTP upload durably enqueues race');
 const intakeEnd=intakeQueries.length;
 const duplicate=await request(server.baseUrl,'POST','/steps/samples',{token:viewer.token,headers:{'X-Timezone':'UTC'},body:{samples:[{periodStart:new Date(+now-3*3600000).toISOString(),periodEnd:new Date(+now-2*3600000).toISOString(),steps:100}]}});
 assert.equal(duplicate.status,200);
 const repeatedJob=await prisma.raceResolutionJobV2.findUnique({where:{raceId}});
 assert.equal(repeatedJob.generation,queued.generation,'identical sample upload already avoids queue generation work');
 console.log(JSON.stringify({experiment:'duplicate intake',initialGeneration:queued.generation,repeatedGeneration:repeatedJob.generation,queries:intakeQueries.length-intakeEnd}));
 const messages=[];let logs='';
 const child=spawn(process.execPath,['--require','./test/integration/fixtures/query-efficiency/observe-resolution.cjs','src/index.js'],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',STEPS_PROCESS_ROLE:'resolution',NODE_APP_INSTANCE:'0',PORT:'0',CRON_START_DELAY_MS:'0',RACE_QUEUE_V2_QUIET_PERIOD_MS:'0',ASYNC_RACE_RESOLUTION_CONCURRENCY:'3'},stdio:['ignore','pipe','pipe','ipc']});
 child.on('message',m=>messages.push(m));child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{
  let done;const until=Date.now()+60000;
  while(Date.now()<until){
   if(child.exitCode!==null)throw Error(`worker exited: ${logs.slice(-4000)}`);
   done=await prisma.raceResolutionJobV2.findUnique({where:{raceId}});
   if(done?.committedGeneration>=queued.generation)break;
   await delay(250);
  }
  assert.ok(done?.committedGeneration>=queued.generation,`worker completes uploaded generation: ${logs.slice(-5000)}`);
  const result=await request(server.baseUrl,'GET',`/races/${raceId}/progress`,{token:viewer.token,headers:{'X-Timezone':'UTC'}});assert.equal(result.status,200);
  const progress=(await result.json()).progress;const mine=progress.participants.find(p=>p.userId===viewer.user.id);assert.ok(mine);assert.equal(mine.totalSteps,100);assert.equal(mine.displayName,'Worker Viewer');
  if(!isTeamRace)await delay(5500);
  const sampleReads=messages.filter(m=>m.query.includes('JOIN step_samples sample')&&m.query.includes('requested.ordinal'));
  const exactRanges=sampleReads.flatMap(m=>JSON.parse(JSON.parse(m.params)[0]).map(b=>JSON.stringify([b.user_id,b.range_start,b.range_end])));
  assert.equal(exactRanges.length,new Set(exactRanges).size,'no duplicate user/time range reads in this worker attempt');
  console.log(JSON.stringify({experiment:'step and claim trace',sampleReads:sampleReads.length,bounds:exactRanges.length,uniqueBounds:new Set(exactRanges).size,claims:messages.filter(m=>m.query.includes('WITH candidate AS')&&m.query.includes('FROM race_resolution_jobs_v2')).length}));
  const fingerprints=messages.filter(m=>m.query.includes('SELECT jsonb_build_object(')&&m.query.includes('AS participants'));
  console.log(JSON.stringify({trace:{queries:messages.length,fingerprints:fingerprints.length,committedGeneration:done.committedGeneration}}));
  fs.writeFileSync('/tmp/query-efficiency-resolution-trace.json',JSON.stringify({messages,logs},null,2));
  assert.ok(fingerprints.length,'observe real worker fingerprint query');
  assert.ok(!logs.includes('scoped_fingerprint_changed'),'projection must not force dependency-closure retries');
  const original=fingerprints.find(m=>m.query.includes('LEFT JOIN users person')).query,parameters=JSON.parse(fingerprints[0].params);
  const candidate=original.replace("          'user', jsonb_build_object('id', person.id, 'displayName', person.display_name),\n",'').replace('       LEFT JOIN users person ON person.id=participant.user_id\n','');
  assert.notEqual(candidate,original);
  const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
  try{
   const old=(await db.query(original,parameters)).rows,updated=(await db.query(candidate,parameters)).rows;
   assert.deepEqual(updated,old.map(row=>({...row,participants:row.participants.map(({user,...rest})=>rest)})));
   const plan=async sql=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,parameters)).rows[0]['QUERY PLAN'][0];
   const comparisons=[];for(let i=0;i<3;i++){const a=await plan(original),b=await plan(candidate);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
   console.log(JSON.stringify({experiment:'fence projection',comparisons}));
   for(const comparison of comparisons)assert.ok(comparison.afterHits<comparison.beforeHits*.5,'fence candidate removes user-join work');
   if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1' && isTeamRace){
    assert.ok(fingerprints.some(m=>!m.query.includes('LEFT JOIN users person')),'actual worker fence must omit presentation join');
    assert.ok(fingerprints.some(m=>m.query.includes('LEFT JOIN users person')),'planning keeps presentation');
   }
  }finally{await db.end();}
 }finally{if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
});
