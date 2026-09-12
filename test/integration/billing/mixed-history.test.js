const assert = require('node:assert/strict');
const { before, after, beforeEach, it } = require('node:test');
const { startServer, cleanDatabase, createTestUser, request, prisma } = require('../setup');
const config = { projectId:'mixed-test', secretApiKey:'test-only', webhookAuthorization:'Bearer test-only', iosAppId:'ios-test', androidAppId:'android-test', termsUrl:'https://example.com/terms', privacyUrl:'https://example.com/privacy' };
const realFetch = globalThis.fetch;
let server, identity, rows, subscriptions, visited, platform;
before(async () => {
  // Only the external provider boundary is stubbed. HTTP routes, provider
  // parsing, reconciliation, receipts and wallet writes are real.
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.revenuecat.com') return realFetch(url, options);
    visited.push(parsed.pathname);
    let body;
    if (parsed.pathname.endsWith('/purchases')) {
      const page = Number(parsed.searchParams.get('page') || 0);
      body = {items:rows.slice(page, page + 1), next_page:page + 1 < rows.length ? `${parsed.pathname}?page=${page + 1}` : null};
    } else if (parsed.pathname.endsWith('/subscriptions')) body = {items:subscriptions, next_page:null};
    else if (parsed.pathname.endsWith('/products/coin')) body = {id:'coin', app_id:config[`${platform}AppId`], store_identifier:'bara_coins_2800_v1'};
    else throw new Error(`Unexpected provider request: ${parsed.pathname}`);
    return new Response(JSON.stringify(body));
  };
  server = await startServer({billingConfig:config});
});
after(async () => { await server?.close(); globalThis.fetch = realFetch; });
beforeEach(async () => { await cleanDatabase(); rows=[]; subscriptions=[]; visited=[]; platform='ios'; });
async function fixture(environment='production') {
  const owner=await createTestUser({billingRealm:environment,coins:100});
  const response=await request(server.baseUrl,'GET',`/billing/bootstrap?platform=${platform}`,{token:owner.token});
  assert.equal(response.status,200); identity=(await response.json()).identity.appUserId;
  return owner;
}
function purchase(id, environment='production', extra={}) {
  return {id, customer_id:identity, original_customer_id:identity, ownership:'purchased', environment, store:platform==='ios'?'app_store':'play_store', product_id:'coin', store_purchase_identifier:id, purchased_at:Date.now()-60000, quantity:1, status:'owned', revenue_in_usd:{gross:4.99}, ...extra};
}
async function sync(owner, body={}) { return request(server.baseUrl,'POST',`/billing/sync?platform=${platform}`,{token:owner.token,body}); }
for (const store of ['ios','android']) for (const realm of ['production','sandbox']) {
  it(`${store} ${realm} grants only its own realm across pages and replays without double credit`,async () => {
    platform=store; const owner=await fixture(realm); const other=realm==='production'?'sandbox':'production';
    rows=[purchase('other',other,{product_id:'obsolete-other-product'}),purchase('paid-1',realm),purchase('paid-2',realm)];
    subscriptions=[purchase('other-subscription',other,{product_id:'obsolete-other-subscription'})];
    for(let i=0;i<2;i++) { const response=await sync(owner,{transactionId:'paid-2'}); assert.equal(response.status,200,JSON.stringify(await response.clone().json())); assert.equal((await response.json()).coins,6100); }
    assert.equal(await prisma.billingPurchase.count({where:{identityId:identity}}),2);
    assert.equal(await prisma.coinTransaction.count({where:{userId:owner.user.id,reason:'billing_purchase'}}),2);
    assert.equal(await prisma.billingSubscription.count(),0);
    assert.ok(!visited.some(path=>path.includes('obsolete')||path.endsWith('/transactions')));
    rows[2].status='refunded';
    const refund=await sync(owner);assert.equal(refund.status,200);assert.equal((await refund.json()).coins,3100);
    const replay=await sync(owner);assert.equal(replay.status,200);assert.equal((await replay.json()).coins,3100);
  });
}
it('keeps an opposite-realm-only transaction hint pending without granting',async()=>{
  const owner=await fixture();rows=[purchase('test-only','sandbox')];
  const response=await sync(owner,{transactionId:'test-only'});assert.equal(response.status,202);assert.equal((await response.json()).coins,100);
  assert.equal(await prisma.billingPurchase.count(),0);assert.equal(await prisma.coinTransaction.count(),0);
});
for(const source of ['purchase','subscription']) for(const invalid of ['missing-environment','unknown-environment','foreign-owner']) {
  it(`rejects ${source} ${invalid} without granting valid adjacent purchases`,async()=>{
    const owner=await fixture();const bad=purchase('bad','sandbox');
    if(invalid==='missing-environment')delete bad.environment;
    if(invalid==='unknown-environment')bad.environment='unexpected';
    if(invalid==='foreign-owner')bad.original_customer_id='someone-else';
    rows=[purchase('valid')];if(source==='purchase')rows.push(bad);else subscriptions=[bad];
    const response=await sync(owner);assert.equal(response.status,409);assert.equal((await response.json()).code,invalid==='foreign-owner'?'PURCHASE_ACCOUNT_MISMATCH':'BILLING_REALM_MISMATCH');
    assert.equal(await prisma.billingPurchase.count(),0);assert.equal(await prisma.coinTransaction.count(),0);
  });
}
