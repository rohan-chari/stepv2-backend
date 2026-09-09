#!/usr/bin/env node
// Synthetic, loopback-only integration load. Never run against prod/staging.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const fixedId = (kind, n) => { const h=createHash('sha256').update(`event-load-v2:${kind}:${n}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`; };
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const args = Object.fromEntries(process.argv.slice(2).map(v => {
  const at = v.indexOf('='); assert.ok(v.startsWith('--') && at > 2, 'Use --key=value');
  return [v.slice(2, at), v.slice(at + 1)];
}));
const root = path.resolve(args.root || process.cwd());
const requireTarget = createRequire(path.join(root, 'package.json'));
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
assert.equal(url.port, '55439', 'Dedicated benchmark PG18 port only');
assert.ok(args.output && !fs.existsSync(args.output), 'New output file required');
const size = Number(args.users || 1000), concurrency = Number(args.concurrency || 16);
const durationMs = Number(args.duration || 30) * 1000;
const requestLimit = Number(args.requests || size * 2);
const mode = args.mode || 'paced';
assert.ok(['paced', 'equal-work'].includes(mode));
assert.ok(size >= 100 && size <= 100000 && concurrency >= 1 && concurrency <= 64);
assert.ok(durationMs >= 1000 && durationMs <= 300000 && requestLimit <= 1000000);
// Explicit local-only credentials/config; no tokens/URLs copied into evidence.
process.env.SESSION_TOKEN_SECRET = 'event-load-local-only-session-secret-20260909';
process.env.REDIS_URL = 'redis://127.0.0.1:56379';
process.env.CACHE_ENV_PREFIX = `event-load-${process.pid}:`;
process.env.DATABASE_POOL_MAX_ALL = '20';
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { Client } = requireTarget('pg');
const { prisma, cleanDatabase, startServer, request } = requireTarget('./test/integration/setup');
const { signSessionToken } = requireTarget('./src/modules/users/services/sessionToken');
const { scheduleGlobalStepEvents, buildLocalGlobalStepEventTick } = requireTarget('./src/modules/steps/jobs/globalStepEventScheduler');
const { buildRaceResolutionWorkerV2 } = requireTarget('./src/modules/races/jobs/raceResolutionQueueV2');
const { scheduleGlobalEventSummaryTick } = requireTarget('./src/modules/steps/jobs/globalEventSummary');
const logErrors = [];
const logger = { log() {}, error(...values) {
  if (logErrors.length >= 100) return;
  try { const v=JSON.parse(String(values[0])); logErrors.push({event:v.event,outcome:v.outcome,errorCode:v.errorCode,sqlState:v.sqlState,coreMs:v.coreMs,queueLagMs:v.queueLagMs,reasonClasses:v.reasonClasses}); }
  catch { logErrors.push({message:String(values[0]).slice(0,200),code:values[1]?.code,errorCode:values[1]?.errorCode}); }
} };
const chunk = async (rows, write, n = 500) => { for (let i = 0; i < rows.length; i += n) await write(rows.slice(i, i + n)); };
const quantile = (rows, q) => rows.length ? [...rows].sort((a,b) => a-b)[Math.min(rows.length-1, Math.floor(rows.length*q))] : 0;
function cpuSeconds(value) {
  const parts = value.split(':').map(Number); return parts.reduce((a, b) => a*60+b, 0);
}
async function postgresCpu() {
  const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,time=,command=']);
  const rows = stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/); return m ? { pid:+m[1], ppid:+m[2], cpu:cpuSeconds(m[3]), cmd:m[4] } : null;
  }).filter(Boolean);
  const parent = rows.find(r => r.cmd.includes('postgres ') && r.cmd.includes('bara-event-pg18-20260909'));
  return parent ? rows.filter(r => r.pid === parent.pid || r.ppid === parent.pid) : [];
}
async function main() {
  assert.equal(await prisma.user.count(),0,'Use a freshly migrated or template-cloned benchmark DB for every run');
  await cleanDatabase();
  // The general fixture reset intentionally retains standalone cron receipts.
  // Stable benchmark IDs must not inherit successful summaries from a prior run.
  await prisma.$executeRawUnsafe("DELETE FROM job_runs WHERE job_name LIKE $1", `global_event_summary:${fixedId('event',0)}:%`);
  const users = Array.from({length:size}, (_, i)=>({id:fixedId('user',i), appleId:fixedId('apple',i), displayName:`load_${i}`, timezone:'UTC', globalEventTimezone:'UTC'}));
  await chunk(users, data=>prisma.user.createMany({data}));
  const now = new Date(), raceStarted = new Date(+now - 3*3600000);
  const raceCount = Number(args.races || Math.max(2, Math.ceil(size/50)));
  const races = Array.from({length:raceCount}, (_, i)=>({id:fixedId('race',i), name:`Synthetic load ${i}`, status:'ACTIVE', timezone:'UTC', startedAt:raceStarted, endsAt:new Date(+now+86400000), targetSteps:10000000, maxParticipants:size, powerupsEnabled:false}));
  await chunk(races, data=>prisma.race.createMany({data}));
  const memberships = users.flatMap((u,i)=>[...new Set([i%raceCount,(i+1)%raceCount])].map(r=>({id:fixedId('membership',`${i}:${r}`), raceId:races[r].id,userId:u.id,status:'ACCEPTED',joinedAt:raceStarted})));
  await chunk(memberships, data=>prisma.raceParticipant.createMany({data}));
  const event = await prisma.globalStepEvent.create({data:{ id:fixedId('event',0), startsAt:new Date(+now-1900000),endsAt:new Date(+now-100000),scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2,summaryAttributionVersion:2,eventDay:now.toISOString().slice(0,10),localStartMinute:600,durationMinutes:30,schedulePolicyVersion:1 }});
  await chunk(users.map(u=>({eventId:event.id,userId:u.id,timezone:'UTC',localDate:event.eventDay,startsAt:event.startsAt,endsAt:event.endsAt,startOutcome:'ACTIVATED_ON_TIME',startProcessedAt:event.startsAt})), data=>prisma.globalStepEventEntitlement.createMany({data}));
  await chunk(memberships.map(m=>({eventId:event.id,userId:m.userId,raceId:m.raceId,attributionVersion:2})),data=>prisma.globalEventRaceImpact.createMany({data}));
  // Future schedules exercise timezone relocation while current event ends.
  const future = await prisma.globalStepEvent.create({data:{id:fixedId('event',1),startsAt:new Date(+now+86400000),endsAt:new Date(+now+5*86400000),scheduleMode:'LOCAL_ENTITLEMENTS',multiplier:2,summaryAttributionVersion:2,eventDay:new Date(+now+3*86400000).toISOString().slice(0,10),localStartMinute:600,durationMinutes:30,schedulePolicyVersion:1}});
  const futureStart = new Date(`${future.eventDay}T10:00:00Z`);
  await chunk(users.map(u=>({eventId:future.id,userId:u.id,timezone:'UTC',localDate:future.eventDay,startsAt:futureStart,endsAt:new Date(+futureStart+1800000)})),data=>prisma.globalStepEventEntitlement.createMany({data}));
  // Real generation readiness required for public-path timezone writes.
  const { EXPECTED_LOGICAL_OWNERS,GENERATION_CAPABILITIES,heartbeatGeneration } = requireTarget('./src/modules/steps/models/globalStepEventGeneration');
  for(const offset of [90000,60000,30000,0]) for(const owner of EXPECTED_LOGICAL_OWNERS) await heartbeatGeneration({client:prisma,now:new Date(Date.now()-offset),logicalOwnerId:owner,bootId:`load-${owner}`,capabilities:GENERATION_CAPABILITIES});
  const tokens = users.map(u=>signSessionToken({userId:u.id,appleId:u.appleId}));
  const server = await startServer();
  const monitor = new Client({connectionString:process.env.DATABASE_URL,application_name:'eventbench_monitor'});await monitor.connect();
  const { databasePoolTestSeam } = requireTarget('./src/db');
  const flushStats = async () => {
    const clients = await Promise.all(Array.from({length:20},()=>databasePoolTestSeam.connect()));
    try { await Promise.all(clients.map(c=>c.query('/*eventbench_monitor*/ SELECT pg_stat_force_next_flush()'))); }
    finally { clients.forEach(c=>c.release()); }
    await delay(1200);
    await monitor.query('SELECT pg_stat_clear_snapshot()');
  };
  await monitor.query('ANALYZE'); await flushStats();
  await monitor.query('SELECT pg_stat_statements_reset()');
  const dbStats = async()=> (await monitor.query(`SELECT xact_commit,xact_rollback,tup_inserted,tup_updated,tup_deleted,deadlocks,blks_read,blks_hit,temp_bytes FROM pg_stat_database WHERE datname=current_database()`)).rows[0];
  const before = await dbStats();
  const cpuSeen = new Map((await postgresCpu()).map(r=>[r.pid,r.cpu]));
  let sampledCpuSeconds = 0;
  const sampleCpu = async () => { for(const r of await postgresCpu()) {
    sampledCpuSeconds += Math.max(0,r.cpu-(cpuSeen.get(r.pid)||0)); cpuSeen.set(r.pid,r.cpu);
  } };
  const started = performance.now(), appCpu = process.cpuUsage();
  let stop = false, stopTraffic=false, issued=0, completed=0, schedulerPasses=0, resolutionAttempts=0;
  const acceptedSync = new Set();
  let recoverySyncIssued=0, recoverySyncAccepted=0;
  const expectedScore=mode==='equal-work'?222:221;
  const statusCounts={}, latencies={}, samples=[];
  const sample = async()=>{
    const r = await monitor.query(`/*eventbench_monitor*/ SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name<>'eventbench_monitor' AND wait_event_type='Lock') AS lock_waiters,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND application_name<>'eventbench_monitor' AND state='active') AS active,
      (SELECT count(*)::int FROM global_step_event_entitlements WHERE event_id=$1 AND end_processed_at IS NULL) AS pending_ends,
      (SELECT count(*)::int FROM race_resolution_jobs_v2 WHERE state::text IN ('queued','running')) AS pending_races,
      (SELECT count(*)::int FROM race_resolution_jobs_v2 WHERE state::text='failed') AS failed_races,
      (SELECT count(*)::int FROM global_event_summary_work WHERE event_id=$1 AND status NOT IN ('CREATED','ALL_ZERO','UNSCORABLE','EXPIRED_UNDELIVERED')) AS pending_summaries,
      (SELECT count(*)::int FROM global_event_summary_work WHERE event_id=$1 AND status IN ('CREATED','ALL_ZERO')) AS successful_summaries`,[event.id]);
    await sampleCpu(); samples.push({ms:performance.now()-started,sampledCpuSeconds,...r.rows[0]});
  };
  const sampling=(async()=>{while(!stop){await sample();await delay(200);}})();
  const heartbeats=(async()=>{ while(!stop) {
    for(const owner of EXPECTED_LOGICAL_OWNERS) await heartbeatGeneration({client:prisma,now:new Date(),logicalOwnerId:owner,bootId:`load-${owner}`,capabilities:GENERATION_CAPABILITIES});
    for(let i=0;i<50 && !stop;i++) await delay(100);
  } })();
  const resolution=buildRaceResolutionWorkerV2({bootAt:0,logger});
  const summary=scheduleGlobalEventSummaryTick({logger});
  const workers=Array.from({length:2},()=> (async()=>{while(!stop){try{const r=await resolution.processOne();if(r)resolutionAttempts++;}catch(e){logger.error(e.code||e.message)}await delay(50);}})());
  let scheduler;
  let equalDrain;
  const schedulerImplementation = mode==='paced' || fs.existsSync(path.join(root,'src/modules/steps/jobs/globalEventEndDrain.js')) ? 'production-scheduler' : 'accelerated-legacy-maintenance';
  if(schedulerImplementation==='production-scheduler') scheduler=scheduleGlobalStepEvents({logger});
  else equalDrain=(async()=>{const tick=buildLocalGlobalStepEventTick({logger});while(!stop){await tick();schedulerPasses++;if(!await prisma.globalStepEventEntitlement.count({where:{eventId:event.id,endProcessedAt:null}}))break;await delay(1)}})();
  const traffic=Array.from({length:concurrency},(_, lane)=>(async()=>{
    while(!stopTraffic && issued<requestLimit){const n=issued++;const i=n%size;const visit=Math.floor(n/size);const op=(i+visit)%5;const type=n<size?'sync':op===0?'timezone':op===1?'read':'sync';const tz=i%10===0?'America/New_York':'UTC';const begin=performance.now();let status;
      try{let response;if(type==='sync')response=await request(server.baseUrl,'POST','/steps/sync-v2',{token:tokens[i],headers:{'Idempotency-Key':fixedId('request',n),'X-Timezone':tz},body:{date:now.toISOString().slice(0,10),steps:161,samples:[{periodStart:new Date(+now-7200000).toISOString(),periodEnd:new Date(+now-5400000).toISOString(),steps:100},{periodStart:event.startsAt.toISOString(),periodEnd:event.endsAt.toISOString(),steps:60},{periodStart:event.endsAt.toISOString(),periodEnd:now.toISOString(),steps:1}]}});
      else response=await request(server.baseUrl,'GET',type==='read'?`/races/${races[i%raceCount].id}/progress`:'/auth/me',{token:tokens[i],headers:{'X-Timezone':tz,'X-Client-Features':n%2?'powerups2,powerups3,powerups4,powerups5':''}});
      status=response.status;await response.arrayBuffer();if(type==='sync' && status===202)acceptedSync.add(users[i].id);}catch(e){status='transport_error';logger.error(e.message)}
      (latencies[type] ||= []).push(performance.now()-begin);statusCounts[`${type}:${status}`]=(statusCounts[`${type}:${status}`]||0)+1;completed++;
    }
  })());
  while(performance.now()-started<durationMs){await delay(100)}
  stopTraffic=true; await Promise.all(traffic);
  const trafficElapsedMs=performance.now()-started;
  if(mode==='equal-work') {
    const recoveryDeadline=performance.now()+Number(args.recovery||120)*1000;
    // Summary capture intentionally waits for a fresh health observation. An
    // initial sync can precede creation of its end work; unchanged repeats do
    // not substitute for that observation. Offer the same measured catch-up
    // wave after ends drain, through HTTP, for both implementations.
    while(performance.now()<recoveryDeadline && samples.at(-1)?.pending_ends) await delay(100);
    let catchupIndex=0;
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(catchupIndex<size && performance.now()<recoveryDeadline) {
        const i=catchupIndex++; recoverySyncIssued++; const begin=performance.now(); let status;
        try {
          const response=await request(server.baseUrl,'POST','/steps/sync-v2',{
            token:tokens[i],headers:{'Idempotency-Key':fixedId('catchup',i),'X-Timezone':i%10===0?'America/New_York':'UTC'},
            body:{date:now.toISOString().slice(0,10),steps:162,samples:[
              {periodStart:new Date(+now-7200000).toISOString(),periodEnd:new Date(+now-5400000).toISOString(),steps:100},
              {periodStart:event.startsAt.toISOString(),periodEnd:event.endsAt.toISOString(),steps:60},
              {periodStart:event.endsAt.toISOString(),periodEnd:now.toISOString(),steps:2}]}});
          status=response.status;await response.arrayBuffer();if(status===202)recoverySyncAccepted++;
        } catch(e) {status='transport_error';logger.error(e.message)}
        (latencies.recoverySync ||= []).push(performance.now()-begin);
        statusCounts[`recoverySync:${status}`]=(statusCounts[`recoverySync:${status}`]||0)+1;
      }
    }));
    while(performance.now()<recoveryDeadline) {
      const last=samples.at(-1);
      if(last && !last.pending_ends && !last.pending_races && !last.failed_races && last.successful_summaries===size)break;
      await delay(250);
    }
  }
  stop=true;if(scheduler)await scheduler.stop();await summary.stop();await Promise.all([...workers,sampling,heartbeats,...(equalDrain?[equalDrain]:[])]);await sample();
  const measuredElapsedMs=performance.now()-started;
  await flushStats();const after=await dbStats();
  const stats=(await monitor.query(`SELECT queryid::text,calls,total_exec_time,rows,shared_blks_hit,shared_blks_read,wal_bytes::text,query ~* 'INSERT INTO (public\\.)?race_resolution_jobs_v2' AS race_queue_upsert, query ~* 'INSERT INTO (public\\.)?global_event_summary_work' AS summary_insert, query ~* 'UPDATE.*global_step_event_entitlements' AS entitlement_update, left(query,300) AS query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%eventbench_monitor%' ORDER BY total_exec_time DESC`)).rows;
  const final=await prisma.globalStepEventEntitlement.groupBy({by:['timezone'],where:{eventId:future.id},_count:true});
  const summaryStates = await prisma.globalEventSummaryWork.groupBy({by:['status'],where:{eventId:event.id},_count:true});
  const raceStates = await prisma.raceResolutionJobV2.groupBy({by:['state'],_count:true});
  const artifacts = await prisma.globalEventCaptureArtifact.count({where:{eventId:event.id}});
  const badTotals = await prisma.raceParticipant.count({where:{userId:{in:[...acceptedSync]},totalSteps:{not:expectedScore}}});
  const finalState=samples.at(-1);
  const completion = {offeredAll:issued===requestLimit,acceptedSyncUsers:acceptedSync.size,expectedScoredSteps:expectedScore,recoverySyncIssued,recoverySyncAccepted,badParticipantTotals:badTotals,summaryStates,raceStates,artifacts,fullyDrained:issued===requestLimit&&acceptedSync.size===size&&(mode!=='equal-work'||recoverySyncAccepted===size)&&!finalState.pending_ends&&!finalState.pending_races&&!finalState.failed_races&&finalState.successful_summaries===size&&badTotals===0};
  const data={harnessVersion:4,schedulerImplementation,trafficElapsedMs,measuredElapsedMs,completion,source:args.label||'unknown',mode,size,raceCount,memberships:memberships.length,concurrency,requestLimit,durationMs,elapsedMs:performance.now()-started,issued,completed,statusCounts,latencies:Object.fromEntries(Object.entries(latencies).map(([k,v])=>[k,{count:v.length,p50:quantile(v,.5),p95:quantile(v,.95),p99:quantile(v,.99),max:Math.max(...v)}])),resolutionAttempts,schedulerPasses,dbDelta:Object.fromEntries(Object.entries(after).map(([k,v])=>[k,Number(v)-Number(before[k])])),postgresCpuSecondsSampled:sampledCpuSeconds,cpuAccounting:'Sum of per-PID observed CPU increments at ~200ms; exited PID totals retained. Lower-bound estimate: final unsampled tail/short-lived processes can be missed.',appCpu:process.cpuUsage(appCpu),samples,statements:stats,futureTimezoneCounts:final,errors:logErrors,resources:{postgres:'18',poolMax:20,resolutionLoops:2,hostCpus:require('node:os').cpus().length,hostMemory:require('node:os').totalmem(),note:'Local shared host; one all-role app process, separate PostgreSQL18/Redis. Not production CPU certification.'}};
  fs.writeFileSync(args.output,JSON.stringify(data,null,2)+'\n');console.log(JSON.stringify({output:args.output,completed,statusCounts,pendingEnds:samples.at(-1).pending_ends,dbDelta:data.dbDelta,postgresCpuSecondsSampled:data.postgresCpuSecondsSampled,completion}));
  await server.close();await monitor.end();await prisma.$disconnect();
}
main().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1)});
