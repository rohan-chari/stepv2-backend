const assert = require('node:assert/strict');
const { before, beforeEach, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require('./setup');
const { buildGlobalEventSummaryV2Tick, scheduleGlobalEventSummaryTick } = require('../../src/modules/steps/jobs/globalEventSummary');
let server;
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);
// SQL assertions below inspect maintenance states unreachable through HTTP;
// the entrypoint remains HTTP intake followed by the real summary consumer.
async function fixture(count = 260) {
  const account = await createTestUser({ timezone: 'UTC' });
  const day = new Date().toISOString().slice(0, 10);
  const accepted = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
    token: account.token, headers: { 'Idempotency-Key': randomUUID(), 'X-Timezone': 'UTC' },
    body: { date: day, steps: 42, samples: [{ periodStart: `${day}T00:01:00Z`, periodEnd: `${day}T00:02:00Z`, steps: 42 }] },
  });
  assert.equal(accepted.status, 202);
  await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_roots(id,user_id,day,revision,last_used_at)
    SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,$1,
      date '2020-01-01'+n,0,now()-interval '11 minutes' FROM generate_series(1,$2::int) n`, account.user.id, count);
  return account;
}
const wake = () => buildGlobalEventSummaryV2Tick({ prisma })({ recovery: false });
const roots = () => prisma.$queryRawUnsafe('SELECT id,xmin::text AS version,last_used_at FROM durable_capture_fact_roots ORDER BY id');
const due = () => prisma.$executeRawUnsafe("UPDATE durable_capture_compaction_schedule SET next_due_at=now()-interval '1 second'");
async function sweepDue() {
  await due();
  await prisma.$executeRawUnsafe("UPDATE durable_capture_root_sweep SET next_due_at=now()-interval '1 second'");
}
it('summary maintenance traverses retained roots without rewriting them and propagates its bounded cursor deadline', async () => {
  await fixture();
  const before = await roots();
  await wake();
  assert.deepEqual(await roots(), before, 'visiting current retained roots must not change xmin or last_used_at');
  const [state] = await prisma.$queryRawUnsafe(`SELECT sweep.after_id, sweep.next_due_at <= schedule.next_due_at AS propagated
    FROM durable_capture_root_sweep sweep CROSS JOIN durable_capture_compaction_schedule schedule`);
  assert.equal(state.after_id, before[127].id);
  assert.equal(state.propagated, true);
  await sweepDue(); await wake(); await sweepDue(); await wake();
  const [wrapped] = await prisma.$queryRawUnsafe('SELECT after_id,next_due_at>now()+interval \'50 seconds\' AS paused FROM durable_capture_root_sweep');
  assert.equal(wrapped.after_id, null); assert.equal(wrapped.paused, true);
  assert.deepEqual(await roots(), before);
});
it('forced old compact wrapper sees an unpinned root immediately after a short sweep', async () => {
  const account = await fixture(1);
  const [root] = await roots();
  const owner = randomUUID();
  await prisma.$executeRawUnsafe('INSERT INTO durable_capture_fact_pins(owner_id,root_id) VALUES($1::uuid,$2::uuid)', owner, root.id);
  await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 second'");
  await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
  assert.equal((await roots()).length, 1);
  await prisma.$executeRawUnsafe('DELETE FROM durable_capture_fact_pins WHERE owner_id=$1::uuid', owner);
  await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
  assert.equal((await roots()).length, 0);
  const response = await request(server.baseUrl, 'GET', `/steps?date=${new Date().toISOString().slice(0,10)}`, { token: account.token });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record.steps, 42);
});
it('rollback preserves cursor and roots; an eligible root behind retained pages is eventually collected', async () => {
  await fixture(2600); await wake();
  const before = await roots();
  const [state] = await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_root_sweep');
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
    throw new Error('rollback sweep');
  }), /rollback sweep/);
  assert.deepEqual((await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_root_sweep'))[0], state);
  assert.deepEqual(await roots(), before);
  await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 second' WHERE id=$1::uuid", before[2599].id);
  for (let i = 0; i < 22; i++) await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
  assert.equal((await roots()).some(r => r.id === before[2599].id), false);
});
it('direct maintenance never takes the outer schedule row behind its advisory lock', async () => {
  await fixture(1); await wake();
  const owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SELECT * FROM durable_capture_compaction_schedule FOR UPDATE');
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='1000ms'");
      await tx.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
    });
  } finally { await owner.query('ROLLBACK'); await owner.end(); }
});

it('new roots behind the cursor and roots made eligible after a visit are found on wrap', async () => {
  const account = await fixture(); await wake();
  const before = await roots();
  await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 second' WHERE id=$1::uuid", before[0].id);
  const inserted = '00000000-0000-0000-0000-000000000000';
  await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_roots(id,user_id,day,revision,last_used_at,retention_expires_at)
    VALUES($1::uuid,$2,date '2019-01-01',0,now()-interval '11 minutes',now()-interval '1 second')`, inserted,account.user.id);
  for(let i=0;i<5;i++) await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_compact(128)');
  const left=await roots();
  assert.equal(left.some(r=>r.id===before[0].id||r.id===inserted),false);
  assert.equal(left.length,259);
});
it('shared intake pins fence simultaneous direct and scheduled maintenance without deadlock', async () => {
  const account=await fixture(1); const [root]=await roots();
  await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 second'");
  const pin = new Client({connectionString:process.env.DATABASE_URL}); await pin.connect();
  const requests=JSON.stringify([{userId:account.user.id,day:'2020-01-02'}]);
  try {
    await pin.query('BEGIN');
    await pin.query('SELECT * FROM durable_capture_pin_roots($1::uuid,$2::jsonb)',[randomUUID(),requests]);
    const run=sql=>prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3s'");
      return tx.$queryRawUnsafe(sql);
    });
    const scheduled=run('SELECT * FROM durable_capture_compact_if_due(128)');
    const direct=run('SELECT * FROM durable_capture_compact(128)');
    const day=new Date().toISOString().slice(0,10);
    const intake=request(server.baseUrl,'POST','/steps/sync-v2',{token:account.token,
      headers:{'Idempotency-Key':randomUUID(),'X-Timezone':'UTC'},body:{date:day,steps:43,samples:[{periodStart:`${day}T00:01:00Z`,periodEnd:`${day}T00:02:00Z`,steps:43}]}});
    await delay(50); await pin.query('COMMIT');
    const results=await Promise.all([scheduled,direct,intake]);
    assert.equal(results[2].status,202);
    assert.equal((await roots()).some(r=>r.id===root.id),true,'committed pin must protect retention-expired root');
  } finally { await pin.query('ROLLBACK'); await pin.end(); }
});
it('forced compact prioritizes oldest eligible transition when age order disagrees with UUID order',async()=>{
 const account=await fixture(1);
 const [young]=await roots();
 const oldest='ffffffff-ffff-ffff-ffff-ffffffffffff';
 await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_roots(id,user_id,day,revision,last_used_at,retention_expires_at)
  VALUES($1::uuid,$2,date '2019-01-01',0,now()-interval '100 years',now()-interval '1 second')`,oldest,account.user.id);
 await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_roots SET retention_expires_at=now()-interval '1 second' WHERE id=$1::uuid",young.id);
 await prisma.$queryRawUnsafe('SELECT * FROM durable_capture_compact(1)');
 const left=await roots();
 assert.equal(left.some(r=>r.id===oldest),false,'oldest compatibility candidate must receive the one-root deletion budget');
 assert.equal(left.some(r=>r.id===young.id),true);
});

it('root-only continuation reaches the real summary wake coordinator without another upload',async()=>{
 await fixture();
 const timers=[],errors=[];
 const scheduler=scheduleGlobalEventSummaryTick({prisma,subscribeWake:async()=>()=>{},
  setDueTimer(fn,ms){const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearDueTimer(timer){timer.cancelled=true;},
  setTimeout(){return{unref(){}};},clearTimeout(){},logger:{log(){},error(...args){errors.push(args);}}});
 try{
  let dueTimer;
  for(let i=0;i<100;i++){dueTimer=timers.find(timer=>!timer.cancelled&&timer.ms>0&&timer.ms<=1100);if(dueTimer)break;await delay(10);}
  assert.deepEqual(errors,[]);assert.ok(dueTimer,'root sweep continuation must arm a prompt scheduler wake');
  const [first]=await prisma.$queryRawUnsafe('SELECT after_id FROM durable_capture_root_sweep');
  assert.equal(first.after_id,'00000000-0000-0000-0000-000000000128');
  await delay(1100);await dueTimer.fn();
  let next;
  for(let i=0;i<100;i++){[next]=await prisma.$queryRawUnsafe('SELECT after_id FROM durable_capture_root_sweep');if(next.after_id!==first.after_id)break;await delay(10);}
  assert.equal(next.after_id,'00000000-0000-0000-0000-000000000256');assert.deepEqual(errors,[]);
 }finally{await scheduler.stop();}
});
it('pinned superseded roots do not read revision heads merely to rule out their eviction',async()=>{
 const account=await fixture(128);
 await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_pins(owner_id,root_id)
   SELECT $1::uuid,id FROM durable_capture_fact_roots WHERE user_id=$2`,randomUUID(),account.user.id);
 await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_heads(user_id,day,revision,compacted_revision)
   SELECT user_id,day,1,1 FROM durable_capture_fact_roots WHERE user_id=$1`,account.user.id);
 await prisma.$executeRawUnsafe('UPDATE durable_capture_fact_roots SET prepared_at=now() WHERE user_id=$1',account.user.id);
 await prisma.$transaction(async tx=>{
  const reads=async()=>Number((await tx.$queryRawUnsafe(`SELECT seq_tup_read+idx_tup_fetch AS n
    FROM pg_stat_xact_user_tables WHERE relname='durable_capture_fact_heads'`))[0].n);
  const before=await reads();
  await tx.$queryRawUnsafe('SELECT durable_capture_evict_roots_internal(128,false)');
  assert.equal(await reads()-before,0,'an active pin decides retention without traversing revision heads');
 });
 assert.equal((await roots()).length,128);
});

it('scheduled root pages do not scan current revision heads for future retirement',async()=>{
 const account=await fixture(6763);
 await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_pins(owner_id,root_id)
   SELECT $1::uuid,id FROM durable_capture_fact_roots WHERE user_id=$2`,randomUUID(),account.user.id);
 await prisma.$executeRawUnsafe(`INSERT INTO durable_capture_fact_heads(user_id,day,revision,compacted_revision)
   SELECT user_id,day,1,1 FROM durable_capture_fact_roots WHERE user_id=$1 ON CONFLICT DO NOTHING`,account.user.id);
 // The real intake's recent journal is outside this root-only maintenance probe.
 await prisma.$executeRawUnsafe("UPDATE durable_capture_fact_heads SET next_compaction_at=now()+interval '1 hour'");
 await prisma.$executeRawUnsafe('ANALYZE durable_capture_fact_heads');
 await prisma.$transaction(async tx=>{
  // Exercise the server's eventual generic-plan branch deterministically.
  await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode=force_generic_plan");
  const reads=async()=>Number((await tx.$queryRawUnsafe(`SELECT seq_tup_read+idx_tup_fetch AS n
    FROM pg_stat_xact_user_tables WHERE relname='durable_capture_fact_heads'`))[0].n);
  const before=await reads();
  for(let i=0;i<12;i++){
   await tx.$executeRawUnsafe("UPDATE durable_capture_compaction_schedule SET next_due_at=now()-interval '1 second'");
   await tx.$executeRawUnsafe("UPDATE durable_capture_root_sweep SET next_due_at=now()-interval '1 second'");
   const [result]=await tx.$queryRawUnsafe('SELECT * FROM durable_capture_compact_if_due(128)');
   assert.equal(result.ran,true);
  }
  assert.ok(await reads()-before<=24,'each call may fetch only the earliest head from each of two partial indexes');
 });
});
