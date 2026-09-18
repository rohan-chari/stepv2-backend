require('./adminRedisFixture.cjs');
const assert=require('node:assert/strict');
const {it}=require('node:test');
const {cleanDatabase,createTestUser,startServer,request}=require('./setup');
const {pool}=require('../../src/db');
it('rolls back a transaction when cancellation occurs exactly after PostgreSQL accepts BEGIN',async()=>{
 await cleanDatabase();const admin=await createTestUser({email:'admin@test.com'}),controller=new AbortController();const statements=[];let owner=null,releases=0;
 const faultPool={connect:async()=>{const c=await pool.connect();return new Proxy(c,{get(t,k){if(k==='query')return async(sql,...args)=>{const result=await t.query(sql,...args);if(t===owner)statements.push(sql);if(sql==='BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'){owner=t;statements.push('BEGIN ACK');controller.abort(Error('Injected cancellation after BEGIN acknowledgement'));}return result;};if(k==='release')return()=>{if(t===owner){releases++;statements.push('RELEASE');}return t.release();};return typeof t[k]==='function'?t[k].bind(t):t[k];}});}};
 const server=await startServer({pool:faultPool,adminAnalyticsAbortControllerFactory:()=>controller});
 try{const r=await request(server.baseUrl,'GET','/admin/stats?view=overview&window=7d&sections=dashboard-summary',{token:admin.token});assert.equal(r.status,503);assert.ok(statements.indexOf('ROLLBACK')>statements.indexOf('BEGIN ACK'),JSON.stringify(statements));assert.ok(statements.indexOf('RELEASE')>statements.indexOf('ROLLBACK'));assert.equal(releases,1);const borrowed=await pool.connect();try{assert.equal((await borrowed.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');}finally{borrowed.release();}}
 finally{await server.close();if(owner)await owner.query('ROLLBACK').catch(()=>{});}
});
