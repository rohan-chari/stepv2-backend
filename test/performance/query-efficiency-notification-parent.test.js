process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { readFileSync } = require('node:fs');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser } = require('./setup');
after(() => prisma.$disconnect());
const fixture = name => readFileSync(`${__dirname}/fixtures/query-efficiency/notification-parent-${name}.sql`, 'utf8');
const before = fixture('before'), candidate = fixture('candidate');
let workerQuery;
const tables = ['domain_event_outbox', 'domain_event_audiences', 'domain_event_notification_projections'];

async function connect() {
  const db = new Client({ connectionString: target.toString(), options: '-c timezone=UTC' });
  await db.connect();
  assert.match((await db.query('SELECT current_database() AS name')).rows[0].name, /_test$/);
  return db;
}

// Most stored events are terminal. Analyze that state, then grow a pending
// backlog before statistics catch up, reproducing production's one-row estimate.
async function seed(db, userId, count, historical = false) {
  const status = historical ? 'COMPLETED' : 'PROJECTING';
  const projectionStatus = historical ? 'COMPLETED' : 'PENDING';
  await db.query(`WITH events AS (
    INSERT INTO domain_event_outbox(id,event_key,event_type,schema_version,aggregate_type,aggregate_id,payload,occurred_at,available_at,status,expansion_completed_at)
    SELECT gen_random_uuid(),gen_random_uuid()::text,'PLACEMENT_CHANGED_V1',1,'race','fixture','{}',now()-interval '1 day',now()-interval '1 day',$2,now()-interval '1 day'
    FROM generate_series(1,$1::int) RETURNING id
  ), audience AS (
    INSERT INTO domain_event_audiences(domain_event_id,recipient_id,ordinal,facts)
    SELECT id,$3,0,'{}' FROM events
  ) INSERT INTO domain_event_notification_projections(domain_event_id,recipient_user_id,delivery_key,projection_kind,status,available_at)
    SELECT id,$3,id::text,'SILENT_REFRESH',$4,now()-interval '1 day' FROM events`,
  [count, status, userId, projectionStatus]);
}

async function measure(db, sql, now, timeoutMs = 8000) {
  await db.query('BEGIN');
  try {
    await db.query(`SET LOCAL statement_timeout='${timeoutMs}ms'`);
    const p = (await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql, [now,100])).rows[0]['QUERY PLAN'][0];
    const state = (await db.query(`SELECT status,count(*)::int AS count FROM domain_event_outbox GROUP BY status ORDER BY status`)).rows;
    const projections = (await db.query(`SELECT status,last_error_code,count(*)::int AS count FROM domain_event_notification_projections GROUP BY status,last_error_code ORDER BY status,last_error_code`)).rows;
    return { ms:p['Execution Time'], hits:p.Plan['Shared Hit Blocks'], state, projections };
  } catch (err) {
    if (err.code==='57014') return { timeoutMs };
    throw err;
  } finally { await db.query('ROLLBACK'); }
}

async function withBacklog(run) {
  await cleanDatabase();
  const { user } = await createTestUser();
  const db = await connect();
  try {
    for(const table of tables) await db.query(`ALTER TABLE ${table} SET (autovacuum_enabled=false)`);
    await seed(db,user.id,20000,true);
    for(const table of [...tables,'device_tokens','users']) await db.query(`ANALYZE ${table}`);
    await run(db,user);
  } finally {
    for(const table of tables) await db.query(`ALTER TABLE ${table} RESET (autovacuum_enabled)`);
    await db.end();
  }
}

test('full notification update remains bounded as an unanalyzed backlog grows', {timeout:120000}, async () => {
  await withBacklog(async (db,user) => {
    const curve=[];let seeded=0;
    for(const size of [100,500,1500,3000]) {
      await seed(db,user.id,size-seeded);seeded=size;
      const now=new Date().toISOString();
      const old=await measure(db,before,now), next=await measure(db,candidate,now);
      assert.ok(!next.timeoutMs,'candidate full update must finish');
      assert.ok(next.ms<1000, 'candidate processes a batch within one second on local fixture');
      assert.equal(next.state.find(r=>r.status==='COMPLETED').count,20100);
      assert.equal(next.projections.find(r=>r.status==='COMPLETED').count,20100);
      if(!old.timeoutMs) {
        assert.deepEqual(next.state,old.state);
        assert.deepEqual(next.projections,old.projections);
      }
      // Repeated materialized-row scans burn CPU without proportional buffer hits.
      if(size>=1500) assert.ok(old.timeoutMs || next.ms<old.ms/10,'bounded parent lookup cuts full-update execution time');
      curve.push({size,beforeMs:old.ms,beforeTimeoutMs:old.timeoutMs,afterMs:next.ms,beforeHits:old.hits,afterHits:next.hits});
    }
    console.log(JSON.stringify({experiment:'notification parent completion full UPDATE',curve}));
  });
});

