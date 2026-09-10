// Rejected-option experiment only: no production cursor/schema is installed.
const {Client}=require('pg');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55439');assert.equal(url.pathname,'/cpu_remediation_notification_test');
const db=new Client({connectionString:url.toString()});const at=new Date('2098-09-10T12:00:00Z');
const baseline=Object.fromEntries(['materialization','snapshots'].map(k=>[k,fs.readFileSync(path.join(__dirname,k+'-baseline.sql'),'utf8')]));
const predicates={materialization:`schedule.type='GLOBAL_EVENT_STARTED' AND schedule.status='MATERIALIZED'`,snapshots:`outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED') AND (outbox.expires_at IS NULL OR outbox.expires_at>$1)`};
const materialization=`WITH page AS MATERIALIZED (
 SELECT schedule.id,schedule.recipient_user_id,schedule.delivery_key
 FROM notification_schedules schedule WHERE ${predicates.materialization} AND ($3::text IS NULL OR schedule.id>$3)
 ORDER BY schedule.id LIMIT $2
), candidates AS MATERIALIZED (
 SELECT schedule.id FROM page schedule WHERE NOT EXISTS (
 SELECT 1 FROM LATERAL(SELECT id FROM inbox_alerts alert WHERE alert.user_id=schedule.recipient_user_id AND alert.source_key=schedule.delivery_key OFFSET 0) alert
 CROSS JOIN LATERAL(SELECT 1 FROM inbox_delivery_outbox outbox WHERE outbox.alert_id=alert.id AND outbox.kind='PUSH' OFFSET 0) outbox
)
), updated AS (
 UPDATE notification_schedules schedule SET status=CASE WHEN schedule.admission_class IS NULL THEN 'PENDING' ELSE 'ADMISSION_PENDING' END,
 claimed_at=NULL,released_at=NULL,canceled_at=NULL,cancellation_reason=NULL,available_at=$1,updated_at=$1
 FROM candidates WHERE schedule.id=candidates.id RETURNING schedule.id
)
SELECT (SELECT max(id) FROM page) AS cursor,(SELECT count(*) FROM page)::int AS scanned,(SELECT array_agg(id ORDER BY id) FROM updated) AS ids`;
const snapshots=`WITH page AS MATERIALIZED (
 SELECT outbox.id,outbox.alert_id FROM inbox_delivery_outbox outbox WHERE ${predicates.snapshots} AND ($3::text IS NULL OR outbox.id>$3)
 ORDER BY outbox.id LIMIT $2
), candidates AS MATERIALIZED (
 SELECT outbox.id FROM page outbox
 CROSS JOIN LATERAL(SELECT user_id,source_key FROM inbox_alerts alert WHERE alert.id=outbox.alert_id OFFSET 0) alert
 CROSS JOIN LATERAL(SELECT 1 FROM notification_schedules schedule WHERE schedule.recipient_user_id=alert.user_id AND schedule.delivery_key=alert.source_key AND schedule.type='GLOBAL_EVENT_STARTED' OFFSET 0) schedule
 WHERE NOT EXISTS(SELECT 1 FROM inbox_delivery_device_attempts attempt WHERE attempt.outbox_id=outbox.id OFFSET 0)
),updated AS (
 UPDATE inbox_delivery_outbox outbox SET status='RETRY',available_at=$1,retry_at=$1,lease_until=NULL,lease_token=NULL,delivered_at=NULL,updated_at=$1,last_error_code='TARGET_SNAPSHOT_RECONCILED'
 FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.id
)
SELECT (SELECT max(id) FROM page) AS cursor,(SELECT count(*) FROM page)::int AS scanned,(SELECT array_agg(id ORDER BY id) FROM updated) AS ids`;
async function seed(size,gap){await db.query('TRUNCATE inbox_delivery_device_attempts,inbox_delivery_outbox,inbox_alerts,notification_schedules CASCADE');
 await db.query(`INSERT INTO users(id,apple_id) VALUES('cpu-notification-fixture','cpu-notification-fixture') ON CONFLICT DO NOTHING`);
 await db.query(`INSERT INTO notification_schedules(id,recipient_user_id,type,title,body,payload,delivery_key,available_at,status,updated_at) SELECT 'schedule-'||lpad(i::text,7,'0'),'cpu-notification-fixture',CASE WHEN i<=2000 THEN 'GLOBAL_EVENT_STARTED' ELSE 'OTHER' END,'Fixture','Fixture','{}','fixture-'||i,$1,'MATERIALIZED',$1 FROM generate_series(1,$2::int) i`,[at,size]);
 await db.query(`INSERT INTO inbox_alerts(id,user_id,type,destination,title,body,source_key,expires_at) SELECT 'alert-'||i,'cpu-notification-fixture','GLOBAL_EVENT_STARTED','{}','Fixture','Fixture','fixture-'||i,$1::timestamp+interval '1 day' FROM generate_series(1,$2::int) i WHERE NOT(i<=2000 AND i%$3::int=0)`,[at,size,gap||2147483647]);
 await db.query(`INSERT INTO inbox_delivery_outbox(id,alert_id,payload,status,updated_at) SELECT 'outbox-'||lpad(i::text,7,'0'),'alert-'||i,'{}','DELIVERED',$1 FROM generate_series(1,$2::int) i WHERE EXISTS(SELECT 1 FROM inbox_alerts WHERE id='alert-'||i)`,[at,size]);
 await db.query(`INSERT INTO inbox_delivery_device_attempts(id,outbox_id,token_hash,disposition,updated_at) SELECT 'attempt-'||i,'outbox-'||lpad(i::text,7,'0'),'token-'||i,'SENT',$1 FROM generate_series(1,$2::int) i WHERE EXISTS(SELECT 1 FROM inbox_delivery_outbox WHERE id='outbox-'||lpad(i::text,7,'0')) AND NOT(i<=2000 AND $3::int<=2000 AND i%$3::int=1)`,[at,size,gap||2147483647]);
 for(const table of ['notification_schedules','inbox_alerts','inbox_delivery_outbox','inbox_delivery_device_attempts'])await db.query(`VACUUM (ANALYZE) ${table}`);
}
async function measure(sql,args){const p=(await db.query('EXPLAIN(ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'][0];return{ms:p['Execution Time'],planMs:p['Planning Time'],hits:p.Plan['Shared Hit Blocks'],reads:p.Plan['Shared Read Blocks'],dirtied:p.Plan['Shared Dirtied Blocks'],wal:p.Plan['WAL Bytes']||0};}
async function cycle(sql){let cursor=null,totals={ms:0,planMs:0,hits:0,reads:0,dirtied:0,wal:0},pages=0,maxPageMs=0,found=[];
 for(;;){await db.query('BEGIN');try{const values=[at,500,cursor];const row=(await db.query(sql,values)).rows[0];await db.query('ROLLBACK');await db.query('BEGIN');const p=await measure(sql,values);for(const k in totals)totals[k]+=p[k];maxPageMs=Math.max(maxPageMs,p.ms);found.push(...row.ids||[]);pages++;cursor=row.cursor;if(row.scanned<500)break;}finally{await db.query('ROLLBACK');}}
 return {...totals,pages,maxPageMs,found};}
(async()=>{await db.connect();try{const results=[];for(const size of [4000,40000])for(const[distribution,gap]of[['healthy',0],['sparse',1000],['gaps',2]]){await seed(size,gap);for(const[kind,candidate]of Object.entries({materialization,snapshots})){
 // Compare full recovery of all gaps, not a bounded candidate page with an unbounded baseline.
 const baselineAll=baseline[kind].replace('LIMIT $2','LIMIT $2');
 const comparisons=[];for(let repeat=0;repeat<3;repeat++){await db.query('BEGIN');const before=await measure(baselineAll,[at,50000]);await db.query('ROLLBACK');const after=await cycle(candidate);comparisons.push({before,after});}
 const r={size,distribution,kind,comparisons};results.push(r);console.log(JSON.stringify({...r,comparisons:comparisons.map(({before,after})=>({before,after:{...after,found:after.found.length}}))}));
 const expected=distribution==='healthy'?0:(gap===1000?2:1000);assert.equal(comparisons[0].after.found.length,expected);
 }}fs.writeFileSync(path.resolve(__dirname,'../../../../docs/evidence/cpu-remediation-notification/cursor-experiment.json'),JSON.stringify({results},null,2));}finally{await db.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
