// An isolated ephemeral Redis per test file. No existing Redis is reused.
const { randomInt, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { before, after, beforeEach } = require('node:test');
const { once } = require('node:events');
const Redis = require('ioredis');
const port=22000+randomInt(18000);
process.env.REDIS_URL=`redis://127.0.0.1:${port}`;
process.env.CACHE_ENV_PREFIX=`test:admin:${randomUUID()}:`;
let processHandle,redis;
before(async()=>{
 processHandle=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Redis startup timeout')),5000);processHandle.once('error',reject);processHandle.stdout.on('data',data=>{if(String(data).includes('Ready to accept connections')){clearTimeout(timeout);resolve();}});});
 redis=new Redis(process.env.REDIS_URL);
});
beforeEach(async()=>{await redis.flushdb();await require('../../src/modules/admin/services/adminAnalyticsSnapshots').invalidateAdminAnalytics();});
after(async()=>{redis?.disconnect();if(processHandle?.exitCode===null){processHandle.kill('SIGTERM');await once(processHandle,'exit');}});
