// Identical synthetic trace, real HTTP intake/read paths and production workers.
// No production data/credentials. Fixture setup is excluded from measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const [root, variant, output] = process.argv.slice(2);
assert.ok(root && output && ['baseline', 'candidate'].includes(variant));
const db = new URL(process.env.DATABASE_URL);
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '55441');
assert.match(db.pathname, /^\/bara_recap_(baseline|candidate)_test$/);
assert.equal(process.env.REDIS_URL, 'redis://127.0.0.1:16437/0');
assert.equal(process.env.NODE_ENV, 'test');
process.chdir(root);
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require(path.join(root, 'test/integration/setup'));
const { Client } = require(path.join(root, 'node_modules/pg'));
const Redis = require(path.join(root, 'node_modules/ioredis'));
const redis = new Redis(process.env.REDIS_URL);
const observer = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'recap-benchmark-observer' });
const sql = [], requests = [], snapshots = [], children = [];
function sourceFingerprint() {
  const paths = execFileSync('git',['ls-files','--cached','--others','--exclude-standard','src','prisma/schema.prisma','package.json','package-lock.json'],{cwd:root,encoding:'utf8'}).trim().split('\n');
  const hash=createHash('sha256');
  for(const name of [...new Set(paths)].sort())if(name && fs.existsSync(path.join(root,name)))hash.update(name+'\0').update(fs.readFileSync(path.join(root,name)));
  return hash.digest('hex');
}
let phase = 'fixture', server, summary, workerLog = '';
const evidence = { variant, revision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  startedAt: new Date().toISOString(), sourceFingerprint:sourceFingerprint(), sql, requests, snapshots,
  trace: { users: 6, sharedRaces: 3, samplesPerUser: 6, rawStepsPerUser: 60, eventSeconds: 1800, idleSeconds: 65 },
  limitations: ['Synthetic local trace, not a production CPU/capacity guarantee.', 'SQL timings include waits, not CPU.', 'OS CPU sampling is cumulative process-time at 10ms precision; exited processes between samples may be missed.', 'Fixtures and outcome observer queries excluded from application SQL; observers still use DB resources.', 'Legacy counterfactual and simple recaps intentionally differ in general; this no-powerup trace should agree.'] };
