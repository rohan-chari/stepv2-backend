process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {Client}=require('pg');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));
assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase}=require('./setup');
after(()=>prisma.$disconnect());

test('real cron enrollment pages unique users in PostgreSQL', {timeout:150000}, async()=>{
 await cleanDatabase();
 const users=Array.from({length:600},(_,i)=>({id:randomUUID(),appleId:`eff-enrollment-${i}`,globalEventTimezone:i===1?'America/New_York':'UTC',timezone:'UTC'}));
 await prisma.user.createMany({data:users});
 const races=Array.from({length:10},(_,i)=>({id:randomUUID(),name:`Enrollment ${i}`,creatorId:users[0].id,status:'ACTIVE',targetSteps:10000,startedAt:new Date(),endsAt:new Date(Date.now()+7*86400000)}));
 await prisma.race.createMany({data:races});
 await prisma.raceParticipant.createMany({data:races.flatMap(r=>users.map(u=>({raceId:r.id,userId:u.id,status:'ACCEPTED',buyInStatus:'NONE'})))});
 const excluded=Array.from({length:4},(_,i)=>({id:randomUUID(),appleId:`eff-excluded-${i}`,globalEventTimezone:'UTC'}));
 await prisma.user.createMany({data:excluded});
 const dormant=await prisma.race.create({data:{name:'Dormant',status:'PENDING',targetSteps:10000}});
 await prisma.raceParticipant.createMany({data:excluded.map((u,i)=>({raceId:i===3?dormant.id:races[0].id,userId:u.id,status:i===0?'INVITED':'ACCEPTED',buyInStatus:'NONE',...(i===1?{forfeitedAt:new Date()}:{}),...(i===2?{finishedAt:new Date()}: {})}))});
 const day=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(day+'T08:00:00Z'),endsAt:new Date(day+'T08:30:00Z'),scheduleMode:'LOCAL_ENTITLEMENTS',eventDay:day,localStartMinute:480,durationMinutes:30,summaryAttributionVersion:2,multiplier:2}});
 const otherEvent=await prisma.globalStepEvent.create({data:{startsAt:event.startsAt,endsAt:event.endsAt,multiplier:2}});
 const entitlement=(eventId,userId)=>({eventId,userId,timezone:'UTC',localDate:day,startsAt:event.startsAt,endsAt:event.endsAt,startOutcome:'PENDING'});
 await prisma.globalStepEventEntitlement.createMany({data:[entitlement(event.id,users[0].id),entitlement(otherEvent.id,users[2].id)]});
 const caps=['SCHEDULED_EVENT_CONSUMER','UNIVERSAL_C0_LOCK_ORDER','TOKEN_LIFECYCLE','TARGET_AWARE_SENDER','RECONCILER_OWNERSHIP'];
 await prisma.globalStepEventCronOwner.createMany({data:['http:0','http:1','resolution:0'].map(id=>({ownerId:`fixture-${id}`,logicalOwnerId:id,bootId:'fixture',role:id.split(':')[0],generation:2,capabilities:caps,expiresAt:new Date(Date.now()+180000),heartbeatAt:new Date()}))});
 await prisma.globalStepEventGenerationState.create({data:{id:1,readySince:new Date(Date.now()-100000)}});
 await prisma.$executeRawUnsafe('ANALYZE race_participants');
 await prisma.$executeRawUnsafe('ANALYZE users');
 // Integration experiment: compare the existing distinct-in-application shape
 // with a database-side unique-user page before the scheduler writes any rows.
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 const old=`SELECT rp.user_id FROM race_participants rp JOIN races r ON r.id=rp.race_id JOIN users u ON u.id=rp.user_id WHERE rp.status='accepted' AND rp.forfeited_at IS NULL AND rp.finished_at IS NULL AND r.status='active' AND NOT EXISTS(SELECT 1 FROM global_step_event_entitlements e WHERE e.event_id=$1 AND e.user_id=u.id) ORDER BY rp.user_id`;
 const candidate=`WITH enrollment_candidates AS MATERIALIZED (SELECT DISTINCT rp.user_id FROM race_participants rp JOIN races r ON r.id=rp.race_id WHERE rp.status='accepted' AND rp.forfeited_at IS NULL AND rp.finished_at IS NULL AND r.status='active' AND NOT EXISTS(SELECT 1 FROM global_step_event_entitlements e WHERE e.event_id=$1 AND e.user_id=rp.user_id) ORDER BY rp.user_id LIMIT 500) SELECT u.id AS user_id,u.timezone,u.global_event_timezone FROM enrollment_candidates c JOIN users u ON u.id=c.user_id ORDER BY u.id`;
 try{
  const a=await db.query(old,[event.id]),b=await db.query(candidate,[event.id]);
  assert.deepEqual(b.rows.map(x=>x.user_id),[...new Set(a.rows.map(x=>x.user_id))].slice(0,500));
  const plan=async sql=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,[event.id])).rows[0]['QUERY PLAN'][0];
  const comparisons=[];for(let i=0;i<3;i++){const x=await plan(old),y=await plan(candidate);comparisons.push({beforeMs:x['Execution Time'],afterMs:y['Execution Time'],beforeRows:x.Plan['Actual Rows'],afterRows:y.Plan['Actual Rows']});}
  console.log(JSON.stringify({experiment:'enrollment',comparisons}));
  for(const x of comparisons){assert.ok(x.afterRows<x.beforeRows/5);assert.ok(x.afterMs<x.beforeMs,'candidate must improve execution as well as transferred rows');}
 }finally{await db.end();}
 if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY==='1')return;
 const messages=[];let logs='';
 const child=spawn(process.execPath,['--require','./test/integration/fixtures/query-efficiency/observe-worker.cjs','src/index.js'],{cwd:process.cwd(),env:{...process.env,STEPS_PROCESS_ROLE:'cron',NODE_APP_INSTANCE:'0',PORT:'0',NODE_ENV:'test'},stdio:['ignore','pipe','pipe','ipc']});
 child.on('message',m=>messages.push(m));child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{
  const until=Date.now()+120000;let found=0;
  while(Date.now()<until){
   if(child.exitCode!==null)throw Error(`cron exited ${child.exitCode}: ${logs.slice(-3000)}`);
   const own=await prisma.globalStepEventCronOwner.findFirst({where:{logicalOwnerId:'cron:0'}});
   if(own)await prisma.globalStepEventGenerationState.update({where:{id:1},data:{readySince:new Date(Date.now()-100000)}});
   found=await prisma.globalStepEventEntitlement.count({where:{eventId:event.id}});
   if(found===600)break;
   await delay(500);
  }
  assert.equal(found,600,`real scheduler must enroll every user across pages: ${logs.slice(-2000)}`);
  const stored=await prisma.globalStepEventEntitlement.findMany({where:{eventId:event.id}});
  assert.deepEqual(stored.map(r=>r.userId).sort(),users.map(u=>u.id).sort());
  const ny=stored.find(r=>r.userId===users[1].id);
  assert.equal(ny.timezone,'America/New_York');assert.equal(ny.localDate,day);
  assert.equal(new Intl.DateTimeFormat('en-US',{timeZone:ny.timezone,hour:'2-digit',hourCycle:'h23'}).format(ny.startsAt),'08');
  assert.equal(ny.endsAt-ny.startsAt,30*60000);
  const scans=messages.filter(m=>m.kind==='query' && (m.query.includes('enrollment_candidates') || (m.query.includes('FROM "public"."race_participants"')&&m.query.includes('NOT EXISTS'))));
  assert.ok(scans.length,'observe real scheduler candidate queries');
  assert.ok(scans.every(m=>/\bLIMIT\b/i.test(m.query)),'every enrollment page must be bounded in PostgreSQL');
  const targetPages=scans.filter(m=>m.query.includes('enrollment_candidates')).map(m=>JSON.parse(m.params)).filter(p=>p[0]===event.id);
  assert.ok(targetPages.length>=2,'target event crosses the page boundary');
  assert.ok(targetPages.every(p=>p[1]===500),'actual page bound is 500');
  assert.equal(targetPages[0][2],null);
  assert.ok(targetPages.slice(1).some(p=>typeof p[2]==='string'&&p[2].length>0),'keyset cursor advances');
 }finally{
  if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 }
});
