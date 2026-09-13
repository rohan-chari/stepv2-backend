const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const h = require('../../test/integration/fixtures/enrollment-query/harness.cjs');
const { buildLocalGlobalStepEventTick } = require('../../src/modules/steps');
const INDEX = 'global_step_event_entitlements_pending_parent_idx';
let observed = null;
h.prisma.$on('query', event => { if(observed) observed.push(event); });
(async () => {
  const results = [];
  for (const historyUsers of [1000,10000]) for (const pendingHeavy of [false,true]) {
    await h.resetPerformance(); const future = await h.parents();
    await h.prisma.$executeRawUnsafe(`INSERT INTO users(id) SELECT 'parent-plan-user-'||n FROM generate_series(0,$1::int-1)n`,historyUsers);
    const ended = new Date(+h.NOW-3600000);
    await h.prisma.globalStepEvent.createMany({data:Array.from({length:25},(_,i)=>({id:`parent-plan-${i}`,scheduleMode:'LOCAL_ENTITLEMENTS',
      startsAt:new Date(+ended-3600000-i*60000),endsAt:ended}))});
    for(let parent=0;parent<25;parent++) for(let first=0;first<historyUsers;first+=1000) {
      await h.prisma.$executeRawUnsafe(`INSERT INTO global_step_event_entitlements(id,event_id,user_id,timezone,local_date,starts_at,ends_at,start_processed_at,end_processed_at)
        SELECT md5($1||':'||n)::uuid::text,$1,'parent-plan-user-'||n,'UTC','2097-12-31',$4::timestamp-interval '30 minutes',$4::timestamp,
          CASE WHEN $5::boolean OR (n=0 AND $6::int<2) THEN NULL ELSE $4::timestamp END,
          CASE WHEN $5::boolean OR (n=0 AND ($6::int=0 OR $6::int=2)) THEN NULL ELSE $4::timestamp END
        FROM generate_series($2::int,$3::int)n`,`parent-plan-${parent}`,first,first+999,ended,pendingHeavy,parent);
    }
    for(const event of future) await h.prisma.globalStepEventEntitlement.createMany({data:Array.from({length:1000},(_,i)=>h.entitlement(event,`parent-plan-user-${i}`))});
    await h.analyze(); observed=[];
    await buildLocalGlobalStepEventTick({now:()=>h.NOW,skipEndBoundaries:true,cleanupExpiredEntitlements:async()=>0,logger:{log(){},error(){}}})();
    const event=observed.find(row=>row.query.startsWith('SELECT')&&row.query.includes('"global_step_events"')&&row.query.includes('start_processed_at')); observed=null;
    assert.ok(event); const parameters=JSON.parse(event.params).map(value=>typeof value==='string'&&/^2098-/.test(value)?new Date(value):value);
    async function plan(){ const explain=(await h.prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${event.query}`,...parameters))[0]['QUERY PLAN'][0];
      return {buffers:(explain.Plan['Shared Hit Blocks']||0)+(explain.Plan['Shared Read Blocks']||0),executionMs:explain['Execution Time'],planningMs:explain['Planning Time'],rows:explain.Plan['Actual Rows']};}
    const pairs=[];
    for(let i=0;i<10;i++){
      await h.prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS ${INDEX}`);
      const withoutIndex=await plan(); const ids=(await h.prisma.$queryRawUnsafe(event.query,...parameters)).map(row=>row.id);
      await h.prisma.$executeRawUnsafe(`CREATE INDEX ${INDEX} ON global_step_event_entitlements(event_id) WHERE start_processed_at IS NULL OR end_processed_at IS NULL`);
      const withIndex=await plan(); assert.deepEqual((await h.prisma.$queryRawUnsafe(event.query,...parameters)).map(row=>row.id),ids);
      pairs.push({withoutIndex,withIndex});
    }
    results.push({historyUsers,pendingHeavy,entitlements:25*historyUsers+2000,pairs});
  }
  writeFileSync('docs/evidence/db-work-reduction/parent-paginated-index.json',JSON.stringify({results,note:'Captured final bounded Prisma scheduler SQL; ten warm pairs per fixture, candidate pages warmed by construction; no OS cache flush.'},null,2));
  console.log(JSON.stringify(results.map(row=>({historyUsers:row.historyUsers,pendingHeavy:row.pendingHeavy,pair:row.pairs[1]}))));
  await h.resetPerformance();await h.prisma.$disconnect();
})().catch(async error=>{console.error(error);await h.prisma.$disconnect();process.exitCode=1;});
