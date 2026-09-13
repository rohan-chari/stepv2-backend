const { randomUUID, createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { pool: defaultPool } = require('../../../db');
const redisDefault = require('../../../shared/cache/redisCache');
const { classifyAdminStatsRequest, buildWindow, buildGetAdminMetricsDashboard } = require('../adminMetricsDashboard');
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
  const observe=dependencies.adminAnalyticsObserver||(event=>{if(event.event!=='query')console.info('[adminAnalytics]',JSON.stringify(event));});
  const settings=dependencies.appSettings||require('../../../shared/config/appSettings').appSettings;
  const local=new Map();localCaches.add(local);ensureInvalidation();let running=null;
  function remember(key,value){const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>16*1024*1024)return;local.delete(key);local.set(key,{value,bytes});let localBytes=[...local.values()].reduce((n,v)=>n+v.bytes,0);while(local.size>64||localBytes>16*1024*1024){const first=local.keys().next().value;localBytes-=local.get(first).bytes;local.delete(first);}}
  async function lua(script,keys,args=[]){const result=await redis.evalLua(script,keys,args);if(!result.ok)throw unavailable();return result.result;}
  async function identity(existingClient){
    const client=existingClient||await pool.connect();
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
    const value={...result.rows[0],enabled,telemetry};await client.query("COMMIT");return {...value,key:hash(value)};
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{if(!existingClient)client.release();}
  }
  function usable(value,at){return value&&Number.isFinite(Date.parse(value.generatedAt))&&at-Date.parse(value.generatedAt)>=0&&at-Date.parse(value.generatedAt)<STALE_MS;}
  function decorate(value,at){const fresh=at-Date.parse(value.generatedAt)<FRESH_MS;observe({event:fresh?'hit':'stale'});return {...value,snapshot:{generatedAt:value.generatedAt,freshUntil:new Date(Date.parse(value.generatedAt)+FRESH_MS).toISOString(),status:fresh?'fresh':'stale',refreshIntervalSeconds:900}};}
  async function read(key){const raw=await lua("return redis.call('GET',KEYS[1])",[key]);return raw?JSON.parse(raw):null;}
  async function attempt(key,config,mode,options,artifactKey){
    if(running)return;
    const token=randomUUID(),backoff=PREFIX+'failure:'+config.key;
    const acquired=await lua("if redis.call('EXISTS',KEYS[2]) == 1 then return 0 end; if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',60000) then return 1 end; return 0",[LEASE_KEY,backoff],[token]);
    if(acquired!==1)return;
    const controller=new AbortController();const started=Date.now();
    const deadline=setTimeout(()=>controller.abort(Error('Analytics build deadline exceeded')),45000);
    const renewal=setInterval(async()=>{try{const renewed=await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],60000) end; return 0",[LEASE_KEY],[token]);if(renewed!==1)controller.abort(Error('Analytics lease lost'));}catch(error){controller.abort(error);}},15000);
    running=(async()=>{
      let client;let transaction=false;let sequence=Promise.resolve();
      try{
        client=await pool.connect();controller.signal.throwIfAborted();
        let shared=null;
        if(mode.mode==='dashboard'){
          shared=await read(artifactKey);
          if(!shared||now().getTime()-Date.parse(shared.generatedAt)>=FRESH_MS){
            shared=await extractRelationalSummary({client,identity:config,generatedAt:now().toISOString(),signal:controller.signal,observe});
            controller.signal.throwIfAborted();
            const published=await lua("if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'PX',86400000); return 1",[LEASE_KEY,artifactKey],[token,JSON.stringify(shared)]);
            if(published!==1)throw Error('Analytics lease lost before artifact publication');
          }
        }
        controller.signal.throwIfAborted();
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '15000ms'");
        const db={$queryRaw:(strings,...values)=>{
          const query=Prisma.sql(strings,...values);
          const result=sequence.then(async()=>{controller.signal.throwIfAborted();observe({event:'query',phase:'section'});const result=await client.query(query.text,query.values);return result.rows;});
          sequence=result.catch(()=>{});return result;
        }};
        const {buildGetAdminStats}=require('../getAdminStats');
        const value=await buildGetAdminStats({prisma:db,appSettings:settings,now:shared?()=>new Date(shared.generatedAt):now,adminRelationalSummary:shared})(options);
        await sequence;controller.signal.throwIfAborted();await client.query('COMMIT');transaction=false;
        if(shared&&value.metricsDashboard?.sources?.foregroundActivity?.asOf)value.metricsDashboard.sources.foregroundActivity.asOf=shared.generatedAt;
        // Re-read after the transaction; changed collection configuration makes
        // this result obsolete, even while this token still owns the lease.
        const current=await identity(client);if(current.key!==config.key)throw Error('Analytics configuration changed');
        controller.signal.throwIfAborted();
        const published=await lua("if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'PX',86400000); return 1",[LEASE_KEY,key],[token,JSON.stringify(value)]);
        if(published!==1)throw Error('Analytics lease lost before publication');remember(key,value);observe({event:'build',durationMs:Date.now()-started});
      }catch(error){
        // Abort queued section queries before rollback/releasing this borrowed
        // connection. An already-running statement drains under its 5s limit.
        controller.abort(error);
        await sequence.catch(()=>{});
        if(transaction)await client?.query('ROLLBACK').catch(()=>{});
        observe({event:'failure',reason:error.code||error.message,durationMs:Date.now()-started});
        await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then redis.call('SET',KEYS[2],'1','PX',60000); return 1 end; return 0",[LEASE_KEY,backoff],[token]).catch(()=>{});
      }finally{
        client?.release();clearTimeout(deadline);clearInterval(renewal);
        await lua("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",[LEASE_KEY],[token]).catch(()=>{});running=null;
      }
    })();
  }
  return async function getSnapshot(options={}){
    const mode=classifyAdminStatsRequest(options);
    options=mode.mode==='dashboard'?{sections:mode.section,window:`${mode.days}d`}:{sections:mode.legacySections};
    let config;
    try{config=await identity();}catch(error){observe({event:"identityFailure",reason:error.message});throw unavailable();}
    if(mode.mode==='dashboard'&&!config.enabled)return buildGetAdminMetricsDashboard({appSettings:settings,now})(mode);
    const date=buildWindow(30,now()).end;
    const normalized=mode.mode==='dashboard'?`${mode.section}:${mode.days}`:`legacy:${[...mode.legacySections].sort().join(',')}`;
    const base=PREFIX+config.key+':'+date;
    const key=base+':'+normalized,artifactKey=base+':relational';
    let value;
    try{value=await read(key);}catch{const saved=local.get(key)?.value;if(usable(saved,now().getTime()))return decorate(saved,now().getTime());throw unavailable();}
    const at=now().getTime();
    if(usable(value,at)){
      remember(key,value);if(at-Date.parse(value.generatedAt)>=FRESH_MS)attempt(key,config,mode,options,artifactKey).catch(()=>{});
      return decorate(value,at);
    }
    const waitUntil=Date.now()+20000;
    while(Date.now()<waitUntil){
      await attempt(key,config,mode,options,artifactKey);
      await new Promise(resolve=>setTimeout(resolve,100));
      value=await read(key);if(usable(value,now().getTime())){remember(key,value);return decorate(value,now().getTime());}
      const failed=await read(PREFIX+'failure:'+config.key);if(failed)throw unavailable();
    }
    throw unavailable();
  };
}
module.exports={buildAdminAnalyticsSnapshots,invalidateAdminAnalytics,PREFIX};
