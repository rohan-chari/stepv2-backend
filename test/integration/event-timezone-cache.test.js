const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { before, after, it } = require('node:test');
// Dedicated ephemeral Redis, with its own namespace and no persistence. Never
// use a configured application Redis for a fault-injection test.
const port = 20000 + crypto.randomInt(20000);
process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
process.env.CACHE_ENV_PREFIX = `t:timezone-${crypto.randomUUID()}:`;
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const Redis = require('ioredis');
let processHandle, redis, server;
before(async()=>{
  processHandle=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('ephemeral Redis did not start')),5000);
    processHandle.once('exit',code=>{clearTimeout(timeout);reject(new Error(`ephemeral Redis exited ${code}`));});
    processHandle.stdout.on('data',chunk=>{if(String(chunk).includes('Ready to accept connections')){clearTimeout(timeout);resolve();}});
  });
  redis=new Redis(process.env.REDIS_URL);
  await cleanDatabase();
});
after(async()=>{
  await server?.close();
  redis?.disconnect();
  if(processHandle?.exitCode===null){processHandle.kill('SIGTERM');await once(processHandle,'exit');}
});
it('uses committed Redis state on a stale local-auth cache, invalidates on travel, and falls back during Redis outage',async()=>{
  const account=await createTestUser({timezone:'America/New_York',globalEventTimezone:'America/New_York'});
  // A sibling worker may still have a pre-invalidation authentication object.
  const staleUser=await prisma.user.findUniqueOrThrow({where:{id:account.user.id}});
  const statements=[];
  server=await startServer({authSessionUserCache:{read:async()=>({...staleUser})},timezoneStatementObserver:name=>statements.push(name)});
  const call=zone=>request(server.baseUrl,'GET','/auth/me',{token:account.token,headers:{'x-timezone':zone}});
  assert.equal((await call('America/Los_Angeles')).status,200);
  assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).globalEventTimezone,'America/Los_Angeles');
  const count=statements.length;
  assert.equal((await call('America/Los_Angeles')).status,200); // Redis miss fills committed state.
  const cachedKey=`${process.env.CACHE_ENV_PREFIX}v1:user:timezone:${account.user.id}`;
  const cached=JSON.parse(await redis.get(cachedKey));assert.equal(cached.timezone,'America/Los_Angeles');
  assert.ok(await redis.ttl(cachedKey)>0);assert.ok(await redis.ttl(cachedKey)<=60);
  assert.equal((await call('America/Los_Angeles')).status,200); // Redis hit, no transaction.
  assert.equal(statements.length,count);
  assert.equal((await call('Europe/London')).status,200);
  assert.equal(await redis.get(cachedKey),null,'commit invalidates Redis rather than stale post-commit filling');
  const exited=once(processHandle,'exit');processHandle.kill('SIGTERM');await exited;
  assert.equal((await call('America/Los_Angeles')).status,200);
  assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.user.id}})).timezone,'America/Los_Angeles');
});
