// Disposable PostgreSQL experiment. No app module imports or production data.
const { Client } = require('pg');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');assert.equal(url.port,'55439');assert.equal(url.pathname,'/cpu_remediation_notification_test');
const db = new Client({connectionString:url.toString()});
const at=new Date('2098-09-10T12:00:00Z');
const files={};for(const kind of ['materialization','snapshots'])files[kind]=readFileSync(path.join(__dirname,`${kind}-baseline.sql`),'utf8');
const materialization = files.materialization.replace('WITH candidates AS (', 'WITH candidates AS MATERIALIZED (').replace(
`SELECT 1 FROM inbox_alerts alert\n                  JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH'\n                   WHERE alert.user_id=schedule.recipient_user_id\n                     AND alert.source_key=schedule.delivery_key`,
`SELECT 1 FROM LATERAL (
                   SELECT alert.id FROM inbox_alerts alert
                    WHERE alert.user_id=schedule.recipient_user_id
                      AND alert.source_key=schedule.delivery_key OFFSET 0
                 ) alert
                 CROSS JOIN LATERAL (
                   SELECT 1 FROM inbox_delivery_outbox outbox
                    WHERE outbox.alert_id=alert.id AND outbox.kind='PUSH' OFFSET 0
                 ) outbox`);
const snapshots = files.snapshots.replace('WITH candidates AS (',`WITH missing AS MATERIALIZED (
         SELECT outbox.id,outbox.alert_id,outbox.updated_at
           FROM inbox_delivery_outbox outbox
          WHERE outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED')
            AND (outbox.expires_at IS NULL OR outbox.expires_at > $1)
            AND NOT EXISTS (SELECT 1 FROM inbox_delivery_device_attempts attempt WHERE attempt.outbox_id=outbox.id)
       ), candidates AS MATERIALIZED (`).replace(`FROM inbox_delivery_outbox outbox
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id
            AND schedule.delivery_key=alert.source_key
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED')
            AND (outbox.expires_at IS NULL OR outbox.expires_at > $1)
            AND NOT EXISTS (
              SELECT 1 FROM inbox_delivery_device_attempts attempt
               WHERE attempt.outbox_id=outbox.id
            )`, `FROM missing outbox
           CROSS JOIN LATERAL (SELECT alert.user_id,alert.source_key FROM inbox_alerts alert WHERE alert.id=outbox.alert_id OFFSET 0) alert
           CROSS JOIN LATERAL (SELECT 1 FROM notification_schedules schedule
             WHERE schedule.recipient_user_id=alert.user_id AND schedule.delivery_key=alert.source_key
               AND schedule.type='GLOBAL_EVENT_STARTED' OFFSET 0) schedule`);
