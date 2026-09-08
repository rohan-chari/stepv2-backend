const { it } = require('node:test');
const assert = require('node:assert/strict');
const { createRevenueCatProvider } = require('../../../src/modules/billing/services/revenueCatProvider');
const config={projectId:'proj',secretApiKey:'secret',iosAppId:'app_ios',androidAppId:'app_android'};
it('reads every page and resolves provider product/app without forwarding credentials to foreign next_page',async()=>{
 const visited=[];
 const fetch=async(url,options)=>{visited.push(url);assert.equal(options.headers.Authorization,'Bearer secret');const path=new URL(url).pathname+new URL(url).search;let body;
 if(path.includes('/products/prod')) body={id:'prod',app_id:'app_ios',store_identifier:'bara_coins_500_v1',type:'one_time'};
 else if(path.includes('/subscriptions')) body={items:[],next_page:null};
 else if(path.includes('starting_after')) body={items:[{id:'p2',customer_id:'identity',original_customer_id:'identity',product_id:'prod',purchased_at:1000,quantity:1,status:'owned',store:'app_store',environment:'production',store_purchase_identifier:'store2',ownership:'purchased',revenue_in_usd:{gross:0.99}}],next_page:null};
 else body={items:[{id:'p1',customer_id:'identity',original_customer_id:'identity',product_id:'prod',purchased_at:1000,quantity:1,status:'owned',store:'app_store',environment:'production',store_purchase_identifier:'store1',ownership:'purchased',revenue_in_usd:{gross:0.99}}],next_page:'/v2/projects/proj/customers/identity/purchases?starting_after=p1'};
 return new Response(JSON.stringify(body));};
 const history=await createRevenueCatProvider({config,fetch}).getCustomerHistory({id:'identity',environment:'production'});
 assert.equal(history.purchases.length,2); assert.equal(history.purchases[1].transactionId,'store2');assert.equal(history.purchases[1].productId,'coins_500');
 assert.equal(visited.filter(p=>p.includes('/products/')).length,1);
 const hostile=createRevenueCatProvider({config,fetch:async()=>new Response(JSON.stringify({items:[],next_page:'https://attacker.invalid/steal'}))});
 await assert.rejects(hostile.getCustomerHistory({id:'identity',environment:'production'}),/pagination/i);
});
it('does not reinterpret a provider error as empty purchase history',async()=>{
 const provider=createRevenueCatProvider({config,fetch:async()=>new Response('{}',{status:503})});
 await assert.rejects(provider.getCustomerHistory({id:'identity',environment:'production'}),/unavailable/i);
});
it('reconciles coin history beside an indefinitely paused subscription with nullable current period',async()=>{
 const fetch=async url=>{const path=new URL(url).pathname;let body;
 if(path.endsWith('/products/coin'))body={id:'coin',app_id:'app_android',store_identifier:'bara_coins_500_v1'};
 else if(path.endsWith('/products/sub'))body={id:'sub',app_id:'app_android',store_identifier:'bara_plus_v1:monthly'};
 else if(path.endsWith('/transactions'))body={items:[],next_page:null};
 else if(path.endsWith('/subscriptions'))body={items:[{id:'paused',customer_id:'identity',original_customer_id:'identity',product_id:'sub',starts_at:1000,current_period_starts_at:null,current_period_ends_at:null,gives_access:false,status:'paused',ownership:'purchased',store:'play_store',environment:'production'}],next_page:null};
 else body={items:[{id:'p',customer_id:'identity',original_customer_id:'identity',product_id:'coin',purchased_at:1000,quantity:1,status:'owned',store:'play_store',environment:'production',store_purchase_identifier:'GPA.coin',ownership:'purchased',revenue_in_usd:{gross:0.99}}],next_page:null};
 return new Response(JSON.stringify(body));};
 const result=await createRevenueCatProvider({config,fetch}).getCustomerHistory({id:'identity',environment:'production'});
 assert.equal(result.purchases.length,1);assert.equal(result.subscriptions[0].accessUntil,null);assert.equal(result.subscriptions[0].givesAccess,false);
});
it('retains paginated trial and paid renewal transactions, effective expiry and deferred renewal state',async()=>{
 // Fields follow https://www.revenuecat.com/docs/api-v2/subscription and
 // https://www.revenuecat.com/docs/api-v2/subscription-data-model.
 const start=Date.parse('2026-01-01T00:00:00Z'),week=7*86400000,month=31*86400000;
 const visited=[];
 const fetch=async url=>{visited.push(url);const parsed=new URL(url),path=parsed.pathname;let body;
 if(path.endsWith('/products/sub'))body={object:'product',id:'sub',app_id:'app_android',store_identifier:'bara_plus_v1:monthly',type:'subscription'};
 else if(path.endsWith('/purchases'))body={object:'list',items:[],next_page:null};
 else if(path.endsWith('/subscriptions'))body={object:'list',items:[{object:'subscription',id:'subscription',customer_id:'identity',original_customer_id:'identity',product_id:'sub',starts_at:start,current_period_starts_at:start+week,current_period_ends_at:start+week+month,gives_access:true,pending_payment:false,status:'active',auto_renewal_status:'will_change_product',pending_changes:{product:{store_identifier:'bara_plus_v1:annual'}},ownership:'purchased',store:'play_store',environment:'production'}],next_page:null};
 else if(parsed.searchParams.has('starting_after'))body={object:'list',items:[{object:'subscription_transaction',id:'GPA.renewal..0',product_store_identifier:'bara_plus_v1:monthly',purchased_at:start+week,expiration_date:start+week+month,effective_expiration_date:start+week+86400000,revenue_in_usd:{currency:'USD',gross:4.99}}],next_page:null};
 else body={object:'list',items:[{object:'subscription_transaction',id:'GPA.trial',product_store_identifier:'bara_plus_v1:monthly',purchased_at:start,expiration_date:start+week,effective_expiration_date:start+week,revenue_in_usd:{currency:'USD',gross:0}}],next_page:'/v2/projects/proj/subscriptions/subscription/transactions?starting_after=GPA.trial'};
 return new Response(JSON.stringify(body));};
 const history=await createRevenueCatProvider({config,fetch}).getCustomerHistory({id:'identity',environment:'production'});
 assert.deepEqual(history.purchases.map(p=>[p.transactionId,p.productId,p.paid]),[['GPA.trial','plus_monthly',false],['GPA.renewal..0','plus_monthly',true]]);
 assert.equal(history.purchases[1].effectiveExpiresAt,new Date(start+week+86400000).toISOString());
 assert.equal(history.purchases[1].expiresAt,new Date(start+week+month).toISOString());
 assert.equal(history.subscriptions[0].productId,'plus_monthly');assert.equal(history.subscriptions[0].renews,true);
 assert.equal(visited.filter(url=>url.includes('/transactions?')).length,2);
});
it('verifies permanent ownership with strict state, quantity and finite numeric payment evidence',async()=>{
 const row={id:'purchase',customer_id:'identity',original_customer_id:'identity',product_id:'perm',purchased_at:1000,quantity:1,status:'owned',store:'app_store',environment:'production',store_purchase_identifier:'permanent-store',ownership:'purchased',revenue_in_usd:{gross:19.99}};
 const provider=()=>createRevenueCatProvider({config,fetch:async url=>new Response(JSON.stringify(new URL(url).pathname.endsWith('/products/perm')?{id:'perm',app_id:'app_ios',store_identifier:'bara_plus_permanent_v1'}:new URL(url).pathname.endsWith('/subscriptions')?{items:[],next_page:null}:{items:[row],next_page:null}))});
 let history=await provider().getCustomerHistory({id:'identity',environment:'production'});assert.equal(history.purchases[0].productId,'plus_permanent');assert.equal(history.purchases[0].paid,true);
 for(const gross of [null,undefined,'19.99',Infinity,-1]){row.revenue_in_usd={gross};await assert.rejects(provider().getCustomerHistory({id:'identity',environment:'production'}),/payment|revenue/i);}
 row.revenue_in_usd={gross:19.99};row.status='pending';history=await provider().getCustomerHistory({id:'identity',environment:'production'});assert.equal(history.purchases[0].paid,false);
 row.status=null;await assert.rejects(provider().getCustomerHistory({id:'identity',environment:'production'}),/status/i);
 row.status='owned';row.quantity=2;await assert.rejects(provider().getCustomerHistory({id:'identity',environment:'production'}),/quantity/i);
});
