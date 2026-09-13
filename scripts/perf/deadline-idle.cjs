// Synthetic local-only scheduler benchmark; never run against production.
const assert = require('node:assert/strict');
const { resolve, join } = require('node:path');
const { writeFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const target = new URL(process.env.DATABASE_URL);
assert.ok(['localhost','127.0.0.1'].includes(target.hostname));assert.match(target.pathname,/_test$/);
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.REDIS_URL,'');
process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const root=resolve(process.argv[2]||join(__dirname,'../..'));
const output=process.argv[3];assert.ok(output,'output file required');
const {prisma}=require(join(root,'src/db'));
const {cleanDatabase}=require(join(root,'test/integration/setup'));
const {buildRaceEffectDeadlineScheduler}=require(join(root,'src/modules/races'));
let count=0,enabled=false;prisma.$on('query',()=>{if(enabled)count++;});
(async()=>{
 await cleanDatabase();const scheduler=buildRaceEffectDeadlineScheduler();await scheduler.tick();
 const durations=[];enabled=true;
 for(let n=0;n<60;n++){const start=performance.now();await scheduler.tick();durations.push(performance.now()-start);}
 enabled=false;const sorted=[...durations].sort((a,b)=>a-b);
 writeFileSync(output,JSON.stringify({passes:60,queries:count,medianMs:sorted[30],p95Ms:sorted[56],totalMs:durations.reduce((a,b)=>a+b,0)},null,2)+'\n');
 await prisma.$disconnect();process.exit(0);
})().catch(async error=>{console.error(error);await prisma.$disconnect();process.exitCode=1;});
