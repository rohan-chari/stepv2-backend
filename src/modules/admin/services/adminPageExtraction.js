const {Worker}=require('node:worker_threads');
const path=require('node:path');
const {planPage,VIEWS}=require('./adminPagePlan');
const {buildWindow}=require('../adminMetricsDashboard');
const {AD_COIN_REWARD_DAILY_CAP}=require('../../economy/adRewards');
const LIMITS=Object.freeze({batch:2000,rows:2000000,bytes:256*1024*1024,output:16*1024*1024});
function configuredReferralVersion(){const v=Number(process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION),secret=process.env['REFERRAL_IP_HMAC_SECRET_V'+v];return Number.isInteger(v)&&v>=1&&typeof secret==='string'&&secret.length>=32?v:-1;}
function envelopePage({view,days,generatedAt,identity,blocks={}}){const sections={};for(const key of VIEWS[view]){const base={generatedAt};if(['ads','economy'].includes(key)){if(identity.enabled)Object.assign(base,blocks[key]);else base.metricsDashboard={schemaVersion:2,status:'disabled',window:buildWindow(days,new Date(generatedAt)),sources:{productDb:{status:'available',asOf:generatedAt}}};}else{const foreground=['dashboard-growth','dashboard-dau-engagement','dashboard-retention'].includes(key);base.metricsDashboard={schemaVersion:2,status:identity.enabled?'available':'disabled',window:buildWindow(key==='dashboard-retention-mature'?90:days,new Date(generatedAt)),sources:{productDb:{status:'available',asOf:generatedAt},...(foreground?{foregroundActivity:{status:identity.telemetry?'collecting':'disabled',asOf:identity.telemetry?generatedAt:null}}:{})},...(identity.enabled?blocks[key]:{})};}sections[key]=base;}return {view,generatedAt,sections};}
async function extractPage({client,identity,generatedAt,view,days,signal,observe=()=>{},workerFactory}){
 const plan=planPage({view,days,generatedAt,identity});const data={...plan,sources:undefined,identity,adCap:AD_COIN_REWARD_DAILY_CAP};
 const worker=workerFactory?workerFactory(data):new Worker(path.join(__dirname,'adminPageWorker.js'),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:256}});
 let pending=null,sequence=0,workerError=null,transaction=false,streamedRows=0,streamedBytes=0,batches=0,dbMs=0,queryCount=0;const started=Date.now();
 const onMessage=message=>{if(!pending||pending.id!==message.id)return;const p=pending;pending=null;message.error?p.reject(Error(message.error)):p.resolve(message);};
 const fail=error=>{workerError=error;if(pending){pending.reject(error);pending=null;}};
 worker.on('message',onMessage);worker.on('error',fail);worker.on('exit',()=>fail(Error('Analytics worker exited before completion')));
 const abort=()=>fail(signal.reason||Error('Analytics build cancelled'));signal.addEventListener('abort',abort,{once:true});
 const wait=(id,message)=>{signal.throwIfAborted();if(workerError)throw workerError;return new Promise((resolve,reject)=>{pending={id,resolve,reject};if(message)worker.postMessage({...message,id});});};
 async function query(text,values){signal.throwIfAborted();const at=Date.now();queryCount++;const result=await client.query(text,values);dbMs+=Date.now()-at;signal.throwIfAborted();return result;}
 try{
  await wait(0);transaction=true;await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await query("SET LOCAL statement_timeout = '5000ms'");await query("SET LOCAL idle_in_transaction_session_timeout = '45000ms'");
  for(let i=0;i<plan.sources.length;i++){
   const source=plan.sources[i],cursor='admin_page_'+i;observe({event:'pageSource',view,source:source.name});observe({event:'query',phase:'page',source:source.name});
   await query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${source.text}`,source.values);
   let first=true;while(true){const at=Date.now();const result=await query(`FETCH FORWARD ${LIMITS.batch} FROM ${cursor}`);const fetchMs=Date.now()-at;observe({event:"pageFetch",view,source:source.name,rows:result.rows.length,fetchMs,firstFetch:first});
    streamedRows+=result.rows.length;streamedBytes+=Buffer.byteLength(JSON.stringify(result.rows));if(streamedRows>LIMITS.rows||streamedBytes>LIMITS.bytes)throw Error('Analytics page streaming budget exceeded');
    if(result.rows.length){batches++;await wait(++sequence,{type:'batch',source:source.name,rows:result.rows});observe({event:'pageBatch',view,source:source.name,rows:result.rows.length,outstanding:1,fetchMs,firstFetch:first});}first=false;if(result.rows.length<LIMITS.batch)break;
   }
   await query(`CLOSE ${cursor}`);
  }
  await query('COMMIT');transaction=false;const {value}=await wait(++sequence,{type:'finish'});signal.throwIfAborted();const result=view==='legacyDau'?value:envelopePage({view,days,generatedAt,identity,blocks:value.blocks});if(Buffer.byteLength(JSON.stringify(result))>LIMITS.output)throw Error('Analytics page output budget exceeded');
  observe({event:'pageComplete',view,streamedRows,streamedBytes,batches,sourceQueries:plan.sources.length,queryCount,dbMs,durationMs:Date.now()-started,...value.diagnostics});return result;
 }finally{
  // Each query is awaited before unwinding. ROLLBACK closes all transaction
  // cursors; the caller releases its single borrowed connection exactly once.
  if(transaction)await client.query('ROLLBACK').catch(()=>{});signal.removeEventListener('abort',abort);await worker.terminate();
 }
}
module.exports={extractPage,envelopePage,LIMITS,configuredReferralVersion};
