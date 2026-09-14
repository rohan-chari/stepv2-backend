process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require('./setup');
let server;
before(async () => {
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS cleanup_fixture');
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS cleanup_fixture.pg_stat_replication (
    application_name text,state text,sent_lsn pg_lsn,write_lsn pg_lsn,flush_lsn pg_lsn,
    replay_lsn pg_lsn,replay_lag interval,reply_time timestamptz)`);
});
after(async () => { if (server) await server.close(); await prisma.$disconnect(); });
async function monitoring(rows) {
  await prisma.$executeRawUnsafe('TRUNCATE cleanup_fixture.pg_stat_replication');
  for (const row of rows) {
    await prisma.$executeRawUnsafe(`INSERT INTO cleanup_fixture.pg_stat_replication
      VALUES($1,$2,$3::pg_lsn,$4::pg_lsn,$5::pg_lsn,$6::pg_lsn,$7::interval,
        clock_timestamp()+$8::interval)`, row.name || 'pghoard',row.state || 'streaming',
      row.sent === undefined ? '0/100' : row.sent,row.write === undefined ? '0/100' : row.write,
      row.flush === undefined ? '0/100' : row.flush,row.replay ?? null,row.lag ?? null,
      row.replyAge === undefined ? '0 seconds' : row.replyAge);
  }
}
async function fixture() {
  await cleanDatabase();
  const user = await createTestUser({ timezone: 'UTC' });
  const race = await prisma.race.create({ data: { id: randomUUID(),creatorId:user.user.id,
    name:'Cleanup guard race',status:'ACTIVE',targetSteps:1000000,powerupsEnabled:false,
    startedAt:new Date(Date.now()-3600000),endsAt:new Date(Date.now()+86400000) } });
  await prisma.raceParticipant.create({ data: {raceId:race.id,userId:user.user.id,
    status:'ACCEPTED',joinedAt:new Date(Date.now()-3600000),buyInStatus:'NONE'} });
  async function task(generation, overrides={}) {
    const old=new Date(Date.now()-9*86400000);
    return prisma.raceResolutionPostTask.create({data:{raceId:race.id,sourceGeneration:generation,
      dedupeKey:`cleanup:${race.id}:${generation}`,state:'succeeded',snapshotState:'succeeded',
      requestedAt:old,notBeforeAt:old,completedAt:old,snapshotCommand:{raceId:race.id,timeZone:'UTC'},
      payloadBytes:100,intentCount:0,...overrides}});
  }
  return {user,race,task};
}
function worker() {
  const messages=[];let logs='';
  const child=spawn(process.execPath,['--require','./test/integration/fixtures/cleanup-replication/worker.cjs','src/index.js'],{
    env:{...process.env,NODE_ENV:'test',STEPS_PROCESS_ROLE:'resolution',NODE_APP_INSTANCE:'0',PORT:'0',CRON_START_DELAY_MS:'0',REDIS_URL:''},
    stdio:['ignore','pipe','pipe','ipc']});
  child.on('message',m=>messages.push(m));child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  return {messages,logs:()=>logs,async stop(){if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}};
}
async function until(check,w) {
  const end=Date.now()+8000;
  while(Date.now()<end){if(await check())return;await delay(50);}
  assert.fail('cleanup condition timed out: '+w.logs().slice(-1500));
}
async function publicProgress(f) {
  server ||= await getSharedServer();
  const res=await request(server.baseUrl,'GET',`/races/${f.race.id}/progress`,{token:f.user.token,headers:{'X-Timezone':'UTC'}});
  assert.equal(res.status,200);return res.json();
}
test('real cleanup ignores backup replay age, deletes old payloads with receipts, preserves protected work and public totals', {timeout:30000},async()=>{
  const f=await fixture();await monitoring([{lag:'133 hours'}]);
  const old=await f.task(1);
  const fresh=await f.task(2,{completedAt:new Date()});
  const twoDays=await f.task(5,{completedAt:new Date(Date.now()-2*86400000)});
  const pending=await f.task(3,{state:'queued',snapshotState:'pending',completedAt:null,notBeforeAt:new Date(Date.now()+86400000)});
  const collision=await f.task(4);
  await prisma.raceResolutionPostTaskReceipt.create({data:{raceId:f.race.id,sourceGeneration:4,
    dedupeKey:collision.dedupeKey,terminalState:'succeeded_with_failures',snapshotState:'succeeded',
    intentCount:0,failureCount:1,completedAt:collision.completedAt}});
  const before=await publicProgress(f);const w=worker();
  try {
    await until(async()=>!(await prisma.raceResolutionPostTask.findUnique({where:{id:old.id}})),w);
    const receipt=await prisma.raceResolutionPostTaskReceipt.findUnique({where:{raceId_sourceGeneration:{raceId:f.race.id,sourceGeneration:1}}});
    assert.equal(receipt.terminalState,'succeeded');assert.equal(receipt.snapshotState,'succeeded');
    assert.equal(receipt.dedupeKey,old.dedupeKey);assert.equal(+receipt.completedAt,+old.completedAt);
    for(const t of [fresh,twoDays,pending,collision])assert.ok(await prisma.raceResolutionPostTask.findUnique({where:{id:t.id}}));
    const after=await publicProgress(f);
    assert.deepEqual(after.progress.participants.map(p=>[p.userId,p.totalSteps]),before.progress.participants.map(p=>[p.userId,p.totalSteps]));
  } finally {await w.stop();}
});
for (const scenario of [
  {name:'backup plus healthy standby',rows:[{lag:'133 hours'},{name:'standby',replay:'0/100',lag:'1 second'}],allowed:true},
  {name:'non-streaming backup',rows:[{state:'catchup',lag:'133 hours'}],allowed:false},
  {name:'backup missing write evidence',rows:[{write:null,lag:'133 hours'}],allowed:false},
  {name:'backup missing flush evidence',rows:[{flush:null,lag:'133 hours'}],allowed:false},
  {name:'backup missing reply evidence',rows:[{replyAge:null,lag:'133 hours'}],allowed:false},
  {name:'standby missing reply evidence',rows:[{name:'standby',replay:'0/100',lag:'1 second',replyAge:null}],allowed:false},
  {name:'no replication connections',rows:[],allowed:true},
  {name:'healthy standby',rows:[{name:'standby',replay:'0/100',lag:'1 second'}],allowed:true},
  {name:'idle caught-up standby without lag',rows:[{name:'standby',replay:'0/100'}],allowed:true},
  {name:'backup plus lagging standby',rows:[{lag:'133 hours'},{name:'standby',replay:'0/80',lag:'6 seconds'}],allowed:false},
  {name:'unknown receiver without replay evidence',rows:[{name:'standby'}],allowed:false},
  {name:'standby behind with unavailable lag',rows:[{name:'standby',replay:'0/80'}],allowed:false},
  {name:'stale backup connection',rows:[{lag:'133 hours',replyAge:'-2 minutes'}],allowed:false},
  {name:'backup name with real replay position',rows:[{replay:'0/80',lag:'6 seconds'}],allowed:false},
  {name:'stale standby even with small lag',rows:[{name:'standby',replay:'0/100',lag:'1 second',replyAge:'-2 minutes'}],allowed:false},
]) test(`real scheduled cleanup: ${scenario.name}`,{timeout:15000},async()=>{
  const f=await fixture();await monitoring(scenario.rows);const old=await f.task(1);const w=worker();
  try {
    if(scenario.allowed)await until(async()=>!(await prisma.raceResolutionPostTask.findUnique({where:{id:old.id}})),w);
    else {
      await until(()=>w.messages.filter(m=>m.query.includes('pg_stat_replication')).length>=3,w);
      assert.ok(await prisma.raceResolutionPostTask.findUnique({where:{id:old.id}}));
      assert.equal(w.messages.filter(m=>m.query.includes('DELETE FROM race_resolution_post_tasks task')).length,0);
    }
  }finally{await w.stop();}
});

test('real cleanup resumes on a later tick after actual standby lag clears', {timeout:15000},async()=>{
  const f=await fixture();await monitoring([{name:'standby',replay:'0/80',lag:'6 seconds'}]);
  const old=await f.task(1);const w=worker();
  try {
    await until(()=>w.messages.filter(m=>m.query.includes('pg_stat_replication')).length>=3,w);
    assert.ok(await prisma.raceResolutionPostTask.findUnique({where:{id:old.id}}));
    await monitoring([{lag:'133 hours'},{name:'standby',replay:'0/100',lag:'1 second'}]);
    await until(async()=>!(await prisma.raceResolutionPostTask.findUnique({where:{id:old.id}})),w);
  }finally{await w.stop();}
});
