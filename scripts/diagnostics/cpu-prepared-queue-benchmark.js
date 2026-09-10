const assert=require('node:assert/strict'),fs=require('node:fs');
const {randomUUID}=require('node:crypto'); const {performance}=require('node:perf_hooks');
const {Pool,Client}=require('pg');const {installPreparedReadQueries}=require('../../src/shared/database/preparedReadQueries');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname.endsWith('_test'));
const observed=[...JSON.parse(fs.readFileSync(process.argv[2])),...JSON.parse(fs.readFileSync(process.argv[3]))];
const selected=[...new Map(observed.filter(q=>q.family!=='display-boundary').map(q=>[q.family,q])).values()];
assert.equal(selected.length,3);
const {prisma}=require('../../src/db'),out=[];
const percentile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
(async()=>{
 const user=randomUUID(),race=randomUUID(),task=randomUUID(),lease=randomUUID(),now=new Date(),past=new Date(+now-60000),future=new Date(+now+3600000);
 await prisma.user.create({data:{id:user,appleId:user}});
 await prisma.race.create({data:{id:race,creatorId:user,name:'CPU queue experiment',targetSteps:1000000,status:'ACTIVE',startedAt:past,endsAt:future}});
 await prisma.raceResolutionPostTask.createMany({data:Array.from({length:1000},(_,i)=>({id:i===0?task:randomUUID(),raceId:race,sourceGeneration:i+1,dedupeKey:`cpu-queue:${race}:${i}`,state:'running',leaseToken:lease,leaseExpiresAt:past,requestedAt:past,notBeforeAt:past,snapshotState:'succeeded',snapshotCommand:{},payloadBytes:2,intentCount:0}))});
 try {
  for(const q of selected)for(const distribution of ['empty','sparse','dense'])for(let repetition=0;repetition<3;repetition++){
   const adminUrl=new URL(target);adminUrl.pathname='/pgbouncer';const admin=new Client({connectionString:adminUrl.toString()});await admin.connect();await admin.query(`RECONNECT ${target.pathname.slice(1)}`);await admin.end();
   const pool=new Pool({connectionString:target.toString(),max:1,options:'-c timezone=UTC'});installPreparedReadQueries(pool);const db=await pool.connect();
   try{
    await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("UPDATE race_resolution_post_tasks SET state='succeeded' WHERE race_id=$1",[race]);
    if(distribution!=='empty')await db.query("UPDATE race_resolution_post_tasks SET state='running',snapshot_state='succeeded' WHERE race_id=$1 AND ($2::boolean OR id=$3)",[race,distribution==='dense',task]);
    await db.query('ANALYZE race_resolution_post_tasks');
    const sql=q.query.replace(/^\/\* steps:prepared-(read|query):v1 \*\//,''),prepared=`/* steps:prepared-${q.family==='post-task-readiness'?'read':'query'}:v1 */`+sql;
    const values=q.family==='post-task-finish'?[task,lease,now,'succeeded',null]:q.family==='post-task-readiness'?[now]:[];
    const times={baseline:[],prepared:[]};
    for(let i=0;i<110;i++){
     const result={};
     for(const kind of i%2?['prepared','baseline']:['baseline','prepared']){
      await db.query('SAVEPOINT sample');const start=performance.now();
      result[kind]=(await db.query({text:kind==='prepared'?prepared:sql,values})).rows;
      if(i>=10)times[kind].push(performance.now()-start);
      await db.query('ROLLBACK TO SAVEPOINT sample');await db.query('RELEASE SAVEPOINT sample');
     }
     assert.deepEqual(result.prepared,result.baseline);
    }
    const plan=(await db.query('SELECT generic_plans::int,custom_plans::int FROM pg_prepared_statements WHERE statement=$1',[prepared])).rows[0];assert.ok(plan);
    const explain=(await db.query({text:'EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+sql,values})).rows[0]['QUERY PLAN'][0];
    const row={family:q.family,distribution,repetition,rounds:100,...plan,baselineMedianMs:percentile(times.baseline,.5),preparedMedianMs:percentile(times.prepared,.5),baselineP95Ms:percentile(times.baseline,.95),preparedP95Ms:percentile(times.prepared,.95),buffers:(explain.Plan['Shared Hit Blocks']||0)+(explain.Plan['Shared Read Blocks']||0),walBytes:explain.Plan['WAL Bytes']||0,unnamedPlanningMs:explain['Planning Time'],unnamedExecutionMs:explain['Execution Time']};out.push(row);console.log(JSON.stringify(row));
   }finally{await db.query('ROLLBACK');db.release();await pool.end();}
  }
 }finally{await prisma.raceResolutionPostTask.deleteMany({where:{raceId:race}});await prisma.race.delete({where:{id:race}});await prisma.user.delete({where:{id:user}});}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();fs.writeFileSync(process.argv[4],JSON.stringify(out,null,2));}).then(()=>process.exit(process.exitCode||0));
