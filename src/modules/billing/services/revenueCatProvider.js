const { AppError } = require('../../../shared/errors/AppError');
const { PRODUCTS } = require('../catalog');
const ORIGIN='https://api.revenuecat.com';
const fail=(message='Billing provider unavailable')=>new AppError(message,'BILLING_UNAVAILABLE',503);
const date=(n)=>{if(typeof n!=='number'||!Number.isFinite(n)) throw fail('Invalid provider timestamp'); const d=new Date(n); if(!Number.isFinite(d.getTime()))throw fail('Invalid provider timestamp'); return d.toISOString();};
// API v2 schemas: /docs/api-v2/customer/resources, /subscription, /product.
// Full history is required: a latest-entitlement snapshot cannot fulfill renewals.
function createRevenueCatProvider({config,fetch:fetchFn=globalThis.fetch}) {
 const prefix=`/v2/projects/${encodeURIComponent(config.projectId)}/`;
 async function get(path) {
  const url=new URL(path,ORIGIN);
  if(url.origin!==ORIGIN||!url.pathname.startsWith(prefix)||url.username||url.password)throw fail('Invalid provider pagination URL');
  let response;try{response=await fetchFn(url.href,{headers:{Authorization:`Bearer ${config.secretApiKey}`,Accept:'application/json'},signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw fail();}
  if(!response.ok)throw fail();
  try{return await response.json();}catch{throw fail('Invalid provider response');}
 }
 async function list(path) {
  const rows=[],seen=new Set();
  while(path){if(seen.has(path))throw fail('Provider pagination cycle');seen.add(path);const data=await get(path);if(!Array.isArray(data.items))throw fail('Invalid provider list');rows.push(...data.items);if(data.next_page!==null&&data.next_page!==undefined&&typeof data.next_page!=='string')throw fail('Invalid provider pagination');path=data.next_page;}
  return rows;
 }
 return {async getCustomerHistory(identity){
  const observedAt=new Date().toISOString();
  const customer=`${prefix}customers/${encodeURIComponent(identity.id)}`;
  // Fetch every page: one provider identity can retain both TestFlight and
  // live purchases. Validate ownership and realm before selecting local benefits.
  const [rawPurchases,rawSubscriptions]=await Promise.all([list(`${customer}/purchases?limit=100`),list(`${customer}/subscriptions?limit=100`)]);
  const productCache=new Map();
  async function resolve(productId,store,storeIdentifier) {
   if(!productCache.has(productId))productCache.set(productId,get(`${prefix}products/${encodeURIComponent(productId)}`));
   const product=await productCache.get(productId),platform=store==='app_store'?'ios':store==='play_store'?'android':null;
   if(!platform||product.app_id!==config[`${platform}AppId`])throw fail('Unrecognized billing app/store');
   const mapped=PRODUCTS.find(p=>p[platform]===(storeIdentifier||product.store_identifier));
   if(!mapped)throw fail('Unrecognized billing product');
   return {mapped,appId:product.app_id};
  }
  function ownership(row) {
   if(row.customer_id!==identity.id||row.original_customer_id!==identity.id||row.ownership!=='purchased')throw new AppError('Purchase belongs to its original Bara account','PURCHASE_ACCOUNT_MISMATCH',409);
   if(!['production','sandbox'].includes(row.environment)||!['production','sandbox'].includes(identity.environment))throw new AppError('Purchase environment does not match this account','BILLING_REALM_MISMATCH',409);
   return row.environment===identity.environment;
  }
  const purchases=[],subscriptions=[];
  for(const row of rawPurchases){if(!ownership(row))continue;const {mapped,appId}=await resolve(row.product_id,row.store);
   if(!['coins','non_consumable'].includes(mapped.kind))throw fail('Unexpected non-subscription product');
   if(typeof row.status!=='string'||!row.status)throw fail('Missing purchase status');
   if(mapped.kind==='non_consumable'&&row.quantity!==1)throw fail('Invalid non-consumable quantity');
   if(mapped.kind==='non_consumable'&&(typeof row.revenue_in_usd?.gross!=='number'||!Number.isFinite(row.revenue_in_usd.gross)||row.revenue_in_usd.gross<0))throw fail('Invalid non-consumable payment revenue');
   const quantity=row.quantity??1;if(!Number.isSafeInteger(quantity)||quantity<1||!Number.isSafeInteger(mapped.coins*quantity))throw fail('Invalid purchase quantity');
   const transactionId=String(row.store_purchase_identifier??'');if(!transactionId)throw fail('Missing transaction identifier');
   purchases.push({transactionId,providerId:row.id,productId:mapped.id,appId,store:row.store,environment:row.environment,purchasedAt:date(row.purchased_at),expiresAt:null,quantity,paid:Number(row.revenue_in_usd?.gross)>0&&['owned','refunded'].includes(row.status),purchaseStatus:row.status,refunded:row.status==='refunded',subscriptionId:null});
  }
  for(const row of rawSubscriptions){if(!ownership(row))continue;const {mapped,appId}=await resolve(row.product_id,row.store);if(mapped.kind!=='subscription')throw fail('Unexpected subscription product');
   const transactions=await list(`${prefix}subscriptions/${encodeURIComponent(row.id)}/transactions?limit=100`);
   for(const transaction of transactions){const product=await resolve(row.product_id,row.store,transaction.product_store_identifier);
    if(product.mapped.kind!=='subscription'||!transaction.id)throw fail('Invalid subscription transaction');
    purchases.push({transactionId:String(transaction.id),providerId:String(transaction.id),productId:product.mapped.id,appId,store:row.store,environment:row.environment,purchasedAt:date(transaction.purchased_at),expiresAt:date(transaction.expiration_date),effectiveExpiresAt:transaction.effective_expiration_date==null?date(transaction.expiration_date):date(transaction.effective_expiration_date),quantity:1,paid:Number(transaction.revenue_in_usd?.gross)>0,refunded:false,subscriptionId:row.id});
   }
   subscriptions.push({providerId:row.id,productId:mapped.id,appId,store:row.store,environment:row.environment,startsAt:date(row.starts_at),periodStartsAt:row.current_period_starts_at==null?null:date(row.current_period_starts_at),accessUntil:row.current_period_ends_at==null?null:date(row.current_period_ends_at),givesAccess:row.gives_access===true,status:row.status,trial:row.status==='trialing',renews:['will_renew','will_change_product','has_already_renewed'].includes(row.auto_renewal_status),managementUrl:row.management_url||null});
  }
  return {purchases,subscriptions,observedAt};
 }};
}
module.exports={createRevenueCatProvider};