async function observeWorkerCompletion() {
  if(workerQuery)return workerQuery;
  await cleanDatabase();const {user}=await createTestUser();const db=await connect();
  let child;const messages=[];let logs='';
  try {
    await seed(db,user.id,10);
    child=spawn(process.execPath,['--require','./test/integration/fixtures/query-efficiency/observe-resolution.cjs','src/index.js'],{
      cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',STEPS_PROCESS_ROLE:'cron',NODE_APP_INSTANCE:'0',PORT:'0',CRON_START_DELAY_MS:'0'},stdio:['ignore','pipe','pipe','ipc'],
    });
    child.on('message',m=>messages.push(m));
    child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
    let emitted;const until=Date.now()+60000;
    while(Date.now()<until) {
      emitted=messages.find(m=>m.query.includes('recipient_exists')&&m.query.includes('completed_events'));
      if(emitted)break;
      if(child.exitCode!==null)throw Error(`cron exited: ${logs.slice(-2000)}`);
      await delay(100);
    }
    assert.ok(emitted,`real cron completion observed: ${logs.slice(-2000)}`);
    assert.match(emitted.query,/finishable_parents AS MATERIALIZED/, 'real cron must bound parent checks to its claimed batch');
    const untilDone=Date.now()+5000;
    while(Date.now()<untilDone && (await db.query("SELECT count(*)::int AS n FROM domain_event_outbox WHERE status='COMPLETED'")).rows[0].n<10)await delay(50);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM domain_event_outbox WHERE status='COMPLETED'")).rows[0].n,10);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM domain_event_notification_projections WHERE status='COMPLETED'")).rows[0].n,10);
    workerQuery=emitted.query;
  } finally {
    if(child && child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    await db.end();
  }
  return workerQuery;
}

test('real cron drains no-device work and fixes the production-shaped backlog', {timeout:90000}, async()=>{
  const actualQuery=await observeWorkerCompletion();
  await withBacklog(async(db,user)=>{
    await seed(db,user.id,1500);
    const now=new Date().toISOString();
    const old=await measure(db,before,now),actual=await measure(db,actualQuery,now);
    assert.ok(!actual.timeoutMs && actual.ms<1000,'real worker UPDATE finishes within one second');
    assert.ok(old.timeoutMs || actual.ms<old.ms/10,'real worker UPDATE is at least ten times faster');
    assert.equal(actual.state.find(r=>r.status==='COMPLETED').count,20100);
    console.log(JSON.stringify({experiment:'observed cron full UPDATE',beforeMs:old.ms,beforeTimeoutMs:old.timeoutMs,actualMs:actual.ms,actualHits:actual.hits}));
  });
});

async function createEvent(userId, {event:extra={}, projections=[{}]}={}) {
  const past=new Date(Date.now()-86400000), id=randomUUID();
  await prisma.domainEventOutbox.create({data:{id,eventKey:id,eventType:'PLACEMENT_CHANGED_V1',schemaVersion:1,aggregateType:'race',aggregateId:'fixture',payload:{},occurredAt:past,availableAt:past,status:'PROJECTING',expansionCompletedAt:past,...extra}});
  const rows=[];
  for(const [ordinal,p] of projections.entries()) {
    const {recipient=userId,facts={},missingAudience=false,...overrides}=p;
    if(!missingAudience && !await prisma.domainEventAudience.findUnique({where:{domainEventId_recipientId:{domainEventId:id,recipientId:recipient}}}))await prisma.domainEventAudience.create({data:{domainEventId:id,recipientId:recipient,ordinal,facts}});
    rows.push(await prisma.domainEventNotificationProjection.create({data:{domainEventId:id,recipientUserId:recipient,deliveryKey:randomUUID(),projectionKind:'SILENT_REFRESH',availableAt:past,...overrides}}));
  }
  return {id,rows};
}

