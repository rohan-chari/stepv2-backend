const assert=require('node:assert/strict'),fs=require('node:fs');const {randomUUID}=require('node:crypto');const {performance}=require('node:perf_hooks');
const {Pool,Client}=require('pg');const {installPreparedReadQueries}=require('../../src/shared/database/preparedReadQueries');
const target=new URL(process.env.DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.endsWith('_test'));
const input=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse);
const selected=[...new Map(input.filter(q=>['full-trigger-drain','snapshot-repair-claim','seeded-preparation','active-event-read'].includes(q.family)).map(q=>[q.family,q])).values()];assert.equal(selected.length,4);
const {prisma}=require('../../src/db'),output=[];const pct=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
(async()=>{
 const user=randomUUID(),races=Array.from({length:100},()=>randomUUID()),lease=randomUUID(),now=new Date(),past=new Date(+now-60000),future=new Date(+now+3600000);
 await prisma.user.create({data:{id:user,appleId:user}});await prisma.race.createMany({data:races.map(id=>({id,creatorId:user,name:'CPU lane experiment',status:'ACTIVE',targetSteps:1000000,startedAt:past,endsAt:future}))});
 await prisma.raceParticipant.createMany({data:races.map(raceId=>({raceId,userId:user,status:'ACCEPTED',joinedAt:past}))});
 await prisma.raceResolutionJobV2.createMany({data:races.map(raceId=>({raceId,state:'QUEUED',generation:1,requestedAt:past,notBeforeAt:past,dirtyReasons:['FULL']}))});
 await prisma.seededChallengePreparation.create({data:{id:user,seedId:'cpu-experiment-seed',windowStart:past,windowEnd:future,generation:user,notBeforeAt:past}});
 await prisma.seededChallengePreparationGroup.createMany({data:races.map((reservedRaceId,i)=>({preparationId:user,generation:user,ordinal:i,reservedRaceId,reservedBucketId:randomUUID(),members:[],state:'RESERVED'}))});
 const event=randomUUID();await prisma.globalStepEvent.create({data:{id:event,startsAt:past,endsAt:future,scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2}});
 await prisma.globalStepEventEntitlement.create({data:{eventId:event,userId:user,startsAt:past,endsAt:future,timezone:'UTC',localDate:now.toISOString().slice(0,10),startOutcome:'ACTIVATED_ON_TIME'}});
 await prisma.globalEventRaceImpact.create({data:{eventId:event,userId:user,raceId:races[0],status:'ENROLLED'}});
 try{
  for(const q of selected)for(const density of ['empty','sparse','dense'])for(let repetition=0;repetition<3;repetition++){
   const au=new URL(target);au.pathname='/pgbouncer';const admin=new Client({connectionString:au.toString()});await admin.connect();await admin.query(`RECONNECT ${target.pathname.slice(1)}`);await admin.end();
   const pool=new Pool({connectionString:target.toString(),max:1,options:'-c timezone=UTC'});installPreparedReadQueries(pool);const db=await pool.connect();
   try{
    await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");
    const eligible=density==='empty'?0:density==='sparse'?1:1000;
    await db.query('INSERT INTO race_resolution_full_triggers(race_id,requested_at) SELECT ($1::text[])[1+(n%100)],$2::timestamp FROM generate_series(1,$3::int) n',[races,past,eligible]);
    await db.query('INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation,available_at) SELECT gen_random_uuid()::text,($1::text[])[1+(n%100)],1,$2::timestamp FROM generate_series(1,$3::int) n',[races,past,eligible]);
    if(!eligible)await db.query("UPDATE seeded_challenge_preparation_groups SET state='MATERIALIZED' WHERE generation=$1",[user]);
    for(const table of ['race_resolution_full_triggers','race_resolution_jobs_v2','race_snapshot_repair_intents','seeded_challenge_preparation_groups','global_step_event_entitlements'])await db.query(`ANALYZE ${table}`);
    const sql=q.query.replace(/^\/\* steps:prepared-(read|query):v1 \*\//,''),prepared=`/* steps:prepared-${['seeded-preparation','active-event-read'].includes(q.family)?'read':'query'}:v1 */`+sql;
    let values;
    if(q.family==='full-trigger-drain')values=[500,now,future,future];
    if(q.family==='snapshot-repair-claim')values=[lease];
    if(q.family==='seeded-preparation')values=[races[0],races[0],now,races[0]];
    if(q.family==='active-event-read')values=[JSON.stringify(Array.from({length:density==='dense'?256:1},(_,i)=>({userId:eligible&&i===0?user:`absent-${i}`,at:now.toISOString()}))),null];
    const times={baseline:[],prepared:[]};
    const normalize=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='lease_expires_at')));
    for(let i=0;i<70;i++){
     const result={};
     for(const kind of i%2?['prepared','baseline']:['baseline','prepared']){
      await db.query('SAVEPOINT sample');const start=performance.now();result[kind]=normalize((await db.query({text:kind==='prepared'?prepared:sql,values})).rows);
      if(i>=10)times[kind].push(performance.now()-start);
      await db.query('ROLLBACK TO SAVEPOINT sample');await db.query('RELEASE SAVEPOINT sample');
     }
     if(q.family==='snapshot-repair-claim')for(const rows of Object.values(result))rows.sort((a,b)=>a.task_id.localeCompare(b.task_id));
     assert.deepEqual(result.prepared,result.baseline);
    }
    const plans=(await db.query('SELECT generic_plans::int,custom_plans::int FROM pg_prepared_statements WHERE statement=$1',[prepared])).rows[0];assert.ok(plans);
    const explain=(await db.query({text:'EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+sql,values})).rows[0]['QUERY PLAN'][0];
    const row={family:q.family,density,repetition,...plans,baselineMedianMs:pct(times.baseline,.5),preparedMedianMs:pct(times.prepared,.5),baselineP95Ms:pct(times.baseline,.95),preparedP95Ms:pct(times.prepared,.95),buffers:(explain.Plan['Shared Hit Blocks']||0)+(explain.Plan['Shared Read Blocks']||0),walBytes:explain.Plan['WAL Bytes']||0};output.push(row);console.log(JSON.stringify(row));
   }finally{await db.query('ROLLBACK');db.release();await pool.end();}
  }
 }finally{
  await prisma.seededChallengePreparationGroup.deleteMany({where:{generation:user}});await prisma.seededChallengePreparation.delete({where:{id:user}});
  await prisma.globalEventRaceImpact.deleteMany({where:{eventId:event}});await prisma.globalStepEventEntitlement.deleteMany({where:{eventId:event}});await prisma.globalStepEvent.delete({where:{id:event}});
  await prisma.race.deleteMany({where:{id:{in:races}}});await prisma.user.delete({where:{id:user}});
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();fs.writeFileSync(process.argv[3],JSON.stringify(output,null,2));}).then(()=>process.exit(process.exitCode||0));
