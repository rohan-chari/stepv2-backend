const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { before, after, beforeEach, it } = require('node:test');
const port = 22000 + randomInt(18000);
process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
process.env.CACHE_ENV_PREFIX = `test:admin-snapshots:${randomUUID()}:`;
const Redis = require('ioredis');
const { cleanDatabase, createTestUser, startServer, prisma, request } = require('./setup');
const { appSettings } = require('../../src/shared/config/appSettings');
let redisProcess, redis, server, peer, admin;
let clock = new Date();
const events = [];
before(async () => {
  redisProcess = spawn('redis-server', ['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no'], {stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject) => { const timeout=setTimeout(()=>reject(Error('Redis startup timeout')),5000); redisProcess.once('error',reject); redisProcess.stdout.on('data',data=>{if(String(data).includes('Ready to accept connections')){clearTimeout(timeout);resolve();}}); });
  redis = new Redis(process.env.REDIS_URL);
  const dependencies = { adminAnalyticsNow: () => clock, adminAnalyticsObserver: event => events.push(event) };
  server = await startServer(dependencies); peer = await startServer(dependencies);
});
after(async () => { await server?.close(); await peer?.close(); redis?.disconnect(); if(redisProcess?.exitCode===null){redisProcess.kill('SIGTERM');await once(redisProcess,'exit');} });
beforeEach(async () => {
  await cleanDatabase(); await redis.flushdb(); clock=new Date(); events.length=0;
  await appSettings.setFlag('adminMetricsV2DashboardEnabled',true);
  await appSettings.setFlag('adminMetricsV2TelemetryEnabled',false);
  admin=await createTestUser({email:'admin@test.com',displayName:'Admin'});
});
const stats = (s=server,section='dashboard-summary') => request(s.baseUrl,'GET',`/admin/stats?sections=${section}`,{token:admin.token});
const purchases = (query='',token=admin.token) => request(server.baseUrl,'GET',`/admin/purchases${query}`,{token});
async function receipt(user, data={}) {
  let identity=await prisma.billingIdentity.findUnique({where:{userId:user.user.id}});
  if(!identity) identity=await prisma.billingIdentity.create({data:{userId:user.user.id}});
  return prisma.billingPurchase.create({data:{identityId:identity.id,canonicalKey:randomUUID(),projectId:'test',appId:'test',store:'app_store',environment:'production',transactionId:randomUUID(),providerId:randomUUID(),productId:'coins_500',purchasedAt:clock,fulfillmentStatus:'fulfilled',benefitKind:'paid',...data}});
}
it('shares completed analytics and relational artifact across HTTP instances without warm analytics SQL', async () => {
  const replies=await Promise.all([stats(),stats(peer),stats(),stats(peer)]);
  assert.deepEqual(replies.map(r=>r.status),[200,200,200,200],JSON.stringify(events));
  const bodies=await Promise.all(replies.map(r=>r.json()));
  assert.equal(bodies[0].stats.snapshot.refreshIntervalSeconds,900);
  assert.equal(new Set(bodies.map(b=>b.stats.generatedAt)).size,1);
  assert.equal(events.filter(e=>e.event==='extraction').length,1);
  const before=events.filter(e=>e.event==='query').length;
  assert.equal((await stats(peer)).status,200);
  assert.equal(events.filter(e=>e.event==='query').length,before);
  assert.equal((await stats(peer,'dashboard-growth')).status,200);
  assert.equal(events.filter(e=>e.event==='extraction').length,1);
});
it('keeps the calculation timestamp, serves stale immediately and invalidates disabled configuration', async () => {
  const first=await (await stats()).json();
  clock=new Date(clock.getTime()+901000);
  const stale=await (await stats()).json();
  assert.equal(stale.stats.snapshot.status,'stale');
  assert.equal(stale.stats.generatedAt,first.stats.generatedAt);
  await appSettings.setFlag('adminMetricsV2DashboardEnabled',false);
  const disabled=await (await stats(peer)).json();
  assert.equal(disabled.stats.metricsDashboard.status,'disabled');
  assert.equal(disabled.stats.metricsDashboard.summary,undefined);
});
it('rejects unauthenticated/non-admin reads including warm analytics and purchase history',async()=>{
  await stats(); const user=await createTestUser({email:'ordinary@test.com'});
  for(const path of ['/admin/stats?sections=dashboard-summary','/admin/purchases']){
    assert.equal((await request(server.baseUrl,'GET',path)).status,401);
    assert.equal((await request(server.baseUrl,'GET',path,{token:user.token})).status,403);
  }
});
it('returns all receipt kinds with current public usernames and honest trial/refund/deletion metadata',async()=>{
  const user=await createTestUser({displayName:'RiverBara',email:'private@test.com'});
  await receipt(user); await receipt(user,{productId:'plus_monthly',subscriptionId:'sub',benefitKind:'trial'});
  await receipt(user,{productId:'plus_permanent',benefitKind:'permanent',refundedAt:clock});
  await receipt(user,{productId:'unknown_old_product',benefitKind:'unpaid'});
  await receipt(user,{environment:'sandbox'});
  const response=await purchases(); assert.equal(response.status,200); const page=await response.json();
  assert.equal(page.items.length,4); assert.equal(page.window.days,30);
  assert.deepEqual(new Set(page.items.map(r=>r.kind)),new Set(['coin_pack','subscription','other']));
  for(const row of page.items){assert.equal(row.username,'RiverBara');assert.equal(row.cashAmount,null);assert.equal(row.currency,null);assert.equal(row.userStatus,'active');assert.equal(row.environment,'production');assert.ok(!JSON.stringify(row).includes('private@test.com'));}
  assert.equal(page.items.find(r=>r.benefitKind==='trial').status,'trial');
  assert.equal(page.items.find(r=>r.benefitKind==='permanent').status,'refunded');
  await prisma.user.update({where:{id:user.user.id},data:{displayName:'NewUsername'}});
  assert.equal((await (await purchases('?kind=coin_pack')).json()).items[0].username,'NewUsername');
  await prisma.billingIdentity.update({where:{userId:user.user.id},data:{deletedAt:clock}});
  const deleted=(await (await purchases()).json()).items;assert.ok(deleted.every(r=>r.username===null&&r.userStatus==='deleted'));
});
it('paginates timestamp ties without repeats and validates cursor/filter/window binding and limits',async()=>{
  const user=await createTestUser({email:'buyer@test.com'});
  for(let i=0;i<7;i++)await receipt(user);
  const first=await (await purchases('?limit=3')).json(); assert.equal(first.items.length,3);assert.ok(first.nextCursor);
  const second=await (await purchases(`?limit=3&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
  const third=await (await purchases(`?limit=3&cursor=${encodeURIComponent(second.nextCursor)}`)).json();
  assert.equal(new Set([...first.items,...second.items,...third.items].map(r=>r.id)).size,7);
  assert.deepEqual(second.window,first.window);assert.equal(third.nextCursor,null);
  for(const query of ['?limit=51','?limit=0','?cursor=garbage',`?kind=subscription&cursor=${encodeURIComponent(first.nextCursor)}`]) assert.equal((await purchases(query)).status,400);
});
it('includes only recorded successful acquisitions and distinct paid ledger operations',async()=>{
  const user=await createTestUser({email:'shop-buyer@test.com',displayName:'Buyer'});
  const item=await prisma.shopItem.create({data:{id:randomUUID(),sku:randomUUID(),name:'Test hat',slot:'HEAD',priceCoins:9999,assetKey:'test.png'}});
  for(const [coins,result] of [[250,{purchase:{alreadyOwned:false,coinsSpent:250}}],[0,{purchase:{alreadyOwned:true,coinsSpent:0}}],[0,{purchase:{alreadyOwned:false,coinsSpent:0}}],[25,{adsWatched:2}],[0,{}]]) await prisma.shopPurchaseRequest.create({data:{userId:user.user.id,shopItemId:item.id,idempotencyKey:randomUUID(),status:'SUCCEEDED',coinsSpent:coins,resultJson:result,createdAt:clock}});
  for(const reason of ['powerup_upgrade','billing_reroll','shop_purchase'])await prisma.coinTransaction.create({data:{userId:user.user.id,amount:-75,reason,refId:randomUUID(),createdAt:clock}});
  const response=await purchases('?kind=in_game');assert.equal(response.status,200);const {items}=await response.json();
  assert.equal(items.length,6);assert.equal(items.filter(r=>r.funding==='coins_and_ads').length,1);
  assert.equal(items.filter(r=>r.status==='free'&&r.coinsSpent===0).length,1);
  assert.equal(items.filter(r=>r.funding==='unknown'&&r.coinsSpent===null).length,1);
  assert.ok(items.some(r=>r.coinsSpent===250));assert.equal(items.filter(r=>r.coinsSpent===75).length,2);
});
it('keeps exact nine-action reach despite event fan-out and distinct overlap',async()=>{
  const user=await createTestUser({email:'dau-buyer@test.com'});
  const race=await prisma.race.create({data:{creatorId:user.user.id,name:'Actions',targetSteps:1000,status:'ACTIVE',createdAt:clock}});
  await prisma.racePowerupEvent.createMany({data:[1,2,3].map(i=>({raceId:race.id,actorUserId:user.user.id,eventType:'MYSTERY_BOX_OPENED',description:`box ${i}`,createdAt:clock}))});
  const response=await stats(server,'dashboard-dau-engagement');assert.equal(response.status,200);
  const today=(await response.json()).stats.metricsDashboard.dauEngagement.today;
  assert.equal(today.actions.boxOpen.events,3);assert.equal(today.actions.boxOpen.users,1);
  assert.equal(today.usersWithAnyAction,1);assert.equal(today.averageActionReach,0.2);
});
it('uses ET midnight on both DST transition days when assessing eligible foreground users',async()=>{
  for(const [date,at,eligibleAt] of [['2026-03-08','2026-03-08T05:00:00Z','2026-03-08T04:30:00Z'],['2026-11-01','2026-11-01T04:00:00Z','2026-11-01T04:30:00Z']]){
    await redis.flushdb();clock=new Date(`${date}T16:00:00Z`);
    await prisma.adminMetricsCollectionEpoch.updateMany({where:{endedAt:null},data:{endedAt:clock}});
    const epoch=await prisma.adminMetricsCollectionEpoch.create({data:{startedAt:new Date(at)}});
    const user=await createTestUser({email:`dst-${date}@test.com`});
    await prisma.user.update({where:{id:user.user.id},data:{metricsV2EligibleEpochId:epoch.id,metricsV2EligibleAt:new Date(eligibleAt)}});
    await prisma.userActivityDay.create({data:{userId:user.user.id,activityDate:new Date(date),firstSeenAt:clock,lastSeenAt:clock,appVersion:'2.5.0',metadataOccurredAt:clock}});
    const response=await stats();assert.equal(response.status,200);const coverage=(await response.json()).stats.metricsDashboard.coverage;
    assert.equal(coverage.metricCoverage.observedForegroundDau.status,'mature');
    assert.equal(coverage.metricCoverage.observedForegroundDau.eligible,date==='2026-03-08'?1:0);
  }
});
it('binds snapshot generations to atomic telemetry/epoch and coverage changes',async()=>{
  const first=await (await stats()).json();
  await appSettings.setFlagsAtomically([['adminMetricsV2TelemetryEnabled',true]]);
  const next=await (await stats(peer)).json();
  assert.equal(next.stats.metricsDashboard.sources.foregroundActivity.status,'collecting');
  assert.notEqual(next.stats.metricsDashboard.coverage.foregroundActivitySince,first.stats.metricsDashboard.coverage.foregroundActivitySince);
  assert.equal(events.filter(e=>e.event==='extraction').length,2);
  await prisma.metricCoverageStart.create({data:{metric:'boxOpen',operationalAt:clock}});
  const changed=await (await stats()).json();assert.ok(changed.stats.metricsDashboard.coverage.boxOpenOperationalSince);
  assert.equal(events.filter(e=>e.event==='extraction').length,3);
});
it('rejects a stolen lease publication and shares failure backoff without another extraction',async()=>{
  let stolen=false;const sabotage=[];
  const attacker=await startServer({adminAnalyticsNow:()=>clock,adminAnalyticsObserver:event=>{
    sabotage.push(event);
    if(event.event==='extraction'&&!stolen){stolen=true;redis.set(`${process.env.CACHE_ENV_PREFIX}admin:analytics:v1:lease`,'another-owner','PX',60000);}
  }});
  try{
    const response=await stats(attacker);assert.equal(response.status,503);
    const keys=await redis.keys(`${process.env.CACHE_ENV_PREFIX}admin:analytics:v1:*dashboard-summary*`);assert.equal(keys.length,0);
    assert.ok(sabotage.some(e=>e.event==='failure'));
  }finally{await attacker.close();await redis.del(`${process.env.CACHE_ENV_PREFIX}admin:analytics:v1:lease`);}
});
it('serves bounded local completed data on Redis failure and fails cold without analytics SQL',async()=>{
  await stats();const queryCount=events.filter(e=>e.event==='query').length;assert.ok(queryCount>0);
  // Redis wrapper failure is a dependency-injected transport failure; the real
  // HTTP handler, config DB read, existing completed cache and DB remain real.
  const cache=require('../../src/shared/cache/redisCache');const original=cache.evalLua;
  cache.evalLua=async()=>({ok:false,disabled:false,result:null});
  try{
    const warm=await stats();assert.equal(warm.status,200);assert.equal(events.filter(e=>e.event==='query').length,queryCount);
    const cold=await stats(peer,'dashboard-release-adoption');assert.equal(cold.status,503);assert.equal(cold.headers.get('retry-after'),'15');
    assert.equal((await cold.json()).code,'ADMIN_ANALYTICS_UNAVAILABLE');assert.equal(events.filter(e=>e.event==='query').length,queryCount);
    clock=new Date(clock.getTime()+86400001);assert.equal((await stats()).status,503);
  }finally{cache.evalLua=original;}
});
it('paginates across mixed sources and microsecond timestamps with actual powerup purchase records',async()=>{
  const user=await createTestUser({email:'mixed-purchase@test.com'});
  await receipt(user);await receipt(user,{productId:'plus_permanent',benefitKind:'permanent'});
  for(let i=0;i<3;i++) await prisma.powerupPurchaseRequest.create({data:{userId:user.user.id,powerupShopItemId:'historical-powerup',idempotencyKey:randomUUID(),status:'SUCCEEDED',coinsSpent:i===0?0:25,resultJson:i===0?{adsWatched:2}:{purchase:{coinsSpent:25}},createdAt:clock}});
  await prisma.coinTransaction.create({data:{userId:user.user.id,amount:-30,reason:'powerup_upgrade',refId:randomUUID(),createdAt:clock}});
  await prisma.$executeRaw`UPDATE powerup_purchase_requests SET created_at=CAST(${clock.toISOString()} AS timestamp)-interval '1 millisecond'+interval '100 microseconds'`;
  let cursor=null,all=[];do{const response=await purchases(`?limit=2${cursor?'&cursor='+encodeURIComponent(cursor):''}`);assert.equal(response.status,200);const page=await response.json();all.push(...page.items);cursor=page.nextCursor;}while(cursor);
  assert.equal(all.length,6);assert.equal(new Set(all.map(r=>r.id)).size,6);
  assert.ok(all.some(r=>r.funding==='ads'&&r.coinsSpent===0));
  assert.equal(all.filter(r=>r.id.startsWith('powerup:')).length,3);
});
it('deduplicates across independent Node HTTP workers and Redis leases',async()=>{
  const {fork}=require('node:child_process');const path=require('node:path');const children=[];const measurements=[];
  try{
    const urls=[];
    for(let i=0;i<2;i++){
      const child=fork(path.join(__dirname,'adminSnapshotHttpProcess.cjs'),[],{env:{...process.env},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
      urls.push(await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child HTTP startup timeout')),10000);child.on('message',m=>{if(m.event)measurements.push(m.event);if(m.url){clearTimeout(timer);resolve(m.url);}});child.once('error',reject);}));
    }
    const responses=await Promise.all(urls.flatMap(url=>[1,2].map(()=>request(url,'GET','/admin/stats?sections=dashboard-summary',{token:admin.token}))));
    assert.deepEqual(responses.map(r=>r.status),[200,200,200,200]);
    assert.equal(measurements.filter(e=>e.event==='extraction').length,1);
    const before=measurements.filter(e=>e.event==='query').length;assert.ok(before>0);
    assert.equal((await request(urls[1],'GET','/admin/stats?sections=dashboard-summary',{token:admin.token})).status,200);
    assert.equal(measurements.filter(e=>e.event==='query').length,before);
  }finally{for(const child of children){if(child.exitCode===null){child.send('stop');await once(child,'exit');}}}
});
it('cancels timed-out SQL and shares a failure backoff instead of retrying expensive work',async()=>{
  const actualPool=require('../../src/db').pool;let slowQueries=0;
  const faultPool={connect:async()=>{const client=await actualPool.connect();return new Proxy(client,{get(target,key){if(key==='query')return (sql,...args)=>{if(typeof sql==='string'&&sql.includes('total_signups')){slowQueries++;return target.query('SELECT pg_sleep(10)');}return target.query(sql,...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}};
  const failedEvents=[];const faulty=await startServer({pool:faultPool,adminAnalyticsNow:()=>clock,adminAnalyticsObserver:e=>failedEvents.push(e)});
  try{
    assert.equal((await stats(faulty)).status,503);assert.equal(slowQueries,1);
    assert.ok(failedEvents.some(e=>e.event==='failure'));
    const before=events.filter(e=>e.event==='query').length;
    assert.equal((await stats(peer)).status,503);assert.equal(events.filter(e=>e.event==='query').length,before);assert.equal(slowQueries,1);
    // A new collection generation is allowed to recover immediately.
    await prisma.metricCoverageStart.create({data:{metric:'boxOpen',operationalAt:clock}});
    assert.equal((await stats(peer)).status,200);
  }finally{await faulty.close();}
});
it('refuses an over-budget extraction without returning truncated counts or launching CPU work',async()=>{
  await prisma.$executeRaw`INSERT INTO user_activity_days(user_id,activity_date,first_seen_at,last_seen_at,app_version,metadata_occurred_at)
    SELECT ${admin.user.id},current_date-n,now(),now(),'test',now() FROM generate_series(1,200001)n`;
  const response=await stats();assert.equal(response.status,503);
  assert.ok(events.some(e=>e.event==='failure'&&e.reason.includes('size budget')));
  assert.equal(events.filter(e=>e.event==='worker').length,0);
  assert.equal(events.filter(e=>e.event==='query'&&e.phase==='section').length,0);
});
it('keeps empty historical purchase metadata unknown rather than inventing free or paid provenance',async()=>{
  const user=await createTestUser({email:'empty-purchase@test.com'});
  for(const coins of [0,70])await prisma.powerupPurchaseRequest.create({data:{userId:user.user.id,powerupShopItemId:'historical-powerup',idempotencyKey:randomUUID(),status:'SUCCEEDED',coinsSpent:coins,resultJson:{purchase:{}},createdAt:clock}});
  const response=await purchases('?kind=in_game');assert.equal(response.status,200);
  const page=await response.json();assert.equal(page.items.length,2);
  for(const row of page.items){assert.equal(row.funding,'unknown');assert.equal(row.status,'unknown');assert.equal(row.coinsSpent,null);}
});
it('fails closed during an actual Redis outage and does not relabel yesterday as today',async()=>{
  assert.equal((await stats()).status,200);const queries=events.filter(e=>e.event==='query').length;
  const exited=once(redisProcess,'exit');redisProcess.kill('SIGTERM');await exited;
  assert.equal((await stats()).status,200);
  assert.equal((await stats(peer,'dashboard-release-adoption')).status,503);
  clock=new Date(clock.getTime()+86400000);
  assert.equal((await stats()).status,503);
  assert.equal(events.filter(e=>e.event==='query').length,queries);
});