test('full update preserves sibling, expiry, recipient, device and lease rules', {timeout:90000}, async()=>{
  const actualQuery=await observeWorkerCompletion();
  await cleanDatabase();const {user}=await createTestUser();const active=await createTestUser();const legacy=await createTestUser();
  await prisma.deviceToken.createMany({data:[{userId:active.user.id,token:randomUUID(),platform:'ios',status:'ACTIVE'},{userId:legacy.user.id,token:randomUUID(),platform:'ios',status:null}]});
  const at=new Date(), future=new Date(+at+86400000), past=new Date(+at-86400000);
  const cases={
    simple:await createEvent(user.id),
    failedSibling:await createEvent(user.id,{projections:[{}, {status:'FAILED_TERMINAL'}]}),
    futureSibling:await createEvent(user.id,{projections:[{}, {availableAt:future}]}),
    leasedSibling:await createEvent(user.id,{projections:[{}, {status:'PROCESSING',leaseUntil:future,leaseToken:'other-worker'}]}),
    expiredEvent:await createEvent(user.id,{event:{payload:{endsAt:at.toISOString()}}}),
    expiredAudience:await createEvent(user.id,{projections:[{facts:{expiresAt:at.toISOString()}}]}),
    deleted:await createEvent('deleted-user-fixture'),
    malformed:await createEvent(user.id,{event:{payload:{endsAt:'invalid'}}}),
    activeDevice:await createEvent(active.user.id),
    legacyDevice:await createEvent(legacy.user.id),
    terminalParent:await createEvent(user.id,{event:{status:'SUPPRESSED'}}),
    notExpanded:await createEvent(user.id,{event:{expansionCompletedAt:null}}),
    missingAudience:await createEvent(user.id,{projections:[{missingAudience:true}]}),
    reclaimed:await createEvent(user.id,{projections:[{status:'PROCESSING',leaseUntil:past,leaseToken:'expired-worker'}]}),
    retry:await createEvent(user.id,{projections:[{status:'RETRY'}]}),
  };
  const db=await connect();
  const snapshot=async()=>({
    events:(await db.query('SELECT id,status,completed_at,lease_token FROM domain_event_outbox ORDER BY id')).rows,
    projections:(await db.query('SELECT id,status,last_error_code,lease_token,lease_until,completed_at FROM domain_event_notification_projections ORDER BY id')).rows,
  });
  try {
    let expected;
    for(const sql of [before,candidate,actualQuery]) {
      await db.query('BEGIN');
      try {
        await db.query(sql,[at.toISOString(),100]);
        const state=await snapshot();
        if(expected)assert.deepEqual(state,expected,'candidate and observed worker preserve exact per-record outcomes');else expected=state;
        const event=name=>state.events.find(r=>r.id===cases[name].id);
        const projection=(name,i=0)=>state.projections.find(r=>r.id===cases[name].rows[i].id);
        for(const name of ['simple','expiredEvent','expiredAudience','deleted','reclaimed','retry'])assert.equal(event(name).status,'COMPLETED',name);
        assert.equal(event('failedSibling').status,'FAILED_TERMINAL');
        for(const name of ['futureSibling','leasedSibling','malformed','activeDevice','legacyDevice','notExpanded','missingAudience'])assert.equal(event(name).status,'PROJECTING',name);
        assert.equal(event('terminalParent').status,'SUPPRESSED');
        for(const name of ['expiredEvent','expiredAudience'])assert.equal(projection(name).last_error_code,'EVENT_EXPIRED');
        assert.equal(projection('deleted').last_error_code,'RECIPIENT_DELETED');
        assert.equal(projection('reclaimed').lease_token,null);
        assert.equal(projection('leasedSibling',1).lease_token,'other-worker');
        assert.equal(projection('futureSibling',1).status,'PENDING');
        assert.equal(projection('activeDevice').status,'PENDING');
        assert.equal(projection('legacyDevice').status,'PENDING');
      }finally{await db.query('ROLLBACK');}
    }
  }finally{await db.end();}
});

test("full update skips another worker's locked projection", {timeout:90000}, async()=>{
  const actualQuery=await observeWorkerCompletion();
  await cleanDatabase();const {user}=await createTestUser();
  const locked=await createEvent(user.id),available=await createEvent(user.id);
  const owner=await connect(),db=await connect();
  try {
    await owner.query('BEGIN');
    await owner.query('SELECT id FROM domain_event_notification_projections WHERE id=$1 FOR UPDATE',[locked.rows[0].id]);
    for(const sql of [candidate,actualQuery]) {
      await db.query('BEGIN');
      try {
        await db.query("SET LOCAL statement_timeout='2s'");
        assert.equal((await db.query(sql,[new Date().toISOString(),100])).rows[0].processed,1);
        const states=(await db.query('SELECT id,status FROM domain_event_outbox')).rows;
        assert.equal(states.find(r=>r.id===locked.id).status,'PROJECTING');
        assert.equal(states.find(r=>r.id===available.id).status,'COMPLETED');
      }finally{await db.query('ROLLBACK');}
    }
  }finally{await owner.query('ROLLBACK');await owner.end();await db.end();}
});
