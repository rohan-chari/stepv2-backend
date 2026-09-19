const { Worker } = require('node:worker_threads');
const path = require('node:path');
const LIMITS = Object.freeze({page:2000,rows:200000,bytes:32*1024*1024,statementMs:5000,transactionMs:15000});
async function extractRelationalSummary({client,identity,generatedAt,signal,observe=()=>{}}) {
  const input={identity,generatedAt}; let rows=0,bytes=0;const started=Date.now();
  const check=()=>{signal.throwIfAborted();if(Date.now()-started>LIMITS.transactionMs)throw Error('Analytics extraction deadline exceeded');};
  async function pages(name,columns,table,where='TRUE',key='id'){
    input[name]=[];let last=null;
    while(true){check();const result=await client.query(`SELECT ${columns} FROM ${table} WHERE (${where}) AND ($1::text IS NULL OR ${key}>$1) ORDER BY ${key} LIMIT $2`,[last,LIMITS.page]);observe({event:'query',phase:'extraction',source:name,rows:result.rows.length});
      rows+=result.rows.length;bytes+=Buffer.byteLength(JSON.stringify(result.rows));if(rows>LIMITS.rows||bytes>LIMITS.bytes)throw Error('Analytics extraction size budget exceeded');
      input[name].push(...result.rows);if(result.rows.length<LIMITS.page)break;last=result.rows.at(-1)[key];
    }
  }
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query(`SET LOCAL statement_timeout = '${LIMITS.statementMs}ms'`);
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${LIMITS.transactionMs}ms'`);
    await pages('users','id,is_review_account,created_at,metrics_v2_signup_eligible,metrics_v2_signup_epoch_id,metrics_v2_eligible_epoch_id,metrics_v2_eligible_at','users');
    await pages('races','id,creator_id,seed_id,tournament_id,status,powerups_enabled,started_at,created_at,completed_at','races');
    await pages('participants','id,user_id,race_id,joined_at,finished_at,forfeited_at','race_participants',"status='accepted'");
    // All retained user/day history is needed for the historical signup cohorts.
    // Probe the remaining row budget before materializing this potentially huge
    // source. Without this, an over-budget dataset can spend long enough paging
    // that the outer HTTP/build deadline wins first, hiding the real size-budget
    // failure and doing unnecessary database work.
    const remainingRows=Math.max(0,LIMITS.rows-rows);
    check();
    const activityBudgetProbe=await client.query(
      'SELECT count(*)::int AS count FROM (SELECT 1 FROM user_activity_days LIMIT $1) budget_probe',
      [remainingRows+1],
    );
    if(Number(activityBudgetProbe.rows[0]?.count||0)>remainingRows){
      throw Error('Analytics extraction size budget exceeded');
    }
    input.activity=[];let afterUser=null,afterDate=null;
    while(true){check();const result=await client.query("SELECT user_id,to_char(activity_date,'YYYY-MM-DD') activity_date FROM user_activity_days WHERE ($1::text IS NULL OR (user_id,activity_date)>($1::text,$2::date)) ORDER BY user_id,activity_date LIMIT $3",[afterUser,afterDate,LIMITS.page]);observe({event:'query',phase:'extraction',source:'activity',rows:result.rows.length});rows+=result.rows.length;bytes+=Buffer.byteLength(JSON.stringify(result.rows));if(rows>LIMITS.rows||bytes>LIMITS.bytes)throw Error('Analytics extraction size budget exceeded');input.activity.push(...result.rows);if(result.rows.length<LIMITS.page)break;afterUser=result.rows.at(-1).user_id;afterDate=result.rows.at(-1).activity_date;}

    await pages('tokens','id,user_id,admin_metrics_open_epoch_id','device_tokens',"platform='ios' AND admin_metrics_open_capable=true");
    check();await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  observe({event:'extraction',rows,bytes,durationMs:Date.now()-started});
  signal.throwIfAborted();
  const worker=new Worker(path.join(__dirname,'adminRelationalSummaryWorker.js'),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:256}});
  return new Promise((resolve,reject)=>{
    const abort=()=>{worker.terminate();reject(signal.reason||Error('Analytics worker cancelled'));};
    signal.addEventListener('abort',abort,{once:true});
    worker.once('message',message=>{signal.removeEventListener('abort',abort);if(message.error)reject(Error(message.error));else{observe({event:'worker',...message.value.diagnostics});resolve(message.value);}});
    worker.once('error',error=>{signal.removeEventListener('abort',abort);reject(error);});
    worker.once('exit',code=>{signal.removeEventListener('abort',abort);if(code!==0)reject(Error(`Analytics worker exited ${code}`));});
  });
}
module.exports={extractRelationalSummary,LIMITS};
