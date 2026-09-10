// Matched preparation experiment using the SQL observed in the public worker.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {Pool,Client}=require('pg');
const {installPreparedReadQueries}=require('../../src/shared/database/preparedReadQueries');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.endsWith('_test'));
const observed=JSON.parse(fs.readFileSync(process.argv[2]));
let sql=observed.find(q=>q.family==='display-boundary').query.replace(/^\/\* steps:prepared-read:v1 \*\//,'');
let prepared='/* steps:prepared-read:v1 */'+sql;
if(process.argv[4]==='single-traversal') {
 const start=sql.indexOf('      UNION ALL SELECT entitlement.starts_at');
 const end=sql.indexOf('    ) display_boundary_proof',start);
 assert.ok(start>0&&end>start);
 prepared='/* steps:prepared-read:v1 */'+sql.slice(0,start)+`      UNION ALL SELECT future.boundary FROM global_step_event_entitlements entitlement
       JOIN race_participants participant ON participant.user_id=entitlement.user_id
       JOIN global_step_events event ON event.id=entitlement.event_id
       CROSS JOIN LATERAL (VALUES (entitlement.starts_at),(entitlement.ends_at)) future(boundary)
       WHERE participant.race_id=$1 AND participant.status='accepted'
         AND event.schedule_mode='LOCAL_ENTITLEMENTS'
         AND entitlement.start_outcome IN ('PENDING','ACTIVATED_ON_TIME','ACTIVATED_LATE_JOIN')
         AND future.boundary > $2::timestamp
`+sql.slice(end);
 sql='/* steps:prepared-read:v1 */'+sql;
}

const {prisma}=require('../../src/db');
const out=[];
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
(async()=>{
 for(const distribution of [{name:'empty',members:1,events:0},{name:'ordinary',members:32,events:4},{name:'dense-history',members:256,events:40}]) {
  const users=Array.from({length:distribution.members},()=>randomUUID()),race=randomUUID(),events=Array.from({length:distribution.events},()=>randomUUID());
  const now=new Date(),past=new Date(+now-3600000),future=new Date(+now+86400000);
  await prisma.user.createMany({data:users.map(id=>({id,appleId:id}))});
  await prisma.race.create({data:{id:race,creatorId:users[0],name:'CPU preparation benchmark',status:'ACTIVE',targetSteps:1000000,startedAt:past,endsAt:future}});
  await prisma.raceParticipant.createMany({data:users.map(userId=>({raceId:race,userId,status:'ACCEPTED',joinedAt:past}))});
  for(let i=0;i<events.length;i++) {
   const startsAt=new Date(+now+(i%3===0?1:-1)*(i+1)*3600000),endsAt=new Date(+startsAt+1800000);
   await prisma.globalStepEvent.create({data:{id:events[i],startsAt,endsAt,scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2}});
   await prisma.globalStepEventEntitlement.createMany({data:users.map(userId=>({eventId:events[i],userId,startsAt,endsAt,timezone:'UTC',localDate:startsAt.toISOString().slice(0,10),startOutcome:'PENDING'}))});
  }
  try {
   for(let repetition=0;repetition<3;repetition++) {
    const adminUrl=new URL(target);adminUrl.pathname='/pgbouncer';const admin=new Client({connectionString:adminUrl.toString()});
    await admin.connect();await admin.query(`RECONNECT ${target.pathname.slice(1)}`);await admin.end();
    const pool=new Pool({connectionString:target.toString(),max:1,options:'-c timezone=UTC'});installPreparedReadQueries(pool);const db=await pool.connect();
    try {
     await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");
     for(const table of ['race_participants','global_step_events','global_step_event_entitlements'])await db.query(`ANALYZE ${table}`);
     const values=[race,now.toISOString()],times={baseline:[],prepared:[]};
     for(let i=0;i<110;i++){
      const result={};
      for(const kind of i%2?['prepared','baseline']:['baseline','prepared']){
       const start=performance.now();result[kind]=(await db.query({text:kind==='prepared'?prepared:sql,values})).rows;
       if(i>=10)times[kind].push(performance.now()-start);
      }
      assert.deepEqual(result.prepared,result.baseline);
     }
     const plans=(await db.query('SELECT generic_plans::int,custom_plans::int FROM pg_prepared_statements WHERE statement=$1',[prepared])).rows;
     assert.equal(plans.length,1);
     const explain=(await db.query({text:'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,values})).rows[0]['QUERY PLAN'][0];
     const row={distribution:distribution.name,repetition,members:users.length,entitlements:users.length*events.length,rounds:100,...plans[0],
      baselineMedianMs:percentile(times.baseline,.5),preparedMedianMs:percentile(times.prepared,.5),baselineP95Ms:percentile(times.baseline,.95),preparedP95Ms:percentile(times.prepared,.95),
      buffers:(explain.Plan['Shared Hit Blocks']||0)+(explain.Plan['Shared Read Blocks']||0),unnamedPlanningMs:explain['Planning Time'],unnamedExecutionMs:explain['Execution Time']};
     out.push(row);console.log(JSON.stringify(row));await db.query('ROLLBACK');
    }finally{await db.query('ROLLBACK');db.release();await pool.end();}
   }
  }finally{
   await prisma.globalStepEventEntitlement.deleteMany({where:{eventId:{in:events}}});await prisma.globalStepEvent.deleteMany({where:{id:{in:events}}});
   await prisma.race.delete({where:{id:race}});await prisma.user.deleteMany({where:{id:{in:users}}});
  }
 }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();fs.writeFileSync(process.argv[3],JSON.stringify(out,null,2));}).then(()=>process.exit(process.exitCode||0));
