// Matched local workload. Set CAPTURE_CONTENTION_MODE only in the dedicated
// benchmark command; baseline uses the captured pre-migration functions.
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {Client}=require('pg');
const {prisma,cleanDatabase,createTestUser,getSharedServer,request}=require('./setup');
const mode=process.env.CAPTURE_CONTENTION_MODE||'candidate';
const output=[];
after(()=>{if(process.env.CAPTURE_CONTENTION_EVIDENCE)require('node:fs').writeFileSync(process.env.CAPTURE_CONTENTION_EVIDENCE,JSON.stringify(output,null,2));});
const p95=xs=>[...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*.95)-1];
test('real HTTP intake stays durable while bounded maintenance services retained populations',async()=>{
 const server=await getSharedServer();
 for(const population of [6763,67630])for(let repetition=0;repetition<3;repetition++){
  await cleanDatabase();
  const accounts=await Promise.all(Array.from({length:4},()=>createTestUser({timezone:'UTC'}))),rootOwner=await createTestUser({timezone:'UTC'});
  await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_roots(user_id,day,revision,last_used_at)
   SELECT $1,date '2000-01-01'+n,0,now()-interval '11 minutes' FROM generate_series(1,$2::int) n`,rootOwner.user.id,population);
  await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_pins(owner_id,root_id)
   SELECT $1::uuid,id FROM durable_capture_fact_roots WHERE user_id=$2 ORDER BY id LIMIT $3`,randomUUID(),rootOwner.user.id,Math.floor(population*.95));
  if(process.env.CAPTURE_CONTENTION_DISTRIBUTION==='superseded-pinned'){
   await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_heads(user_id,day,revision,compacted_revision)
    SELECT DISTINCT r.user_id,r.day,1,1 FROM durable_capture_fact_roots r
    JOIN durable_capture_fact_pins p ON p.root_id=r.id WHERE r.user_id=$1`,rootOwner.user.id);
   await prisma.$executeRawUnsafe('UPDATE durable_capture_fact_roots SET prepared_at=now() WHERE user_id=$1',rootOwner.user.id);
   await prisma.$executeRawUnsafe('ANALYZE durable_capture_fact_heads');
  }
  await prisma.$executeRawUnsafe('ANALYZE durable_capture_fact_roots');await prisma.$executeRawUnsafe('ANALYZE durable_capture_fact_pins');
  const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
  const day=new Date().toISOString().slice(0,10),times=[],lockWindows=[];
  const pages=Math.ceil(population/128)+1;
  // Candidate's shorter sweep pause increases revisit frequency. Charge it
  // conservatively for ceil(600/(pages+60)) complete sweeps per baseline sweep.
  const sweeps=mode==='candidate'?Math.ceil(600/(pages+60)):1;
  const start=performance.now();
  try{
   const intake=accounts.map(async account=>{
    for(let n=1;n<=32;n++){const at=performance.now();
     const response=await request(server.baseUrl,'POST','/steps/sync-v2',{token:account.token,
      headers:{'Idempotency-Key':randomUUID(),'X-Timezone':'UTC'},body:{date:day,steps:n,samples:[{periodStart:`${day}T00:01:00Z`,periodEnd:`${day}T00:02:00Z`,steps:n}]}});
     assert.equal(response.status,202);times.push(performance.now()-at);
    }
   });
   const maintenance=(async()=>{
    for(let i=0;i<pages*sweeps;i++){
     // Virtual scheduling deadlines only: fixture writes are outside the
     // measured lock window and occur identically before each service call.
     await db.query('INSERT INTO durable_capture_compaction_schedule(singleton) VALUES(true) ON CONFLICT DO NOTHING');
     await db.query("UPDATE durable_capture_compaction_schedule SET next_due_at=clock_timestamp()-interval '1 second'");
     if(mode==='candidate')await db.query("UPDATE durable_capture_root_sweep SET next_due_at=clock_timestamp()-interval '1 second'");
     await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='5s'");
     await db.query('SELECT * FROM durable_capture_compaction_schedule FOR UPDATE');
     // Acquiring the same advisory lock explicitly lets the measured window
     // include all work until COMMIT, excluding time waiting to acquire it.
     await db.query('SELECT pg_advisory_xact_lock(904205010001::bigint)');
     const acquired=performance.now();
     await db.query('SELECT * FROM durable_capture_compact_if_due(128)');await db.query('COMMIT');
     lockWindows.push(performance.now()-acquired);
    }
   })();
   await Promise.all([...intake,maintenance]);
   for(const account of accounts){
    const response=await request(server.baseUrl,'GET',`/steps?date=${day}`,{token:account.token});assert.equal(response.status,200);
    assert.equal((await response.json()).record.steps,32,'every lane retains its final accepted total');
   }
   const row={mode,distribution:process.env.CAPTURE_CONTENTION_DISTRIBUTION||'current',population,repetition,requests:times.length,maintenanceCalls:pages*sweeps,chargedSweeps:sweeps,elapsedMs:performance.now()-start,intakeP95Ms:p95(times),intakeMedianMs:[...times].sort((a,b)=>a-b)[64],exclusiveLockP95Ms:p95(lockWindows),exclusiveLockMaxMs:Math.max(...lockWindows),exclusiveLockTotalMs:lockWindows.reduce((a,b)=>a+b,0)};
   output.push(row);console.log(JSON.stringify(row));
  }finally{await db.query('ROLLBACK');await db.end();}
 }
});
