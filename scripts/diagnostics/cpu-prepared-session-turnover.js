// Owned local transaction pool only: prove the same adapter/client can reuse
// the actual boundary statement after PgBouncer replaces its server backend.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {Client,Pool}=require('pg');const {installPreparedReadQueries}=require('../../src/shared/database/preparedReadQueries');
const target=new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&/^[a-zA-Z0-9_]+_test$/.test(target.pathname.slice(1)));
const source=JSON.parse(fs.readFileSync(process.argv[2])).find(row=>row.family==='display-boundary');
const query={text:'/* steps:prepared-read:v1 */'+source.query.replace(/^\/\* steps:prepared-read:v1 \*\//,''),values:source.values};
const pool=new Pool({connectionString:target.toString(),max:1,options:'-c timezone=UTC'});installPreparedReadQueries(pool);
const au=new URL(target);au.pathname='/pgbouncer';const admin=new Client({connectionString:au.toString()});
(async()=>{
 await admin.connect();const db=await pool.connect();
 try{
  const sample=async()=>{await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='5s'");
   const pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const rows=(await db.query(query)).rows;await db.query('COMMIT');return{pid,rows};};
  let original=await sample();for(let i=0;i<10;i++)assert.deepEqual((await sample()).rows,original.rows);
  await admin.query(`RECONNECT ${target.pathname.slice(1)}`);
  const recycled=await sample();assert.notEqual(recycled.pid,original.pid);assert.deepEqual(recycled.rows,original.rows);
  await db.query('BEGIN');await db.query('ANALYZE race_participants');assert.deepEqual((await db.query(query)).rows,original.rows);await db.query('COMMIT');
  await db.query('BEGIN');await assert.rejects(db.query('SELECT 1/0'),error=>error.code==='22012');await db.query('ROLLBACK');
  assert.deepEqual((await sample()).rows,original.rows);
  const result={sameClientAcrossReconnect:true,backendChanged:true,afterAnalyzePassed:true,afterTransactionErrorPassed:true,rowsPreserved:true};console.log(JSON.stringify(result));if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));
 }finally{await db.query('ROLLBACK');db.release();}
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await pool.end();await admin.end();});
