// Local synthetic DDL-recovery/write-cost rehearsal, never production.
const assert=require('node:assert/strict');
const {writeFileSync}=require('node:fs');
const {Client}=require('pg');
const url=new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.match(url.pathname,/_test$/);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.REDIS_URL,'');
const h=require('../../test/integration/fixtures/enrollment-query/harness.cjs');
const INDEX='global_step_event_entitlements_pending_parent_idx';
const ddl=`CREATE INDEX CONCURRENTLY ${INDEX} ON global_step_event_entitlements(event_id) WHERE start_processed_at IS NULL OR end_processed_at IS NULL`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const admin=new Client({connectionString:url.toString()}),blocker=new Client({connectionString:url.toString()}),builder=new Client({connectionString:url.toString()});
 await Promise.all([admin.connect(),blocker.connect(),builder.connect()]);
 try{
  await h.resetPerformance();await h.prisma.user.createMany({data:Array.from({length:1000},(_,i)=>({id:`index-ops-${i}`}))});
  const [parent]=await h.parents();await h.prisma.globalStepEventEntitlement.createMany({data:Array.from({length:1000},(_,i)=>h.entitlement(parent,`index-ops-${i}`))});
  const def=async()=> (await admin.query(`SELECT indisvalid,indisready,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid=to_regclass($1)`,[INDEX])).rows[0];
  assert.equal((await def()).indisvalid,true);
  await admin.query(`DROP INDEX CONCURRENTLY ${INDEX}`);
  await blocker.query('BEGIN');await blocker.query("UPDATE global_step_event_entitlements SET timezone='UTC' WHERE user_id='index-ops-0'");
  const pid=(await builder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const build=builder.query(ddl).then(()=>({ok:true}),e=>({error:e.code}));
  const until=Date.now()+10000;
  let invalid;
  while(Date.now()<until){invalid=await def();if(invalid&&!invalid.indisvalid)break;await sleep(20);}
  assert.ok(invalid&&!invalid.indisvalid,'concurrent build left a visible invalid index while writer blocks');
  await admin.query('SELECT pg_cancel_backend($1)',[pid]);const cancelled=await build;assert.equal(cancelled.error,'57014');
  await blocker.query('ROLLBACK');const afterCancel=await def();assert.equal(afterCancel.indisvalid,false);
  await admin.query(`DROP INDEX CONCURRENTLY ${INDEX}`);await admin.query(ddl);const recovered=await def();assert.equal(recovered.indisvalid,true);assert.equal(recovered.indisready,true);
  const runs=[];
  const run=async()=>{
   await admin.query('UPDATE global_step_event_entitlements SET start_processed_at=NULL,end_processed_at=NULL WHERE event_id=$1',[parent.id]);
   const plans=[];
   for(const field of ['start_processed_at','end_processed_at']){
    const plan=(await admin.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) UPDATE global_step_event_entitlements SET ${field}=clock_timestamp() WHERE event_id=$1`,[parent.id])).rows[0]['QUERY PLAN'][0];
    plans.push({executionMs:plan['Execution Time'],rootWalBytes:plan.Plan['WAL Bytes']||0,buffers:(plan.Plan['Shared Hit Blocks']||0)+(plan.Plan['Shared Read Blocks']||0),updatedRows:1000});
   }
   return plans;
  };
  for(let i=0;i<Math.max(10,Math.min(100,Number(process.argv[3])||10));i++){
   if(i%2===0){await admin.query(`DROP INDEX CONCURRENTLY ${INDEX}`);const baseline=await run();await admin.query(ddl);runs.push({baseline,candidate:await run()});}
   else{const candidate=await run();await admin.query(`DROP INDEX CONCURRENTLY ${INDEX}`);const baseline=await run();await admin.query(ddl);runs.push({baseline,candidate});}
  }
  const evidence={cancelled,afterCancel,recovered,indexBytes:Number((await admin.query('SELECT pg_relation_size($1::regclass) AS bytes',[INDEX])).rows[0].bytes),runs,
   note:'1000 synthetic entitlement start/end updates per variant. Root WAL excludes trigger subplans; timing includes triggers. Alternating order, shared local cluster; no production claim. Concurrent index cancellation/rebuild verified, not interrupted Prisma-ledger reconciliation.'};
  writeFileSync(process.argv[2],JSON.stringify(evidence,null,2)+'\n');
 }finally{await blocker.query('ROLLBACK').catch(()=>{});await Promise.allSettled([admin.end(),blocker.end(),builder.end(),h.prisma.$disconnect()]);}
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
