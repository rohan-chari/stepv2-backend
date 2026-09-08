const assert = require('node:assert/strict');
const { before, after, beforeEach, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { cleanDatabase, prisma, request, startServer, createTestUser } = require('../setup');
let server;
let history;
const config = { projectId:'proj_bara', secretApiKey:'integration-only', webhookAuthorization:'Bearer integration-webhook', iosAppId:'app_ios', androidAppId:'app_android', termsUrl:'https://barastep.com/billing-terms', privacyUrl:'https://barastep.com/privacy' };
before(async () => { server = await startServer({ billingConfig:config, billingProvider:{ async getCustomerHistory() { return history; } } }); });
after(async () => { await server?.close(); });
beforeEach(async () => { await cleanDatabase(); history={ purchases:[], subscriptions:[], observedAt:new Date().toISOString() }; });
async function bootstrap(token) { const res=await request(server.baseUrl,'GET','/billing/bootstrap?platform=ios',{token}); assert.equal(res.status,200); return res.json(); }
for (const platform of ['ios', 'android']) {
 it(`supports ${platform} checkout and account sync with only that store configured`, async () => {
  const other = platform === 'ios' ? 'android' : 'ios';
  const singleConfig = {...config, [`${other}AppId`]: undefined};
  const app = await startServer({billingConfig:singleConfig, billingProvider:{async getCustomerHistory(){return history;}}});
  try {
   const {token} = await createTestUser({coins:350});
   const get = async selected => {
    const response = await request(app.baseUrl, 'GET', `/billing/bootstrap?platform=${selected}`, {token});
    assert.equal(response.status,200); return response.json();
   };
   const enabled = await get(platform);
   assert.equal(enabled.available,true); assert.equal(enabled.products.length,5);
   const disabled = await get(other);
   assert.equal(disabled.available,false); assert.deepEqual(disabled.products,[]);
   assert.equal(disabled.coins,350); assert.equal(disabled.reroll.supported,true);
   // Account reconciliation remains usable from either platform, even when
   // checkout on the current device has not yet been configured.
   for (const selected of [platform, other]) {
    const response = await request(app.baseUrl,'POST',`/billing/sync?platform=${selected}`,{token,body:{}});
    assert.equal(response.status,200);
    const state = await response.json(); assert.equal(state.coins,350);
    assert.equal(state.available,selected===platform);
   }
  } finally { await app.close(); }
 });
}
it('authenticates billing and creates a stable opaque account identity without minting', async () => {
  assert.equal((await request(server.baseUrl,'GET','/billing/bootstrap')).status,401);
  const {user,token}=await createTestUser({coins:350});
  const first=await bootstrap(token), again=await bootstrap(token);
  assert.equal(first.available,true); assert.equal(first.contract,'bara-billing-v1');
  assert.match(first.identity.appUserId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(first.identity.appUserId,again.identity.appUserId); assert.notEqual(first.identity.appUserId,user.id);
  assert.deepEqual(first.products.map(p=>p.coins),[500,2800,6000,500,500]);
  assert.equal(first.coins,350); assert.equal(first.membership.status,'free');
  assert.deepEqual(first.credits,{paid:0,trial:0,trialExpiresAt:null});
  assert.equal(first.termsUrl,config.termsUrl);
});
it('treats transaction hints as pending, never as a coin grant',async()=>{
 const {token}=await createTestUser({coins:350}); await bootstrap(token);
 const response=await request(server.baseUrl,'POST','/billing/sync',{token,body:{transactionId:'forged'}});
 assert.equal(response.status,202); const body=await response.json(); assert.equal(body.status,'pending'); assert.equal(body.coins,350);
});
it('rejects malformed paid reroll consent before touching wallet',async()=>{
 const {token}=await createTestUser({coins:100});
 const response=await request(server.baseUrl,'POST','/races/missing/powerups/reroll-purchase',{token,body:{powerupIds:['a'],funding:'coins',expectedCoinCost:50}});
 assert.equal(response.status,400); assert.equal((await response.json()).code,'INVALID_IDEMPOTENCY_KEY');
 const duplicate=await request(server.baseUrl,'POST','/races/missing/powerups/reroll-purchase',{token,headers:{'Idempotency-Key':randomUUID()},body:{powerupIds:['a','a'],funding:'coins',expectedCoinCost:50}});
 assert.equal(duplicate.status,400); assert.equal((await duplicate.json()).code,'INVALID_REROLL_REQUEST');
});
it('authenticates and deduplicates durable webhook inbox without synchronously granting',async()=>{
 const {token}=await createTestUser(); const state=await bootstrap(token);
 const body={api_version:'1.0',event:{id:'event-1',type:'NON_RENEWING_PURCHASE',app_user_id:state.identity.appUserId,app_id:'app_ios',environment:'PRODUCTION',store:'APP_STORE',product_id:'bara_coins_500_v1',transaction_id:'purchase-1',event_timestamp_ms:Date.now()}};
 assert.equal((await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body})).status,401);
 for(let i=0;i<2;i++) assert.equal((await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body,headers:{Authorization:config.webhookAuthorization}})).status,200);
 assert.equal(await prisma.billingInbox.count(),1); assert.equal((await bootstrap(token)).coins,0);
});
async function fixture(coins=100){const owner=await createTestUser({coins});const race=await prisma.race.create({data:{creatorId:owner.user.id,name:'Billing race',targetSteps:20000,status:'ACTIVE',startedAt:new Date(),maxDurationDays:1}});const participant=await prisma.raceParticipant.create({data:{raceId:race.id,userId:owner.user.id,status:'ACCEPTED'}});const items=[];for(let i=0;i<2;i++)items.push(await prisma.racePowerup.create({data:{raceId:race.id,participantId:participant.id,userId:owner.user.id,type:'PROTEIN_SHAKE',rarity:'COMMON'}}));return {...owner,race,items};}
async function reroll(f,key=randomUUID(),body={}){return request(server.baseUrl,'POST',`/races/${f.race.id}/powerups/reroll-purchase`,{token:f.token,headers:{'Idempotency-Key':key,'X-Client-Features':'powerups5'},body:{powerupIds:f.items.map(i=>i.id),funding:'coins',expectedCoinCost:50,...body}});}
it('charges one action for a whole batch and replays its durable response after race end',async()=>{
 const f=await fixture(),key=randomUUID();const first=await reroll(f,key);assert.equal(first.status,200);const result=await first.json();assert.equal(result.coins,50);assert.deepEqual(result.charged,{coins:50,paidCredits:0,trialCredits:0});assert.equal(result.results.length,2);assert.ok(result.results.every(r=>r.rerolledAt&&r.rerolled));
 await prisma.race.update({where:{id:f.race.id},data:{status:'COMPLETED'}});
 const replay=await reroll(f,key);assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
 assert.equal(await prisma.coinTransaction.count({where:{userId:f.user.id,reason:'billing_reroll'}}),1);
 const conflict=await reroll(f,key,{powerupIds:[f.items[0].id]});assert.equal(conflict.status,409);assert.equal((await conflict.json()).code,'IDEMPOTENCY_CONFLICT');
});
it('rejects the entire batch without debit if any item became ineligible',async()=>{
 const f=await fixture();await prisma.racePowerup.update({where:{id:f.items[1].id},data:{rerolledAt:new Date()}});
 const res=await reroll(f);assert.equal(res.status,409);assert.equal((await res.json()).code,'ALREADY_REROLLED');
 assert.equal((await prisma.user.findUnique({where:{id:f.user.id}})).coins,100);
 assert.equal((await prisma.racePowerup.findUnique({where:{id:f.items[0].id}})).rerolledAt,null);
});
it('serializes competing paid requests so one action is charged exactly once',async()=>{
 const f=await fixture();const replies=await Promise.all([reroll(f),reroll(f)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 assert.equal((await prisma.user.findUnique({where:{id:f.user.id}})).coins,50);
});
async function member(userId){const identity=await prisma.billingIdentity.create({data:{userId}});await prisma.billingSubscription.create({data:{id:randomUUID(),identityId:identity.id,productId:'plus_monthly',startsAt:new Date(),periodStartsAt:new Date(),accessUntil:new Date(Date.now()+86400000),givesAccess:true,observedAt:new Date()}});return identity;}
it('serves and charges the same member price on legacy cosmetic and powerup paths',async()=>{
 const {user,token}=await createTestUser({coins:1000});await member(user.id);
 const cosmetic=await prisma.shopItem.create({data:{sku:'billing_hat',name:'Billing Hat',slot:'HEAD',assetKey:'straw_hat',priceCoins:201}});
 const powerup=await prisma.powerupShopItem.upsert({where:{sku:'POWERUP_GHOST_PEPPER'},create:{sku:'POWERUP_GHOST_PEPPER',name:'Ghost Pepper',description:'',powerupType:'GHOST_PEPPER',priceCoins:200},update:{priceCoins:200,active:true}});
 const c=await request(server.baseUrl,'GET','/shop/catalog',{token});assert.equal(c.status,200);const item=(await c.json()).items.find(i=>i.id===cosmetic.id);assert.equal(item.priceCoins,171);assert.equal(item.basePriceCoins,201);assert.equal(item.discountPercent,15);
 const stale=await request(server.baseUrl,'POST',`/shop/items/${cosmetic.id}/purchase`,{token,headers:{'Idempotency-Key':randomUUID()},body:{expectedPriceCoins:201}});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'PRICE_CHANGED');
 const bought=await request(server.baseUrl,'POST',`/shop/items/${cosmetic.id}/purchase`,{token,headers:{'Idempotency-Key':randomUUID()},body:{}});assert.equal(bought.status,200);assert.equal((await bought.json()).coins,829);
 const p=await request(server.baseUrl,'POST','/shop/powerups/purchase',{token,headers:{'Idempotency-Key':randomUUID(),'X-Client-Features':'powerups5'},body:{sku:powerup.sku}});assert.equal(p.status,200);assert.equal((await p.json()).coins,659);
});
it('keeps existing public race-share routing unauthenticated',async()=>{
 const res=await request(server.baseUrl,'GET','/races/share/not-a-real-share-token');assert.equal(res.status,404);
});
it('preserves bodyless legacy cosmetic checkout',async()=>{
 const {token}=await createTestUser({coins:100});const item=await prisma.shopItem.create({data:{sku:'bodyless',name:'Hat',slot:'HEAD',assetKey:'straw_hat',priceCoins:50}});
 const res=await request(server.baseUrl,'POST',`/shop/items/${item.id}/purchase`,{token,headers:{'Idempotency-Key':randomUUID()}});assert.equal(res.status,200);assert.equal((await res.json()).coins,50);
});
it('preserves the seeded bucket capability gate on the additive paid route',async()=>{
 const f=await fixture();await prisma.race.update({where:{id:f.race.id},data:{seededBucketId:randomUUID()}});
 const res=await reroll(f);assert.equal(res.status,404);assert.equal((await res.json()).code,'RACE_NOT_FOUND');assert.equal((await prisma.user.findUnique({where:{id:f.user.id}})).coins,100);
});
it('retains a tombstoned billing identity after authenticated account deletion',async()=>{
 const {user,token}=await createTestUser();const state=await bootstrap(token);
 const res=await request(server.baseUrl,'DELETE','/auth/account',{token});assert.equal(res.status,204);
 assert.equal(await prisma.user.findUnique({where:{id:user.id}}),null);
 const identity=await prisma.billingIdentity.findUnique({where:{id:state.identity.appUserId}});assert.ok(identity.deletedAt);assert.equal(identity.userId,user.id);
});
it('accepts concurrent copies of the same authenticated webhook once',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token);const body={event:{id:'parallel-event',type:'TEST',app_user_id:state.identity.appUserId}};
 const send=()=>request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body,headers:{Authorization:config.webhookAuthorization}});
 const replies=await Promise.all([send(),send()]);assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.equal(await prisma.billingInbox.count(),1);
});
it('spends one expiring trial credit before paid credits and keeps paid credits usable after expiry',async()=>{
 const f=await fixture(),identity=await member(f.user.id);
 await prisma.billingCreditLot.create({data:{identityId:identity.id,sourceKey:'trial-1',kind:'trial',granted:3,remaining:3,expiresAt:new Date(Date.now()+86400000)}});
 await prisma.billingCreditLot.create({data:{identityId:identity.id,sourceKey:'paid-1',kind:'paid',granted:10,remaining:10}});
 const first=await reroll(f,randomUUID(),{funding:'credits'});assert.equal(first.status,200);const result=await first.json();assert.deepEqual(result.charged,{coins:0,paidCredits:0,trialCredits:1});assert.equal(result.coins,100);assert.equal(result.credits.paid,10);assert.equal(result.credits.trial,2);
 await prisma.billingSubscription.updateMany({where:{identityId:identity.id},data:{givesAccess:false,accessUntil:new Date(Date.now()-1000)}});
 await prisma.billingCreditLot.updateMany({where:{identityId:identity.id,kind:'trial'},data:{expiresAt:new Date(Date.now()-1000)}});
 const held=await prisma.racePowerup.create({data:{raceId:f.race.id,participantId:f.items[0].participantId,userId:f.user.id,type:'PROTEIN_SHAKE',rarity:'COMMON'}});
 const second=await reroll(f,randomUUID(),{funding:'credits',powerupIds:[held.id]});assert.equal(second.status,200);const last=await second.json();assert.deepEqual(last.charged,{coins:0,paidCredits:1,trialCredits:0});assert.equal(last.credits.paid,9);assert.equal(last.credits.trial,0);
});
it('keeps coin rerolls available when RevenueCat checkout has no configuration',async()=>{
 const unconfigured=await startServer({billingConfig:{}});try{
 const {token}=await createTestUser({coins:60});const res=await request(unconfigured.baseUrl,'GET','/billing/bootstrap',{token});assert.equal(res.status,200);const state=await res.json();assert.equal(state.available,false);assert.equal(state.reroll.supported,true);assert.equal(state.coins,60);assert.deepEqual(state.products,[]);
 }finally{await unconfigured.close();}
});
function purchase(overrides={}){return {transactionId:'store-paid-1',providerId:'p1',productId:'coins_500',appId:'app_ios',store:'app_store',environment:'production',purchasedAt:new Date().toISOString(),expiresAt:null,quantity:1,paid:true,refunded:false,subscriptionId:null,...overrides};}
function subscription(overrides={}){return {providerId:'sub1',productId:'plus_monthly',appId:'app_ios',store:'app_store',environment:'production',startsAt:new Date().toISOString(),periodStartsAt:new Date().toISOString(),accessUntil:new Date(Date.now()+30*86400000).toISOString(),givesAccess:true,trial:false,renews:true,managementUrl:'https://apps.apple.com/account/subscriptions',...overrides};}
async function sync(token,transactionId){const res=await request(server.baseUrl,'POST','/billing/sync',{token,body:transactionId?{transactionId}:{}});return {status:res.status,body:await res.json()};}
it('fulfills a verified coin transaction once under concurrent sync, never trusts hint quantity',async()=>{
 const {user,token}=await createTestUser({coins:20});await bootstrap(token);history.purchases=[purchase()];
 const replies=await Promise.all([sync(token,'store-paid-1'),sync(token,'store-paid-1')]);assert.ok(replies.every(r=>[200,202].includes(r.status)));
 const final=await sync(token,'store-paid-1');assert.equal(final.status,200);assert.equal(final.body.coins,520);assert.equal(await prisma.coinTransaction.count({where:{userId:user.id,reason:'billing_purchase'}}),1);
});
it('issues trial credits without permanent gifts, then full paid monthly and annual benefits once',async()=>{
 const {token}=await createTestUser();await bootstrap(token);const start=new Date(),trialEnd=new Date(Date.now()+7*86400000);
 history.subscriptions=[subscription({trial:true,startsAt:start.toISOString(),periodStartsAt:start.toISOString(),accessUntil:trialEnd.toISOString()})];history.purchases=[purchase({transactionId:'trial',productId:'plus_monthly',paid:false,subscriptionId:'sub1',purchasedAt:start.toISOString(),expiresAt:trialEnd.toISOString()})];
 let result=await sync(token,'trial');assert.equal(result.status,200);assert.equal(result.body.membership.status,'trial');assert.equal(result.body.coins,0);assert.equal(result.body.credits.trial,3);
 history.subscriptions=[subscription({trial:false})];history.purchases.push(purchase({transactionId:'paid-month',productId:'plus_monthly',subscriptionId:'sub1',expiresAt:history.subscriptions[0].accessUntil}));
 result=await sync(token,'paid-month');assert.equal(result.status,200);assert.equal(result.body.coins,500);assert.equal(result.body.credits.paid,10);assert.equal(result.body.credits.trial,0);
 history.subscriptions=[subscription({productId:'plus_annual',periodStartsAt:new Date(Date.now()+1000).toISOString(),accessUntil:new Date(Date.now()+365*86400000).toISOString()})];history.purchases.push(purchase({transactionId:'paid-year',productId:'plus_annual',subscriptionId:'sub1',expiresAt:history.subscriptions[0].accessUntil}));
 result=await sync(token,'paid-year');assert.equal(result.body.coins,6500);assert.equal(result.body.credits.paid,130);assert.equal((await sync(token,'paid-year')).body.coins,6500);
});
it('absorbs spent refund value, revokes only unused attributable credits, and restores only recovered amounts',async()=>{
 const {user,token}=await createTestUser();const state=await bootstrap(token);history.subscriptions=[subscription()];history.purchases=[purchase({productId:'plus_monthly',subscriptionId:'sub1',expiresAt:history.subscriptions[0].accessUntil})];await sync(token,'store-paid-1');
 await prisma.user.update({where:{id:user.id},data:{coins:80}});await prisma.billingCreditLot.updateMany({where:{identityId:state.identity.appUserId,kind:'paid'},data:{remaining:4}});
 const refund={event:{id:'refund',type:'CANCELLATION',cancel_reason:'CUSTOMER_SUPPORT',app_user_id:state.identity.appUserId,app_id:'app_ios',store:'APP_STORE',environment:'PRODUCTION',product_id:'bara_plus_monthly_v1',transaction_id:'store-paid-1',event_timestamp_ms:Date.now()}};
 await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:refund,headers:{Authorization:config.webhookAuthorization}});
 let result=await sync(token,'store-paid-1');assert.equal(result.status,200);assert.equal(result.body.coins,0);assert.equal(result.body.credits.paid,0);
 await prisma.user.update({where:{id:user.id},data:{coins:25}});result=await sync(token,'store-paid-1');assert.equal(result.body.coins,25);
 const reversal={event:{...refund.event,id:'reverse',type:'REFUND_REVERSED',event_timestamp_ms:Date.now()+1000}};await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:reversal,headers:{Authorization:config.webhookAuthorization}});
 result=await sync(token,'store-paid-1');assert.equal(result.body.coins,105);assert.equal(result.body.credits.paid,4);
});
it('does not mint sandbox or another app transactions into a normal account',async()=>{
 const {token}=await createTestUser();await bootstrap(token);history.purchases=[purchase({environment:'sandbox'})];let res=await sync(token);assert.equal(res.status,409);assert.equal(res.body.code,'BILLING_REALM_MISMATCH');assert.equal((await bootstrap(token)).coins,0);
 history.purchases=[purchase({appId:'wrong_app'})];res=await sync(token);assert.equal(res.status,503);assert.equal((await bootstrap(token)).coins,0);
});
it('recovers thirteen touched UTC calendar months once and never substitutes an already owned cosmetic',async()=>{
 const {user,token}=await createTestUser();const state=await bootstrap(token),now=new Date(),start=new Date(Date.UTC(now.getUTCFullYear()-1,now.getUTCMonth(),1)),end=new Date(now.getTime()+86400000);
 const item=await prisma.shopItem.create({data:{sku:'calendar_hat',name:'Calendar Hat',slot:'HEAD',assetKey:'straw_hat',priceCoins:0}});await prisma.userShopItem.create({data:{userId:user.id,shopItemId:item.id}});
 for(let n=0;n<13;n++){const month=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+n,1)).toISOString().slice(0,7);await prisma.billingCosmeticRelease.create({data:{month,shopItemId:item.id}});}
 history.subscriptions=[subscription({productId:'plus_annual',startsAt:start.toISOString(),periodStartsAt:start.toISOString(),accessUntil:end.toISOString()})];history.purchases=[purchase({productId:'plus_annual',subscriptionId:'sub1',purchasedAt:start.toISOString(),expiresAt:end.toISOString()})];
 const result=await sync(token);assert.equal(result.status,200);assert.equal(result.body.cosmetic.item.id,item.id);assert.equal(await prisma.billingCosmeticGrant.count({where:{identityId:state.identity.appUserId}}),13);assert.equal(await prisma.userShopItem.count({where:{userId:user.id}}),1);await sync(token);assert.equal(await prisma.billingCosmeticGrant.count(),13);
});
it('records refund before first fulfillment without minting or taking earned coins',async()=>{
 const {token}=await createTestUser({coins:60});const state=await bootstrap(token);history.purchases=[purchase()];
 const body={event:{id:'early-refund',type:'CANCELLATION',cancel_reason:'CUSTOMER_SUPPORT',app_user_id:state.identity.appUserId,app_id:'app_ios',store:'APP_STORE',environment:'PRODUCTION',product_id:'bara_coins_500_v1',transaction_id:'store-paid-1',event_timestamp_ms:Date.now()}};
 await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body,headers:{Authorization:config.webhookAuthorization}});const result=await sync(token,'store-paid-1');assert.equal(result.status,200);assert.equal(result.body.coins,60);assert.equal(await prisma.coinTransaction.count(),0);
});
it('does not replace current paid membership with an older provider period',async()=>{
 const {token}=await createTestUser();await bootstrap(token);history.subscriptions=[subscription({productId:'plus_annual'})];history.purchases=[purchase({productId:'plus_annual',subscriptionId:'sub1',expiresAt:history.subscriptions[0].accessUntil})];await sync(token);
 history.subscriptions=[subscription({periodStartsAt:new Date(Date.now()-30*86400000).toISOString(),accessUntil:new Date(Date.now()-1000).toISOString(),givesAccess:false})];const result=await sync(token);assert.equal(result.body.membership.plan,'annual');assert.equal(result.body.membership.status,'active');assert.equal(result.body.coins,6000);
});
async function cli(script,args){const {execFile}=require('node:child_process');const {promisify}=require('node:util');return promisify(execFile)(process.execPath,[`scripts/${script}`,...args],{cwd:require('node:path').resolve(__dirname,'../../..'),env:{...process.env,REVENUECAT_PROJECT_ID:config.projectId,REVENUECAT_IOS_APP_ID:config.iosAppId,REVENUECAT_ANDROID_APP_ID:config.androidAppId},timeout:20000});}
it('imports missed refund export updates idempotently and never grants from CSV alone',async()=>{
 const {mkdtemp,writeFile,rm}=require('node:fs/promises'),path=require('node:path');const dir=await mkdtemp(path.join(require('node:os').tmpdir(),'bara-refunds-'));try{
 const {token}=await createTestUser({coins:60});const state=await bootstrap(token);history.purchases=[purchase()];await sync(token,'store-paid-1');
 const stamp=new Date(),file=path.join(dir,'transactions.csv');const header='store_transaction_id,product_identifier,store,is_sandbox,rc_original_app_user_id,refunded_at,updated_at\n';const row=`store-paid-1,bara_coins_500_v1,app_store,false,${state.identity.appUserId},${stamp.toISOString()},${stamp.toISOString()}\n`;await writeFile(file,header+row);
 await cli('billing-import-refunds.js',[`--file=${file}`]);assert.equal(await prisma.billingInbox.count(),0);
 await cli('billing-import-refunds.js',[`--file=${file}`,'--apply']);await cli('billing-import-refunds.js',[`--file=${file}`,'--apply']);assert.equal(await prisma.billingInbox.count(),1);
 const result=await sync(token,'store-paid-1');assert.equal(result.body.coins,60);
 await writeFile(file,header+`unknown,bara_coins_500_v1,app_store,false,${state.identity.appUserId},${stamp.toISOString()},${stamp.toISOString()}\n`);await cli('billing-import-refunds.js',[`--file=${file}`,'--apply']);assert.equal((await sync(token)).body.coins,60);assert.equal(await prisma.billingPurchase.count(),1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('publishes only a compatible immutable monthly cosmetic through the operator CLI',async()=>{
 const month=new Date().toISOString().slice(0,7),item=await prisma.shopItem.create({data:{sku:'publish_hat',name:'Published Hat',slot:'HEAD',assetKey:'straw_hat',priceCoins:0,testOnly:true}});
 await assert.rejects(cli('billing-publish-cosmetic.js',[`--month=${month}`,`--item-id=${item.id}`,'--apply']));assert.equal(await prisma.billingCosmeticRelease.count(),0);
 await prisma.shopItem.update({where:{id:item.id},data:{testOnly:false}});await cli('billing-publish-cosmetic.js',[`--month=${month}`,`--item-id=${item.id}`]);assert.equal(await prisma.billingCosmeticRelease.count(),0);
 await cli('billing-publish-cosmetic.js',[`--month=${month}`,`--item-id=${item.id}`,'--apply']);await cli('billing-publish-cosmetic.js',[`--month=${month}`,`--item-id=${item.id}`,'--apply']);assert.equal(await prisma.billingCosmeticRelease.count(),1);
 const second=await prisma.shopItem.create({data:{sku:'other_hat',name:'Other',slot:'HEAD',assetKey:'straw_hat',priceCoins:0}});await assert.rejects(cli('billing-publish-cosmetic.js',[`--month=${month}`,`--item-id=${second.id}`,'--apply']));assert.equal((await prisma.billingCosmeticRelease.findUnique({where:{month}})).shopItemId,item.id);
});
it('retains store-verified member access after refund while reversing financial gifts',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token);history.subscriptions=[subscription()];history.purchases=[purchase({productId:'plus_monthly',subscriptionId:'sub1',expiresAt:history.subscriptions[0].accessUntil})];await sync(token);
 const body={event:{id:'refund-access',type:'CANCELLATION',cancel_reason:'CUSTOMER_SUPPORT',app_user_id:state.identity.appUserId,app_id:'app_ios',store:'APP_STORE',environment:'PRODUCTION',product_id:'bara_plus_monthly_v1',transaction_id:'store-paid-1',event_timestamp_ms:Date.now()}};
 await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body,headers:{Authorization:config.webhookAuthorization}});const result=await sync(token);assert.equal(result.body.coins,0);assert.equal(result.body.membership.status,'active');assert.equal(result.body.membership.discountPercent,15);
});
it('restores verified paid cosmetic coverage after an explicit refund reversal',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token),now=new Date(),start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-2,1)),short=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)-1),end=new Date(now.getTime()+30*86400000);
 const item=await prisma.shopItem.create({data:{sku:'restore_calendar',name:'Restore Hat',slot:'HEAD',assetKey:'straw_hat',priceCoins:0}});await prisma.billingCosmeticRelease.create({data:{month:now.toISOString().slice(0,7),shopItemId:item.id}});
 history.subscriptions=[subscription({startsAt:start.toISOString(),periodStartsAt:start.toISOString(),accessUntil:end.toISOString()})];history.purchases=[purchase({productId:'plus_monthly',subscriptionId:'sub1',purchasedAt:start.toISOString(),expiresAt:end.toISOString(),effectiveExpiresAt:short.toISOString()})];await sync(token);assert.equal(await prisma.billingCosmeticGrant.count(),0);
 const event={id:'coverage-refund',type:'CANCELLATION',cancel_reason:'CUSTOMER_SUPPORT',app_user_id:state.identity.appUserId,app_id:'app_ios',store:'APP_STORE',environment:'PRODUCTION',product_id:'bara_plus_monthly_v1',transaction_id:'store-paid-1',event_timestamp_ms:Date.now()};await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:{event},headers:{Authorization:config.webhookAuthorization}});await sync(token);
 history.purchases[0].effectiveExpiresAt=end.toISOString();await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:{event:{...event,id:'coverage-reversed',type:'REFUND_REVERSED',event_timestamp_ms:Date.now()+1}},headers:{Authorization:config.webhookAuthorization}});await sync(token);assert.equal(await prisma.billingCosmeticGrant.count(),1);
});
it('keeps verified billing grace active without issuing renewal gifts',async()=>{
 const {token}=await createTestUser();await bootstrap(token);const expiry=new Date(Date.now()-1000).toISOString();history.subscriptions=[subscription({status:'in_grace_period',accessUntil:expiry})];history.purchases=[purchase({productId:'plus_monthly',subscriptionId:'sub1',purchasedAt:new Date(Date.now()-30*86400000).toISOString(),expiresAt:expiry})];
 const result=await sync(token);assert.equal(result.body.membership.status,'active');assert.equal(result.body.membership.givesAccess,true);assert.equal(result.body.coins,500);assert.equal(result.body.credits.paid,10);assert.equal((await sync(token)).body.coins,500);
});
it('recovers a provider refund after an ordinary unrefunded export watermark',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token);history.purchases=[purchase()];await sync(token);
 const event={id:'ordinary-negative-export',type:'REFUND_REVERSED',app_user_id:state.identity.appUserId,app_id:'app_ios',store:'APP_STORE',environment:'PRODUCTION',product_id:'bara_coins_500_v1',transaction_id:'store-paid-1',event_timestamp_ms:Date.now()};await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:{source:'revenuecat_transactions_export',event},headers:{Authorization:config.webhookAuthorization}});await sync(token);
 await new Promise(resolve=>setTimeout(resolve,2));history.observedAt=new Date().toISOString();history.purchases[0].refunded=true;const result=await sync(token);assert.equal(result.body.coins,0);assert.equal((await prisma.billingPurchase.findFirst()).refundCount,1);
});
it('rejects an original transaction restored into another account even after deletion',async()=>{
 const a=await createTestUser();await bootstrap(a.token);history.purchases=[purchase()];await sync(a.token);await request(server.baseUrl,'DELETE','/auth/account',{token:a.token});
 const b=await createTestUser();await bootstrap(b.token);const result=await sync(b.token,'store-paid-1');assert.equal(result.status,409);assert.equal(result.body.code,'PURCHASE_ACCOUNT_MISMATCH');assert.equal((await bootstrap(b.token)).coins,0);
});
it('rechecks realm after provider I/O and refuses stale production verification following sandbox provisioning',async()=>{
 const {user,token}=await createTestUser();await bootstrap(token);history.purchases=[purchase()];let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});const alternate=await startServer({billingConfig:config,billingProvider:{async getCustomerHistory(){entered();await held;return history;}}});
 try{const pending=request(alternate.baseUrl,'POST','/billing/sync',{token,body:{transactionId:'store-paid-1'}});await started;await cli('billing-provision-sandbox.js',[`--user-id=${user.id}`,'--apply']);release();const res=await pending;assert.equal(res.status,409);assert.equal((await res.json()).code,'BILLING_REALM_MISMATCH');assert.equal((await bootstrap(token)).coins,0);}finally{release();await alternate.close();}
});
it('fences a replaced database lease before any wallet grant',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token);history.purchases=[purchase()];let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});const alternate=await startServer({billingConfig:config,billingProvider:{async getCustomerHistory(){entered();await held;return history;}}});
 try{const pending=request(alternate.baseUrl,'POST','/billing/sync',{token,body:{transactionId:'store-paid-1'}});await started;const replacement=randomUUID();await prisma.billingReconciliation.update({where:{identityId:state.identity.appUserId},data:{leaseToken:replacement,leaseUntil:new Date(Date.now()+60000)}});release();const res=await pending;assert.equal(res.status,503);assert.equal((await bootstrap(token)).coins,0);assert.equal((await prisma.billingReconciliation.findUnique({where:{identityId:state.identity.appUserId}})).leaseToken,replacement);}finally{release();await alternate.close();}
});
it('preserves a webhook wakeup enqueued while a reconciliation lease is active',async()=>{
 const {token}=await createTestUser();const state=await bootstrap(token);let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});const alternate=await startServer({billingConfig:config,billingProvider:{async getCustomerHistory(){entered();await held;return history;}}});
 try{const pending=request(alternate.baseUrl,'POST','/billing/sync',{token,body:{}});await started;await request(server.baseUrl,'POST','/billing/webhook/revenuecat',{body:{event:{id:'during-lease',type:'TEST',app_user_id:state.identity.appUserId}},headers:{Authorization:config.webhookAuthorization}});release();assert.equal((await pending).status,200);const job=await prisma.billingReconciliation.findUnique({where:{identityId:state.identity.appUserId}});assert.ok(job.nextAttemptAt.getTime()<=Date.now()+1000);assert.equal(job.leaseToken,null);}finally{release();await alternate.close();}
});
it('fulfills verified sandbox purchases only inside the sandbox account realm',async()=>{
 const {token}=await createTestUser({billingRealm:'sandbox'});assert.equal((await bootstrap(token)).identity.environment,'sandbox');history.purchases=[purchase({environment:'sandbox'})];const result=await sync(token,'store-paid-1');assert.equal(result.status,200);assert.equal(result.body.coins,500);
});
it('settles an initial zero-price trial first recovered after expiry without reviving benefits',async()=>{
 const {token}=await createTestUser();await bootstrap(token);
 const start=new Date(Date.now()-8*86400000).toISOString(),end=new Date(Date.now()-86400000).toISOString();
 history.subscriptions=[subscription({startsAt:start,periodStartsAt:start,accessUntil:end,status:'expired',givesAccess:false})];
 history.purchases=[purchase({transactionId:'expired-trial',productId:'plus_monthly',paid:false,subscriptionId:'sub1',purchasedAt:start,expiresAt:end})];
 const result=await sync(token,'expired-trial');assert.equal(result.status,200);assert.equal(result.body.status,'complete');assert.equal(result.body.coins,0);assert.deepEqual(result.body.credits,{paid:0,trial:0,trialExpiresAt:null});assert.equal(result.body.membership.givesAccess,false);
 assert.equal(await prisma.coinTransaction.count(),0);assert.equal(await prisma.billingCosmeticGrant.count(),0);
});
it('keeps a pending initial zero-price payment unresolved even when its proposed interval is past',async()=>{
 const {token}=await createTestUser();await bootstrap(token);
 const start=new Date(Date.now()-8*86400000).toISOString(),end=new Date(Date.now()-86400000).toISOString();
 history.subscriptions=[subscription({startsAt:start,periodStartsAt:start,accessUntil:end,status:'incomplete',givesAccess:false})];
 history.purchases=[purchase({transactionId:'unpaid-pending',productId:'plus_monthly',paid:false,subscriptionId:'sub1',purchasedAt:start,expiresAt:end})];
 const result=await sync(token,'unpaid-pending');assert.equal(result.status,202);assert.equal(result.body.coins,0);assert.equal(result.body.credits.trial,0);
});
for (const androidAppId of [config.androidAppId, '']) {
it(`recovers checkout without a client sync or webhook through the real reconciliation CLI${androidAppId ? '' : ' with iOS-only configuration'}`,async()=>{
 const {mkdtemp,writeFile,rm}=require('node:fs/promises'),path=require('node:path');const dir=await mkdtemp(path.join(require('node:os').tmpdir(),'bara-worker-'));
 try{
  const {token}=await createTestUser();const state=await bootstrap(token),identity=state.identity.appUserId;
  const preload=path.join(dir,'provider-fixture.cjs');
  // Replace only external RevenueCat transport in the child process. The real
  // CLI, provider adapter, database lease and financial handler all execute.
  await writeFile(preload,`globalThis.fetch=async(url,options)=>{const path=new URL(url).pathname;let body;if(path.endsWith('/products/coin'))body={id:'coin',app_id:'app_ios',store_identifier:'bara_coins_500_v1'};else if(path.endsWith('/subscriptions'))body={items:[],next_page:null};else if(path.endsWith('/purchases'))body={items:[{id:'p',customer_id:${JSON.stringify(identity)},original_customer_id:${JSON.stringify(identity)},ownership:'purchased',product_id:'coin',store:'app_store',environment:'production',purchased_at:${Date.now()},quantity:1,status:'owned',store_purchase_identifier:'recovered-without-client',revenue_in_usd:{gross:0.99}}],next_page:null};else throw new Error('Unexpected provider URL');return new Response(JSON.stringify(body));};`);
  const {execFile}=require('node:child_process'),{promisify}=require('node:util');
  const run=()=>promisify(execFile)(process.execPath,['--require',preload,'scripts/billing-reconcile.js',`--identity-id=${identity}`],{cwd:path.resolve(__dirname,'../../..'),env:{...process.env,REVENUECAT_PROJECT_ID:config.projectId,REVENUECAT_IOS_APP_ID:config.iosAppId,REVENUECAT_ANDROID_APP_ID:androidAppId,REVENUECAT_SECRET_API_KEY:config.secretApiKey,REVENUECAT_WEBHOOK_AUTHORIZATION:config.webhookAuthorization,BILLING_TERMS_URL:config.termsUrl,BILLING_PRIVACY_URL:config.privacyUrl},timeout:20000});
  const output=await run();assert.match(output.stdout,/"processed":1/);assert.equal((await bootstrap(token)).coins,500);
  await run();assert.equal((await bootstrap(token)).coins,500);assert.equal(await prisma.coinTransaction.count({where:{reason:'billing_purchase'}}),1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
}
it('acknowledges a past zero-price initial period after conversion while granting only the paid renewal',async()=>{
 const {token}=await createTestUser();await bootstrap(token);
 const start=new Date(Date.now()-8*86400000).toISOString(),conversion=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+29*86400000).toISOString();
 history.subscriptions=[subscription({startsAt:start,periodStartsAt:conversion,accessUntil:end,status:'active'})];
 history.purchases=[purchase({transactionId:'past-free-period',productId:'plus_monthly',paid:false,subscriptionId:'sub1',purchasedAt:start,expiresAt:conversion}),purchase({transactionId:'converted-charge',productId:'plus_monthly',subscriptionId:'sub1',purchasedAt:conversion,expiresAt:end})];
 const result=await sync(token,'past-free-period');assert.equal(result.status,200);assert.equal(result.body.coins,500);assert.equal(result.body.credits.paid,10);assert.equal(result.body.credits.trial,0);
 assert.equal(await prisma.billingCreditLot.count({where:{kind:'trial'}}),0);assert.equal(await prisma.coinTransaction.count({where:{reason:'billing_purchase'}}),1);
});