for(const [kind,sql] of Object.entries({materialization,snapshots}))writeFileSync(path.join(__dirname,`${kind}-candidate.sql`),sql);
function select(sql){const pos=sql.indexOf('\n         UPDATE')>=0?sql.indexOf('\n         UPDATE'):sql.indexOf('\n       UPDATE');return sql.slice(0,pos)+' SELECT * FROM candidates WHERE $1::timestamp IS NOT NULL';}
async function plan(sql,mutation){await db.query('BEGIN');try{const x=(await db.query('EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) '+sql,[at,500])).rows[0]['QUERY PLAN'][0];return {ms:x['Execution Time'],planMs:x['Planning Time'],hits:x.Plan['Shared Hit Blocks'],reads:x.Plan['Shared Read Blocks'],dirtied:x.Plan['Shared Dirtied Blocks'],wal:x.Plan['WAL Bytes']||0,rows:x.Plan['Actual Rows'],plan:x};}finally{await db.query('ROLLBACK');}}
async function seed(size,gapEvery){
 await db.query('TRUNCATE inbox_delivery_device_attempts,inbox_delivery_outbox,inbox_alerts,notification_schedules CASCADE');
 await db.query(`INSERT INTO users(id,apple_id) VALUES('cpu-notification-fixture','cpu-notification-fixture') ON CONFLICT DO NOTHING`);
 await db.query(`INSERT INTO notification_schedules(id,recipient_user_id,type,title,body,payload,delivery_key,available_at,status,updated_at) SELECT 'schedule-'||lpad(i::text,7,'0'),'cpu-notification-fixture',CASE WHEN i<=2000 THEN 'GLOBAL_EVENT_STARTED' ELSE 'OTHER' END,'Fixture','Fixture','{}','fixture-'||i,$1,'MATERIALIZED',$1 FROM generate_series(1,$2::int) i`,[at,size]);
 await db.query(`INSERT INTO inbox_alerts(id,user_id,type,destination,title,body,source_key,expires_at) SELECT 'alert-'||i,'cpu-notification-fixture','GLOBAL_EVENT_STARTED','{}','Fixture','Fixture','fixture-'||i,$1::timestamp+interval '1 day' FROM generate_series(1,$2::int) i WHERE NOT (i<=2000 AND $3::int>0 AND i%$3::int=0)`,[at,size,gapEvery||2147483647]);
 await db.query(`INSERT INTO inbox_delivery_outbox(id,alert_id,payload,status,updated_at) SELECT 'outbox-'||i,'alert-'||i,'{}','DELIVERED',$1 FROM generate_series(1,$2::int) i WHERE EXISTS(SELECT 1 FROM inbox_alerts WHERE id='alert-'||i)`,[at,size]);
 await db.query(`INSERT INTO inbox_delivery_device_attempts(id,outbox_id,token_hash,disposition,updated_at) SELECT 'attempt-'||i,'outbox-'||i,'token-'||i,'SENT',$1 FROM generate_series(1,$2::int) i WHERE EXISTS(SELECT 1 FROM inbox_delivery_outbox WHERE id='outbox-'||i) AND NOT(i<=2000 AND $3::int<=2000 AND i%$3::int=1)`,[at,size,gapEvery||2147483647]);
 for(const table of ['notification_schedules','inbox_alerts','inbox_delivery_outbox','inbox_delivery_device_attempts'])await db.query(`VACUUM (ANALYZE) ${table}`);
}
(async()=>{await db.connect();try{const results=[];for(const size of [4000,40000])for(const [distribution,gap] of [['healthy',0],['sparse',1000],['gaps',2]]){
 await seed(size,gap);for(const [kind,candidate] of Object.entries({materialization,snapshots})){
 const a=(await db.query(select(files[kind]),[at,500])).rows.map(r=>r.id).sort(),b=(await db.query(select(candidate),[at,500])).rows.map(r=>r.id).sort();assert.deepEqual(b,a);
 for(const sql of [files[kind],candidate]) { await db.query('BEGIN'); try { const target=kind==='materialization'?'schedule':'outbox'; const changed=(await db.query(sql+' RETURNING '+target+'.id',[at,500])).rows.map(r=>r.id).sort(); assert.deepEqual(changed,a,'complete UPDATE changes exactly the selected gap IDs'); } finally { await db.query('ROLLBACK'); } }
 for(const [phase,transform] of [['select',select],['update',x=>x]]){await plan(transform(files[kind]));await plan(transform(candidate));const comparisons=[];for(let repeat=0;repeat<3;repeat++){const before=await plan(transform(files[kind])),after=await plan(transform(candidate));comparisons.push({before,after});}
 results.push({size,distribution,kind,phase,expectedRows:a.length,comparisons});console.log(JSON.stringify({size,distribution,kind,phase,expectedRows:a.length,comparisons:comparisons.map(x=>({beforeMs:x.before.ms,afterMs:x.after.ms,beforeHits:x.before.hits,afterHits:x.after.hits}))}));
 }} }
 writeFileSync(path.resolve(__dirname,'../../../../docs/evidence/cpu-remediation-notification/experiment.json'),JSON.stringify({postgres:(await db.query('select version()')).rows[0],results},null,2));
}finally{await db.end();}})().catch(e=>{console.error(e);process.exitCode=1;});
