// Measures the materialization recovery transaction holding its real admission
// lane against a second connection. Uses only the owned synthetic test DB.
const {Client}=require('pg');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {setTimeout:delay}=require('node:timers/promises');
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55439');assert.equal(url.pathname,'/cpu_remediation_notification_test');
const clients=[0,1].map(i=>new Client({connectionString:url.toString(),application_name:'cpu_notification_contention_'+i}));
const at=new Date('2098-09-10T12:00:00Z'),lane='visible:GLOBAL_EVENT_STARTED';
(async()=>{await Promise.all(clients.map(c=>c.connect()));const[a,b]=clients;try{
 const waiterPid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 await a.query('INSERT INTO notification_release_lanes(admission_class,next_token_at,created_at,updated_at) VALUES($1,$2,$2,$2) ON CONFLICT DO NOTHING',[lane,at]);
 const results=[];
 for(let repeat=0;repeat<3;repeat++)for(const version of ['baseline','candidate']){
  const sql=fs.readFileSync(path.join(__dirname,`materialization-${version}.sql`),'utf8');
  await a.query('BEGIN');await b.query('BEGIN');
  try {
   await a.query('SELECT next_token_at FROM notification_release_lanes WHERE admission_class=$1 FOR UPDATE',[lane]);
   const waiting=b.query('SELECT next_token_at FROM notification_release_lanes WHERE admission_class=$1 FOR UPDATE',[lane]);
   let blocked=false;for(let i=0;i<100;i++){const row=(await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[waiterPid])).rows[0];if(row?.wait_event_type==='Lock'){blocked=true;break;}await delay(2);}
   assert.ok(blocked,'second connection actually waits on the admission lane');
   const start=performance.now();const changed=await a.query(sql,[at,500]);const updateMs=performance.now()-start;
   await a.query('ROLLBACK');await waiting;
   results.push({repeat,version,changed:changed.rowCount,updateMs,waiterReleasedAfterMs:performance.now()-start});
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');}
 }
 console.log(JSON.stringify(results));fs.writeFileSync(path.resolve(__dirname,'../../../../docs/evidence/cpu-remediation-notification/admission-contention.json'),JSON.stringify({fixture:'40k rows,2000 relevant schedules,alternating gaps,500 row update limit; all updates rolled back',results},null,2));
}finally{await Promise.all(clients.map(c=>c.end()));}})().catch(e=>{console.error(e);process.exitCode=1;});