prisma.$on('query', e => sql.push({phase, process:'http-boundary-summary', durationMs:e.duration, query:e.query}));
const headers = {'X-App-Version':'2.3.13','X-Timezone':'UTC','X-Client-Features':'characters,remote_assets,race_leave,api_payload_compact_v1,powerups4,powerups5,team_races,seeded_race_buckets,privacy_safe_display_ranks,impact_summaries,impact_summary_expiry_v1' + (variant === 'candidate' ? ',simple_event_recap_v1' : '')};
async function http(user, method, route, body) {
  const start = Date.now();
  const res = await request(server.baseUrl, method, route, {token:user.token, headers:{...headers,...(method==='POST'?{'Idempotency-Key':randomUUID()}:{})}, body});
  const value = await res.json();
  requests.push({phase, user:user.index, method, route, status:res.status, elapsedMs:Date.now()-start});
  assert.ok(res.status >= 200 && res.status < 300, `${route} ${res.status} ${JSON.stringify(value)}`);
  return value;
}
async function waitFor(fn, label, timeout=120000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) {
    for (const c of children) assert.equal(c.exitCode, null, 'worker exited '+workerLog.slice(-3000));
    if (await fn()) return;
    await delay(200);
  }
  throw Error('Timed out '+label+' '+workerLog.slice(-3000));
}
async function drain(races) {
  await waitFor(async()=>{
    const {rows:[r]}=await observer.query(`SELECT
      (SELECT count(*) FROM race_resolution_jobs_v2 WHERE race_id=ANY($1::text[]) AND (state<>'succeeded' OR committed_generation<generation)) AS jobs,
      (SELECT count(*) FROM race_resolution_post_tasks WHERE race_id=ANY($1::text[]) AND state IN ('queued','running')) AS tasks,
      (SELECT count(*) FROM race_placement_transition_jobs WHERE race_id=ANY($1::text[]) AND state IN ('queued','running','retry')) AS placements`,[races]);
    return +r.jobs===0 && +r.tasks===0 && +r.placements===0;
  },'ordinary jobs drained');
}
async function snapshot(label) {
  const {rows: tables}=await observer.query(`SELECT relname,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables ORDER BY relname`);
  const {rows:[wal]}=await observer.query(`SELECT pg_current_wal_lsn()::text AS lsn`);
  snapshots.push({label,at:new Date().toISOString(),tables,wal});
}
const cpuMax = new Map(), cpuStart = new Map(); let cpuTimer;
function cpuSample() {
  const parent=Number(fs.readFileSync(path.join(path.dirname(output),'pgdata/postmaster.pid'),'utf8').split('\n')[0]);
  const rows=execFileSync('ps',['-axo','pid=,ppid=,time='],{encoding:'utf8'}).trim().split('\n');
  for(const row of rows) {
    const [pid,ppid,time]=row.trim().split(/\s+/);
    if(+pid!==parent && +ppid!==parent) continue;
    const parts=time.split(':').map(Number); const seconds=parts.reduce((a,n)=>a*60+n,0);
    cpuMax.set(pid,Math.max(cpuMax.get(pid)||0,seconds));
  }
}
async function main() {
  await observer.connect(); await cleanDatabase(); await redis.flushdb(); server=await getSharedServer();
  const users=[];
  for(let i=0;i<6;i++) users.push({...await createTestUser({displayName:'Recap synthetic '+i,timezone:'UTC'}),index:i});
  const now=Date.now(), races=[];
  for(let i=0;i<3;i++) {
    const r=await prisma.race.create({data:{name:'Recap trace '+i,creatorId:users[0].user.id,status:'ACTIVE',timezone:'UTC',targetSteps:1000000,maxParticipants:100,startedAt:new Date(now-86400000),endsAt:new Date(now+86400000),powerupsEnabled:true}});
    races.push(r.id);
    await prisma.raceParticipant.createMany({data:users.map(u=>({raceId:r.id,userId:u.user.id,status:'ACCEPTED',joinedAt:new Date(now-86400000),buyInStatus:'NONE'}))});
  }
  const eventEnd=Date.now()+20000, eventStart=eventEnd-1800000, date=new Date(eventStart).toISOString().slice(0,10);
  const event=await prisma.globalStepEvent.create({data:{startsAt:new Date(eventStart),endsAt:new Date(eventEnd),scheduleMode:'LOCAL_ENTITLEMENTS',...(variant==='baseline'?{summaryAttributionVersion:2}:{}),multiplier:2}});
  await prisma.globalStepEventEntitlement.createMany({data:users.map(u=>({eventId:event.id,userId:u.user.id,timezone:'UTC',localDate:date,startsAt:event.startsAt,endsAt:event.endsAt}))});
  await snapshot('before'); cpuSample(); for(const [p,n] of cpuMax)cpuStart.set(p,n); cpuTimer=setInterval(cpuSample,200);
  phase='startup-and-start';
  const observerPath=path.join(path.dirname(output),'worker-observer-'+variant+'.cjs');
  fs.writeFileSync(observerPath,`const {prisma}=require(${JSON.stringify(path.join(root,'src/db'))});prisma.$on('query',e=>process.send?.({query:e.query,durationMs:e.duration}));`);
  const child=spawn(process.execPath,['--require',observerPath,'src/index.js'],{cwd:root,env:{...process.env,STEPS_PROCESS_ROLE:'resolution',NODE_APP_INSTANCE:'0',PORT:'0',CRON_START_DELAY_MS:'0',RACE_QUEUE_V2_QUIET_PERIOD_MS:'0',ASYNC_RACE_RESOLUTION_CONCURRENCY:'3'},stdio:['ignore','pipe','pipe','ipc']});
  children.push(child); child.on('message',m=>{if(m.query)sql.push({...m,phase,process:'resolution'});});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{workerLog+=b;fs.appendFileSync(output+'.live-worker.log',b);});
  const steps=require(path.join(root,'src/modules/steps'));
  summary=steps.scheduleGlobalEventSummaryTick?.();
  evidence.summarySchedulerPresent=!!summary;
  evidence.startResult=await steps.buildGlobalEventBoundaryDrain().runUntilIdle();
  assert.equal(evidence.startResult.failures,0);
  await drain(races);
  phase='wait-event-end'; await delay(Math.max(0,eventEnd-Date.now()+100));
  phase='end';
  const endJob=require(path.join(root,'src/modules/steps/jobs/globalEventEndDrain')).buildGlobalEventEndDrain();
  await waitFor(async()=>{const r=await endJob.run();return !r.more && r.failures===0;},'event end');
  phase='app-open-sync-and-recap'; const start=Date.now();
  const samples=Array.from({length:6},(_,i)=>({periodStart:new Date(eventStart+i*300000).toISOString(),periodEnd:new Date(eventStart+(i+1)*300000).toISOString(),steps:10}));
  for(const user of users) {
    await http(user,'POST','/steps/sync-v2',{date,steps:60,samples});
    if(variant==='candidate') {
      const r=await http(user,'GET','/home/event-recap');
      assert.equal(r.state,'pending',JSON.stringify(r));
      const saved=await http(user,'POST','/home/event-recap',{eventId:event.id,revision:r.event.revision,rawSteps:60});
      assert.equal(saved.globalEventSummary?.extraRaceSteps,180);
    }
  }
  await drain(races);
  phase='recap-completion';
  await waitFor(async()=>{
    const table=variant==='baseline'?'global_event_user_summaries':'event_recaps';
    const {rows:[r]}=await observer.query(`SELECT count(*) AS count FROM ${table} WHERE event_id=$1`,[event.id]);
    return +r.count===6;
  },'all six saved recaps');
  await drain(races); evidence.completionMs=Date.now()-start;
  phase='outcome-http'; evidence.outcomes=[];
  for(const user of users) {
    const home=await http(user,'GET','/home/race-card?view=shell-v1&homeActiveRaces=1&localDate='+date);
    const recap=home.globalEventSummary; assert.equal(recap?.extraRaceSteps,180,JSON.stringify(home));
    const scores=[];
    for(const raceId of races) {
      const p=await http(user,'GET',`/races/${raceId}/progress`);
      const entry=p.progress?.participants?.find(p=>p.userId===user.user.id);
      assert.equal(entry?.totalSteps,120); scores.push(entry.totalSteps);
    }
    evidence.outcomes.push({user:user.index,recap:recap.extraRaceSteps,scores});
    await http(user,'POST',`/home/global-event-summaries/${recap.id}/acknowledge`,{});
  }
  phase='settled-idle'; await snapshot('before-idle'); await delay(65000); await snapshot('after-idle');
  await drain(races); evidence.success=true;
}
main().catch(e=>{evidence.success=false;evidence.error=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{
  clearInterval(cpuTimer); try{cpuSample();}catch{}
  evidence.dbCpuSeconds=Array.from(cpuMax,([p,n])=>n-(cpuStart.get(p)||0)).reduce((a,n)=>a+n,0);
  await summary?.stop();
  for(const c of children)if(c.exitCode===null)await new Promise(resolve=>{c.once('exit',resolve);c.kill('SIGTERM');setTimeout(()=>c.kill('SIGKILL'),5000).unref();});
  try{await snapshot('final');}catch{}
  evidence.finishedAt=new Date().toISOString();
  evidence.finalSourceFingerprint=sourceFingerprint();
  evidence.sourceUnchanged=evidence.sourceFingerprint===evidence.finalSourceFingerprint;
  evidence.phaseSql={}; for(const r of sql){if(r.phase==='fixture')continue;const s=evidence.phaseSql[r.phase]||={commands:0,elapsedMs:0};s.commands++;s.elapsedMs+=r.durationMs||0;}
  fs.writeFileSync(output,JSON.stringify(evidence,null,2));fs.writeFileSync(output+'.worker.log',workerLog);
  if(server)await server.close();await prisma.$disconnect();await observer.end();await redis.quit();process.exit(process.exitCode||0);
});
