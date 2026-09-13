const assert = require('node:assert/strict');
const db = new URL(process.env.DATABASE_URL);
assert.ok(['127.0.0.1','localhost'].includes(db.hostname));assert.match(db.pathname,/_test$/);
assert.equal(process.env.NODE_ENV,'test');
process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const { prisma } = require('../../../src/db');
const { scheduleRaceEffectDeadlineScheduler, scheduleRaceResolutionWorkerV2, scheduleRaceResolutionPostTaskRunner } = require('../../../src/modules/races');
const { coordinatedOptimizationMetrics: metrics } = require('../../../src/shared/observability/coordinatedOptimizationMetrics');
const queries=[];prisma.$on('query',e=>queries.push({sql:e.query,ms:e.duration}));
const job=scheduleRaceEffectDeadlineScheduler();
let stopped=false;let resolution=null;let publication=null;
process.on('message',async message=>{
 try {
  if(message.kind==='startWorkers'){resolution ||= scheduleRaceResolutionWorkerV2({bootAt:0});publication ||= scheduleRaceResolutionPostTaskRunner();process.send({id:message.id,started:true});}
  if(message.kind==='snapshot')process.send({id:message.id,queries,metrics:metrics.snapshot()});
  if(message.kind==='stop'&&!stopped){stopped=true;await job.stop();await resolution?.stop();await publication?.stop();const count=queries.length;
   await new Promise(r=>setTimeout(r,100));process.send({id:message.id,count,after:queries.length});
   await prisma.$disconnect();process.exit(0);}
 }catch(e){process.send({id:message.id,error:e.message});}
});
process.send({ready:true});
