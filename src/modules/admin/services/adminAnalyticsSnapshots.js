const { randomUUID, createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { pool: defaultPool } = require('../../../db');
const redisDefault = require('../../../shared/cache/redisCache');
const { classifyAdminStatsRequest, buildWindow, buildGetAdminMetricsDashboard } = require('../adminMetricsDashboard');
const {classifyView}=require('./adminPagePlan');
const {extractPage,envelopePage,configuredReferralVersion}=require('./adminPageExtraction');
const { extractRelationalSummary } = require('./adminRelationalExtraction');
const VERSION = 'v1';
const PREFIX = `admin:analytics:${VERSION}:`;
const LEASE_KEY = PREFIX+'lease';
const FRESH_MS=900000, STALE_MS=86400000;
const localCaches=new Set();
let invalidationRegistered=false;
function ensureInvalidation(){
  if(invalidationRegistered)return;
  invalidationRegistered=true;
  require('../../../shared/cache/derivedCache').onInvalidate(PREFIX,()=>{for(const cache of localCaches)cache.clear();});
}

async function invalidateAdminAnalytics() {
  for(const cache of localCaches)cache.clear();
  // Identity is re-read authoritatively on every request. This signal also
  // evicts peer-local copies; no global cache semantics are changed.
  await redisDefault.publishInvalidate({prefix:PREFIX}).catch(()=>{});
}
function unavailable(){const error=Error('Admin analytics are temporarily unavailable');error.statusCode=503;error.code='ADMIN_ANALYTICS_UNAVAILABLE';return error;}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function buildAdminAnalyticsSnapshots(dependencies={}) {
  const pool=dependencies.pool||defaultPool, redis=dependencies.adminAnalyticsRedis||redisDefault;
  const now=dependencies.adminAnalyticsNow||(()=>new Date());
  const observe=dependencies.adminAnalyticsObserver||(event=>{if(!['query','pageBatch','pageFetch','pageSource'].includes(event.event))console.info('[adminAnalytics]',JSON.stringify(event));});
  const settings=dependencies.appSettings||require('../../../shared/config/appSettings').appSettings;
  const local=new Map(),localFailures=new Map();localCaches.add(local);localCaches.add(localFailures);ensureInvalidation();let running=null;
  function remember(key,value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>16*1024*1024)return;local.delete(key);local.set(key,{value,bytes});let localBytes=[...local.values()].reduce((n,v)=>n+v.bytes,0);while(local.size>64||localBytes>16*1024*1024){const first=local.keys().next().value;localBytes-=local.get(first).bytes;local.delete(first);}}
  function bounded(promise,milliseconds,signal,onLate){
    return new Promise((resolve,reject)=>{let settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};const abort=()=>finish(signal.reason||unavailable());const timer=setTimeout(()=>finish(unavailable()),milliseconds);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();promise.then(value=>{if(settled){onLate?.(value);return;}finish(null,value);},error=>finish(error));});
  }
  async function lua(script,keys,args=[],signal,deadlineAt=Infinity){const remaining=deadlineAt-Date.now();if(remaining<=0)throw unavailable();const result=await bounded(redis.evalLua(script,keys,args),Math.min(1500,remaining),signal);if(!result.ok)throw unavailable();return result.result;}

  async function identity(existingClient){
    const client=existingClient||await bounded(pool.connect(),5000,null,client=>client.release());
    try{
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    // This is a tiny configuration read, never an analytics-table scan. It
    // establishes the identity even when Redis is down; unknown means 503.
    const result=await client.query(`SELECT
      (SELECT jsonb_build_object('id',id,'started_at',started_at AT TIME ZONE 'UTC') FROM admin_metrics_collection_epochs WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1) epoch,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('metric',metric,'operational_at',operational_at AT TIME ZONE 'UTC') ORDER BY metric) FROM metric_coverage_starts),'[]'::jsonb) coverage,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('key',key,'value',value,'updated_at',updated_at) ORDER BY key) FROM app_settings WHERE key IN ('adminMetricsV2DashboardEnabled','adminMetricsV2TelemetryEnabled')),'[]'::jsonb) config`);
    const enabled=await settings.getFlag('adminMetricsV2DashboardEnabled');const telemetry=await settings.getFlag('adminMetricsV2TelemetryEnabled');
    const value={...result.rows[0],enabled,telemetry,referralHmacVersion:configuredReferralVersion()};await client.query("COMMIT");return {...value,key:hash(value)};
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{if(!existingClient)client.release();}
  }
  function usable(value,at){return value&&Number.isFinite(Date.parse(value.generatedAt))&&at-Date.parse(value.generatedAt)>=0&&at-Date.parse(value.generatedAt)<STALE_MS;}
  function decorate(value,at){const fresh=at-Date.parse(value.generatedAt)<FRESH_MS;observe({event:fresh?'hit':'stale'});const snapshot={generatedAt:value.generatedAt,freshUntil:new Date(Date.parse(value.generatedAt)+FRESH_MS).toISOString(),status:fresh?'fresh':'stale',refreshIntervalSeconds:900};return {...value,snapshot,...(value.sections?{sections:Object.fromEntries(Object.entries(value.sections).map(([k,v])=>[k,{...v,snapshot}]))}:{})};}
  async function read(key,deadlineAt){const raw=await lua("return redis.call('GET',KEYS[1])",[key],[],undefined,deadlineAt);return raw?JSON.parse(raw):null;}
  function sectionBackoff(config,mode) {
    if(mode.mode==='view')return PREFIX+'failure:'+config.key+':view:'+mode.view+':'+mode.days;
    const section=mode.mode==='dashboard'?mode.section:`legacy:${[...mode.legacySections].sort().join(',')}`;
    return PREFIX+'failure:'+config.key+':section:'+section;
  }
  async function attempt(key,config,mode,options,artifactKey,requestDeadline){
    if(running)return;
    const token=randomUUID(),backoff=PREFIX+'failure:'+config.key,sectionFailure=sectionBackoff(config,mode);
    const acquired=await lua("if redis.call('EXISTS',KEYS[2]) == 1 or redis.call('EXISTS',KEYS[3]) == 1 then return 0 end; if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',60000) then return 1 end; return 0",[LEASE_KEY,backoff,sectionFailure],[token],undefined,requestDeadline);
    if(acquired!==1)return;
    const controller=dependencies.adminAnalyticsAbortControllerFactory?.()||new AbortController();const started=Date.now();
    const deadline=setTimeout(()=>controller.abort(Error('Analytics build deadline exceeded')),45000);
    const renewal=setInterval(async()=>{try{const renewed=await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],60000) end; return 0",[LEASE_KEY],[token]);if(renewed!==1)controller.abort(Error('Analytics lease lost'));}catch(error){controller.abort(error);}},15000);
    running=(async()=>{
      let client;let transaction=false;let sequence=Promise.resolve();let failureScope='shared';
      try{
        client=await bounded(pool.connect(),45000,controller.signal,client=>client.release());controller.signal.throwIfAborted();
        let shared=null;let pageValue=null;let actionRows=null;
        if(mode.mode==='view'){failureScope='section';pageValue=await extractPage({client,identity:config,generatedAt:now().toISOString(),signal:controller.signal,observe,view:mode.view,days:mode.days,workerFactory:dependencies.adminPageWorkerFactory});}
        if(mode.mode==='dashboard'){
          shared=await read(artifactKey);
          if(!shared||now().getTime()-Date.parse(shared.generatedAt)>=FRESH_MS){
            shared=await extractRelationalSummary({client,identity:config,generatedAt:now().toISOString(),signal:controller.signal,observe});
            controller.signal.throwIfAborted();
            const published=await lua("local t=redis.call('TIME'); if tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)>tonumber(ARGV[3]) or redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'PX',86400000); return 1",[LEASE_KEY,artifactKey],[token,JSON.stringify(shared),started+45000],controller.signal);
            if(published!==1)throw Error('Analytics lease lost before artifact publication');
          }
        }
        controller.signal.throwIfAborted();
        failureScope='section';
        if(mode.mode==='dashboard'&&mode.section==='dashboard-dau-engagement'){const streamed=await extractPage({client,identity:config,generatedAt:shared.generatedAt,signal:controller.signal,observe,view:'legacyDau',days:mode.days,workerFactory:dependencies.adminPageWorkerFactory});actionRows=streamed.actionRows;}
        if(!pageValue){await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;}
        if(!pageValue){await client.query("SET LOCAL statement_timeout = '5000ms'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");}
        const db={$queryRaw:(strings,...values)=>{
          const query=Prisma.sql(strings,...values);
          const result=sequence.then(async()=>{controller.signal.throwIfAborted();observe({event:'query',phase:'section'});const result=await client.query(query.text,query.values);return result.rows;});
          sequence=result.catch(()=>{});return result;
        }};
        const {buildGetAdminStats}=require('../getAdminStats');
        const value=pageValue||await buildGetAdminStats({prisma:db,appSettings:settings,now:shared?()=>new Date(shared.generatedAt):now,adminRelationalSummary:shared,adminActionRows:actionRows})(options);
        await sequence;controller.signal.throwIfAborted();if(transaction){await client.query('COMMIT');transaction=false;}
        if(shared&&value.metricsDashboard?.sources?.foregroundActivity?.asOf)value.metricsDashboard.sources.foregroundActivity.asOf=shared.generatedAt;
        // Re-read after the transaction; changed collection configuration makes
        // this result obsolete, even while this token still owns the lease.
        const current=await identity(client);if(current.key!==config.key)throw Error('Analytics configuration changed');
        controller.signal.throwIfAborted();
        const published=await lua("local t=redis.call('TIME'); if tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)>tonumber(ARGV[3]) or redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'PX',86400000); return 1",[LEASE_KEY,key],[token,JSON.stringify(value),started+45000],controller.signal);
        if(published!==1)throw Error('Analytics lease lost before publication');remember(key,value);localFailures.delete(key);observe({event:'build',durationMs:Date.now()-started});
      }catch(error){
        // Abort queued section queries before rollback/releasing this borrowed
        // connection. An already-running statement drains under its 5s limit.
        controller.abort(error);localFailures.set(key,Date.now()+60000);while(localFailures.size>64)localFailures.delete(localFailures.keys().next().value);
        if(String(error.code||'').startsWith('08')||['57P01','57P02','57P03','ECONNRESET','ECONNREFUSED'].includes(error.code))failureScope='shared';
        await sequence.catch(()=>{});
        if(transaction)await client?.query('ROLLBACK').catch(()=>{});
        observe({event:'failure',section:mode.mode==='view'?mode.view:mode.mode==='dashboard'?mode.section:[...mode.legacySections],windowDays:mode.days,scope:failureScope,reason:error.code||error.message,durationMs:Date.now()-started});
        await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[2],'1','PX',60000); return 1 end; return 0",[LEASE_KEY,failureScope==='shared'?backoff:sectionFailure],[token]).catch(()=>{});
      }finally{
        client?.release();clearTimeout(deadline);clearInterval(renewal);
        await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",[LEASE_KEY],[token]).catch(()=>{});running=null;
      }
    })();
  }
  return async function getSnapshot(options={}){
    const requestStarted=Date.now();const mode=classifyView(options)||classifyAdminStatsRequest(options);
    options=mode.mode==='view'?options:mode.mode==='dashboard'?{sections:mode.section,window:`${mode.days}d`}:{sections:mode.legacySections};
    let config;
    try{config=await identity();}catch(error){observe({event:"identityFailure",reason:error.message});throw unavailable();}
    if(mode.mode==='view'&&!config.enabled)return decorate(envelopePage({view:mode.view,days:mode.days,generatedAt:now().toISOString(),identity:config}),now().getTime());
    if(mode.mode==='dashboard'&&!config.enabled)return buildGetAdminMetricsDashboard({appSettings:settings,now})(mode);
    const date=buildWindow(30,now()).end;
    const normalized=mode.mode==='view'?`${mode.view}:${mode.days}`:mode.mode==='dashboard'?`${mode.section}:${mode.days}`:`legacy:${[...mode.legacySections].sort().join(',')}`;
    const base=(mode.mode==='view'?'admin:analytics:views:v1:':PREFIX)+config.key+':'+date;
    const key=base+':'+normalized,artifactKey=base+':relational';
    let value;
    try{value=await read(key,requestStarted+10000);}catch{const saved=local.get(key)?.value;if(usable(saved,now().getTime()))return decorate(saved,now().getTime());throw unavailable();}
    const at=now().getTime();
    if(usable(value,at)){
      remember(key,value);if(at-Date.parse(value.generatedAt)>=FRESH_MS)attempt(key,config,mode,options,artifactKey).catch(()=>{});
      return decorate(value,at);
    }
    if((localFailures.get(key)||0)>Date.now())throw unavailable();
    const waitUntil=requestStarted+10000;
    while(Date.now()<waitUntil){
      try{
        await attempt(key,config,mode,options,artifactKey,waitUntil);
        await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(0,waitUntil-Date.now()))));
        value=await read(key,waitUntil);if(usable(value,now().getTime())){remember(key,value);return decorate(value,now().getTime());}
        if((localFailures.get(key)||0)>Date.now())throw unavailable();
        const failed=await read(PREFIX+'failure:'+config.key,waitUntil)||await read(sectionBackoff(config,mode),waitUntil);if(failed)throw unavailable();
      }catch(error){if(Date.now()>=waitUntil)break;throw error;}
    }
    if(mode.mode==='view'){const error=Error('Admin analytics are being calculated');error.statusCode=503;error.code='ADMIN_ANALYTICS_PENDING';throw error;}
    throw unavailable();
  };
}
module.exports={buildAdminAnalyticsSnapshots,invalidateAdminAnalytics,PREFIX};
