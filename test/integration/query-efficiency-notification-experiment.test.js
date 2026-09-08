process.env.PRISMA_QUERY_EVENTS_ENABLED='true';
const assert=require('node:assert/strict');
const {test,after}=require('node:test');
const {Client}=require('pg');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const target=new URL(process.env.DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.match(target.pathname,/_test$/);
const {prisma,cleanDatabase,createTestUser}=require('./setup');after(()=>prisma.$disconnect());
test('notification reconciliation removes redundant missing-alert probe',{timeout:90000},async()=>{
 await cleanDatabase();const viewer=await createTestUser();const now=new Date();
 const schedules=Array.from({length:2001},(_,i)=>({id:`notification-eff-${String(i).padStart(5,'0')}`,recipientUserId:viewer.user.id,type:'GLOBAL_EVENT_STARTED',title:'Event',body:'Fixture',payload:{},deliveryKey:`eff-${i}`,availableAt:now,updatedAt:now,status:'MATERIALIZED'}));
 await prisma.notificationSchedule.createMany({data:schedules});
 const alerts=schedules.slice(0,-1).map(s=>({id:randomUUID(),userId:viewer.user.id,type:s.type,title:s.title,body:s.body,destination:{},sourceKey:s.deliveryKey,expiresAt:new Date(+now+86400000)}));
 await prisma.inboxAlert.createMany({data:alerts});await prisma.inboxDeliveryOutbox.createMany({data:alerts.slice(0,-1).map(a=>({alertId:a.id,payload:{},status:'DELIVERED'}))});
 for(const table of ['notification_schedules','inbox_alerts','inbox_delivery_outbox'])await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) ${table}`);
 const gap=`NOT EXISTS (SELECT 1 FROM inbox_alerts alert WHERE alert.user_id=schedule.recipient_user_id AND alert.source_key=schedule.delivery_key) OR NOT EXISTS(SELECT 1 FROM inbox_alerts alert JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH' WHERE alert.user_id=schedule.recipient_user_id AND alert.source_key=schedule.delivery_key)`;
 const old=`SELECT schedule.id FROM notification_schedules schedule WHERE schedule.type='GLOBAL_EVENT_STARTED' AND schedule.status='MATERIALIZED' AND (${gap}) ORDER BY schedule.updated_at,schedule.id LIMIT 500`;
 const candidate=`WITH page AS MATERIALIZED (SELECT * FROM notification_schedules WHERE type='GLOBAL_EVENT_STARTED' AND status='MATERIALIZED' AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 500) SELECT schedule.id,(${gap}) AS gap FROM page schedule ORDER BY schedule.id`;
 const db=new Client({connectionString:target.toString(),options:'-c timezone=UTC'});await db.connect();
 try{
  const expected=(await db.query(old)).rows.map(r=>r.id);assert.deepEqual(expected,[schedules.at(-2).id,schedules.at(-1).id]);
  const found=[];let cursor=null,pages=0;
  for(;;){const rows=(await db.query(candidate,[cursor])).rows;if(!rows.length)break;assert.ok(rows.length<=500);found.push(...rows.filter(r=>r.gap).map(r=>r.id));cursor=rows.at(-1).id;pages++;}
  assert.equal(pages,5);assert.deepEqual(found,expected,'gap beyond four healthy pages must be discovered');
  const plan=async(sql,params=[])=>(await db.query('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
  const comparisons=[];for(let i=0;i<3;i++){const a=await plan(old),b=await plan(candidate,[null]);comparisons.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
  console.log(JSON.stringify({experiment:'notification bounded cycle',comparisons,pages}));
  const redundantCheckRemoved=old.replace('NOT EXISTS (SELECT 1 FROM inbox_alerts alert WHERE alert.user_id=schedule.recipient_user_id AND alert.source_key=schedule.delivery_key) OR ','');
  assert.deepEqual((await db.query(redundantCheckRemoved)).rows.map(r=>r.id),expected);
  const simplified=[];for(let i=0;i<3;i++){const a=await plan(old),b=await plan(redundantCheckRemoved);simplified.push({beforeMs:a['Execution Time'],afterMs:b['Execution Time'],beforeHits:a.Plan['Shared Hit Blocks'],afterHits:b.Plan['Shared Hit Blocks']});}
  console.log(JSON.stringify({experiment:'notification redundant existence check',comparisons:simplified}));
  for(const comparison of simplified)assert.ok(comparison.afterHits<comparison.beforeHits*.9,'removing redundant existence check reduces buffer work');
  if(process.env.QUERY_EFFICIENCY_EXPERIMENT_ONLY!=='1') {
   const messages=[];let logs='';
   const child=spawn(process.execPath,['--require','./test/integration/fixtures/query-efficiency/observe-resolution.cjs','src/index.js'],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'test',STEPS_PROCESS_ROLE:'cron',NODE_APP_INSTANCE:'0',PORT:'0',CRON_START_DELAY_MS:'0'},stdio:['ignore','pipe','pipe','ipc']});
   child.on('message',m=>messages.push(m));child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
   try {
    let emitted;const until=Date.now()+60000;
    while(Date.now()<until){
     emitted=messages.find(m=>m.query.includes("schedule.status='MATERIALIZED'")&&m.query.includes("SET status=CASE"));
     if(emitted)break;
     if(child.exitCode!==null)throw Error(`cron exited: ${logs.slice(-3000)}`);
     await delay(100);
    }
    assert.ok(emitted,`actual cron reconciliation observed: ${logs.slice(-3000)}`);
    assert.equal((emitted.query.match(/NOT EXISTS/g)||[]).length,1,'real cron must eliminate redundant alert-only probe');
    const repaired=await prisma.notificationSchedule.findMany({where:{id:{in:expected}}});
    assert.ok(repaired.every(row=>row.status!=='MATERIALIZED'),'both missing-alert and missing-push schedules rearmed');
    const healthy=await prisma.notificationSchedule.findUnique({where:{id:schedules[0].id}});assert.equal(healthy.status,'MATERIALIZED');
   } finally {if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
  }
 }finally{await db.end();}
});
