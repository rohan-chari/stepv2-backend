const {randomUUID}=require('node:crypto');
const {AppError}=require('../../../shared/errors/AppError');
const {awardCoins}=require('../../../shared/economy/awardCoins');
const {deductCoinsAtomic}=require('../../../shared/economy/deductCoinsAtomic');
const {PRODUCTS}=require('../catalog');
const error=(message,code='BILLING_UNAVAILABLE',status=503)=>new AppError(message,code,status);
const keyFor=(config,p)=>JSON.stringify([config.projectId,p.appId,p.store,p.environment,p.transactionId]);
const instant=(v)=>{const d=new Date(v);if(v==null||!Number.isFinite(d.getTime()))throw error('Invalid verified billing date');return d;};
function validatePurchase(config,identity,p){
 const product=PRODUCTS.find(item=>item.id===p.productId),app=p.store==='app_store'?config.iosAppId:p.store==='play_store'?config.androidAppId:null;
 if(!product||!app||p.appId!==app||typeof p.transactionId!=='string'||!p.transactionId||p.transactionId.length>256||!Number.isSafeInteger(p.quantity)||p.quantity<1||!Number.isSafeInteger(product.coins*p.quantity)||['subscription','non_consumable'].includes(product.kind)&&p.quantity!==1)throw error('Unrecognized verified purchase');
 if(p.environment!==identity.environment)throw error('Purchase environment does not match this account','BILLING_REALM_MISMATCH',409);
 if(product.kind==='non_consumable'&&(typeof p.purchaseStatus!=='string'||!p.purchaseStatus))throw error('Missing verified non-consumable state');
 instant(p.purchasedAt);if(p.expiresAt)instant(p.expiresAt);return product;
}
function refundSignal(config,identity,inbox){
 const e=inbox.payload?.event;if(!e||e.app_user_id!==identity.id)return null;
 const refunded=e.type==='CANCELLATION'&&e.cancel_reason==='CUSTOMER_SUPPORT';const reversed=e.type==='REFUND_REVERSED';
 if(!refunded&&!reversed)return null;
 const store=e.store==='APP_STORE'?'app_store':e.store==='PLAY_STORE'?'play_store':null;
 const environment=String(e.environment||'').toLowerCase(),appId=e.app_id;
 const platform=store==='app_store'?'ios':store==='play_store'?'android':null;
 if(!platform||appId!==config[`${platform}AppId`]||environment!==identity.environment||!PRODUCTS.some(p=>p[platform]===e.product_id||(inbox.payload.source==='revenuecat_transactions_export'&&platform==='android'&&p[platform].split(':')[0]===e.product_id))||typeof e.transaction_id!=='string'||!Number.isFinite(e.event_timestamp_ms))return null;
 return {key:keyFor(config,{appId,store,environment,transactionId:e.transaction_id}),refunded,observedAt:new Date(e.event_timestamp_ms),at:new Date(Number.isFinite(e.refunded_at_ms)?e.refunded_at_ms:e.event_timestamp_ms),source:inbox.id,storeProductId:e.product_id,exported:inbox.payload.source==='revenuecat_transactions_export'};
}
async function claimLease(db,identityId){
 const token=randomUUID();
 const rows=await db.$queryRawUnsafe("UPDATE billing_reconciliation SET lease_token=$2, lease_until=NOW()+INTERVAL '60 seconds', lease_version=requested_version, attempts=attempts+1, updated_at=NOW() WHERE identity_id=$1 AND (lease_until IS NULL OR lease_until<=NOW()) RETURNING identity_id",identityId,token);
 return rows.length?token:null;
}
async function refreshLease(db,identityId,token){return db.billingReconciliation.updateMany({where:{identityId,leaseToken:token},data:{leaseUntil:new Date(Date.now()+60000)}});}
async function releaseLease(db,identityId,token,{failed=false,message=null}={}){
 // Enqueues racing provider I/O or the commit must survive the lease release.
 // The UPDATE locks/rechecks the latest row, including its request generation.
 await db.$executeRawUnsafe(`UPDATE billing_reconciliation SET
  lease_token=NULL, lease_until=NULL, lease_version=NULL,
  next_attempt_at=CASE WHEN requested_version>COALESCE(lease_version,-1) THEN NOW()
   WHEN $3 THEN NOW()+INTERVAL '60 seconds'
   ELSE LEAST(NOW()+INTERVAL '6 hours', COALESCE((SELECT MIN(ps.next_due_at) FROM billing_permanent_schedules ps WHERE ps.identity_id=$1 AND EXISTS (SELECT 1 FROM billing_permanent_sources src WHERE src.identity_id=$1 AND src.revoked_at IS NULL)),NOW()+INTERVAL '6 hours'), COALESCE((SELECT MIN(CASE WHEN s.access_until>NOW() THEN s.access_until ELSE NOW()+INTERVAL '5 minutes' END) FROM billing_subscriptions s WHERE s.identity_id=$1 AND s.gives_access),NOW()+INTERVAL '6 hours')) END,
  last_error=$4, attempts=CASE WHEN $3 THEN attempts ELSE 0 END, updated_at=NOW()
 WHERE identity_id=$1 AND lease_token=$2`,identityId,token,failed,message);
}
function signalMatchesReceipt(receipt,signal){
 if(!signal.storeProductId)return true;
 const product=PRODUCTS.find(p=>p.id===receipt.productId),platform=receipt.store==='app_store'?'ios':'android';
 return product&&(product[platform]===signal.storeProductId||(signal.exported&&platform==='android'&&product[platform].split(':')[0]===signal.storeProductId));
}
async function reversePurchase(tx,identity,receipt,signal){
 if(!signalMatchesReceipt(receipt,signal))throw error('Refund product does not match verified transaction');
 if(receipt.refundObservedAt&&receipt.refundObservedAt>=signal.observedAt)return receipt;
 if(signal.refunded){
  if(receipt.refundedAt)return tx.billingPurchase.update({where:{id:receipt.id},data:{refundObservedAt:signal.observedAt,refundSource:signal.source}});
  const user=await tx.user.findUnique({where:{id:identity.userId},select:{coins:true}});
  const recovered=Math.min(user?.coins||0,receipt.grantedCoins);
  if(recovered)await deductCoinsAtomic({tx,userId:identity.userId,amount:recovered,reason:'billing_refund',refId:signal.source});
  const lot=await tx.billingCreditLot.findUnique({where:{sourceKey:receipt.canonicalKey}}),revoked=lot?.remaining||0;
  if(revoked){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:0}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:signal.source,amount:-revoked}});}
  return tx.billingPurchase.update({where:{id:receipt.id},data:{refundedAt:signal.at,refundObservedAt:signal.observedAt,refundSource:signal.source,recoveredCoins:recovered,absorbedCoins:receipt.grantedCoins-recovered,revokedCredits:revoked,fulfillmentStatus:'reversed',refundCount:{increment:1}}});
 }
 if(!receipt.refundedAt)return tx.billingPurchase.update({where:{id:receipt.id},data:{refundObservedAt:signal.observedAt,refundSource:signal.source}});
 if(receipt.recoveredCoins)await awardCoins({tx,userId:identity.userId,amount:receipt.recoveredCoins,reason:'billing_refund_reversed',refId:signal.source});
 const lot=await tx.billingCreditLot.findUnique({where:{sourceKey:receipt.canonicalKey}});
 if(lot&&receipt.revokedCredits){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:{increment:receipt.revokedCredits}}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:signal.source,amount:receipt.revokedCredits}});}
 return tx.billingPurchase.update({where:{id:receipt.id},data:{refundedAt:null,refundObservedAt:signal.observedAt,refundSource:signal.source,fulfillmentStatus:receipt.grantedCoins||receipt.grantedCredits?'fulfilled':'pending'}});
}
async function grantCosmetics(tx,identity,now=new Date(),verifiedPermanentIds=[]){
 const receipts=await tx.billingPurchase.findMany({where:{identityId:identity.id,benefitKind:'paid',fulfillmentStatus:'fulfilled',refundedAt:null,subscriptionId:{not:null}}});
 const permanentSources=await tx.billingPermanentSource.findMany({where:{identityId:identity.id,revokedAt:null,purchaseId:{in:verifiedPermanentIds}}});
 const releases=await tx.billingCosmeticRelease.findMany({where:{month:{lte:now.toISOString().slice(0,7)}}});
 for(const release of releases){const [year,month]=release.month.split('-').map(Number),start=new Date(Date.UTC(year,month-1,1)),end=new Date(Date.UTC(year,month,1));
  if(!receipts.some(p=>p.purchasedAt<end&&(p.effectiveExpiresAt||p.expiresAt)>start)&&!permanentSources.some(p=>p.purchasedAt<end&&(!p.revokedAt||p.revokedAt>start)))continue;
  if(await tx.billingCosmeticGrant.findUnique({where:{identityId_month:{identityId:identity.id,month:release.month}}}))continue;
  const item=await tx.shopItem.findUnique({where:{id:release.shopItemId}});if(!item||!item.active||item.testOnly)continue;
  await tx.billingCosmeticGrant.create({data:{identityId:identity.id,month:release.month,shopItemId:item.id}});
  await tx.userShopItem.upsert({where:{userId_shopItemId:{userId:identity.userId,shopItemId:item.id}},create:{userId:identity.userId,shopItemId:item.id},update:{}});
 }
}
async function applyHistory({db,config,identity,token,history}){
 if(!Array.isArray(history.purchases)||!Array.isArray(history.subscriptions))throw error('Invalid verified billing history');
 for(const p of history.purchases)validatePurchase(config,identity,p);
 const observedAt=instant(history.observedAt);
 return db.$transaction(async tx=>{
  await tx.$queryRawUnsafe('SELECT identity_id FROM billing_reconciliation WHERE identity_id = $1 FOR UPDATE',identity.id);
  const lease=await tx.billingReconciliation.findUnique({where:{identityId:identity.id}});if(lease?.leaseToken!==token)throw error('Billing reconciliation lease expired');
  await tx.$queryRawUnsafe('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',identity.userId);
  await tx.$queryRawUnsafe('SELECT id FROM billing_identities WHERE id = $1 FOR UPDATE',identity.id);
  const current=await tx.billingIdentity.findUnique({where:{id:identity.id}}),user=await tx.user.findUnique({where:{id:identity.userId}});
  if(!current||current.deletedAt||!user)throw error('Billing account was deleted','PURCHASE_ACCOUNT_MISMATCH',409);
  if(current.environment!==identity.environment||(user.billingRealm||'production')!==current.environment)throw error('Account billing realm mismatch','BILLING_REALM_MISMATCH',409);
  const inbox=await tx.billingInbox.findMany({where:{identityId:identity.id,processedAt:null},orderBy:{createdAt:'asc'}});
  const signals=inbox.map(i=>refundSignal(config,identity,i)).filter(Boolean).sort((a,b)=>a.observedAt-b.observedAt);
  const latestSignals=new Map(signals.map(s=>[s.key,s]));
  for(const p of history.purchases){
   const product=validatePurchase(config,identity,p),canonicalKey=keyFor(config,p);
   let receipt=await tx.billingPurchase.findUnique({where:{canonicalKey}});
   if(receipt&&receipt.identityId!==identity.id)throw error('Purchase belongs to its original Bara account','PURCHASE_ACCOUNT_MISMATCH',409);
   const subscription=history.subscriptions.find(s=>s.providerId===p.subscriptionId);
   const isTrial=!p.paid&&subscription?.trial===true&&p.purchasedAt===subscription.startsAt;
   const signal=latestSignals.get(canonicalKey);
   if(!receipt){receipt=await tx.billingPurchase.create({data:{identityId:identity.id,canonicalKey,projectId:config.projectId,appId:p.appId,store:p.store,environment:p.environment,transactionId:p.transactionId,providerId:p.providerId||p.transactionId,productId:product.id,subscriptionId:p.subscriptionId||null,purchasedAt:instant(p.purchasedAt),expiresAt:p.expiresAt?instant(p.expiresAt):null,effectiveExpiresAt:p.effectiveExpiresAt?instant(p.effectiveExpiresAt):p.expiresAt?instant(p.expiresAt):null,quantity:p.quantity,benefitKind:product.kind==='non_consumable'&&p.paid===true&&['owned','refunded'].includes(p.purchaseStatus)?'permanent':isTrial?'trial':p.paid?'paid':'unpaid'}});}
   if(product.kind==='non_consumable'&&p.paid===true&&['owned','refunded'].includes(p.purchaseStatus)&&receipt.benefitKind!=='permanent')receipt=await tx.billingPurchase.update({where:{id:receipt.id},data:{benefitKind:'permanent'}});
   // Refund-before-fulfillment records provenance without temporarily minting.
   if(signal?.refunded&&signalMatchesReceipt(receipt,signal)&&receipt.fulfillmentStatus==='pending'&&!receipt.refundedAt)receipt=await reversePurchase(tx,identity,receipt,signal);
   if(p.refunded&&receipt.refundCount===0&&(!receipt.refundObservedAt||observedAt>receipt.refundObservedAt))receipt=await reversePurchase(tx,identity,receipt,{refunded:true,at:observedAt,observedAt,source:`provider:${canonicalKey}`});
   if(product.kind!=='non_consumable'&&receipt.fulfillmentStatus==='pending'&&!receipt.refundedAt&&(p.paid===true||isTrial)&&instant(p.purchasedAt)<=new Date()){
    const coins=p.paid?product.coins*p.quantity:0,creditAmount=p.paid?product.credits:3;
    if(coins)await awardCoins({tx,userId:identity.userId,amount:coins,reason:'billing_purchase',refId:canonicalKey});
    let issuedCredits=0;
    if(creditAmount){const sourceKey=isTrial?`trial:${identity.id}`:canonicalKey;const created=await tx.billingCreditLot.createMany({data:[{identityId:identity.id,sourceKey,kind:isTrial?'trial':'paid',granted:creditAmount,remaining:creditAmount,expiresAt:isTrial?instant(p.expiresAt):null}],skipDuplicates:true});issuedCredits=created.count?creditAmount:0;}
    receipt=await tx.billingPurchase.update({where:{id:receipt.id},data:{fulfillmentStatus:'fulfilled',benefitKind:isTrial?'trial':'paid',grantedCoins:coins,grantedCredits:issuedCredits}});
   }
   // A historical initial zero-price period may no longer be labelled a trial
   // by the provider. Acknowledge its terminal state without inventing trial
   // provenance or reviving expired benefits. Pending payment is not terminal.
   if(receipt.fulfillmentStatus==='pending'&&!receipt.refundedAt&&p.paid===false&&subscription&&p.purchasedAt===subscription.startsAt&&p.expiresAt&&instant(p.expiresAt)<=new Date()){
    const converted=history.purchases.some(later=>later.subscriptionId===p.subscriptionId&&later.paid===true&&instant(later.purchasedAt)>=instant(p.expiresAt)&&instant(later.purchasedAt)<=new Date());
    if(subscription.status==='expired'||converted)receipt=await tx.billingPurchase.update({where:{id:receipt.id},data:{fulfillmentStatus:'fulfilled',benefitKind:'unpaid'}});
   }
   if(p.effectiveExpiresAt&&(!receipt.effectiveExpiresAt||instant(p.effectiveExpiresAt)<receipt.effectiveExpiresAt))await tx.billingPurchase.update({where:{id:receipt.id},data:{effectiveExpiresAt:instant(p.effectiveExpiresAt)}});
  }
  for(const signal of signals){const receipt=await tx.billingPurchase.findUnique({where:{canonicalKey:signal.key}});if(receipt?.identityId===identity.id)await reversePurchase(tx,identity,receipt,signal);}
  // A confirmed refund reversal may restore a shortened coverage interval.
  for(const p of history.purchases){if(!p.effectiveExpiresAt)continue;const receipt=await tx.billingPurchase.findUnique({where:{canonicalKey:keyFor(config,p)}});
   if(receipt&&!receipt.refundedAt&&receipt.refundCount>0&&receipt.refundObservedAt&&(!receipt.effectiveExpiresAt||instant(p.effectiveExpiresAt)>receipt.effectiveExpiresAt))await tx.billingPurchase.update({where:{id:receipt.id},data:{effectiveExpiresAt:instant(p.effectiveExpiresAt)}});
  }
  for(const s of history.subscriptions){
   validatePurchase(config,identity,{...s,transactionId:s.providerId,quantity:1,purchasedAt:s.startsAt});
   const id=JSON.stringify([config.projectId,s.appId,s.store,s.environment,s.providerId]);
   const existing=await tx.billingSubscription.findUnique({where:{id}});
   if(existing&&existing.identityId!==identity.id)throw error('Subscription belongs to its original Bara account','PURCHASE_ACCOUNT_MISMATCH',409);
   const period=s.periodStartsAt?instant(s.periodStartsAt):null;
   if(existing&&(existing.observedAt>observedAt||period&&existing.periodStartsAt&&period<existing.periodStartsAt))continue;
   const data={identityId:identity.id,productId:s.productId,startsAt:instant(s.startsAt),periodStartsAt:period,accessUntil:s.accessUntil?instant(s.accessUntil):null,givesAccess:s.givesAccess===true,providerStatus:s.status||(s.trial?'trialing':'active'),trial:s.trial===true,renews:s.renews===true,observedAt,managementUrl:s.managementUrl||null};
   await tx.billingSubscription.upsert({where:{id},create:{id,...data},update:data});
   if(!s.trial){const lots=await tx.billingCreditLot.findMany({where:{identityId:identity.id,kind:'trial',remaining:{gt:0}}});for(const lot of lots){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:0}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:`trial-ended:${lot.id}`,amount:-lot.remaining}});}}
  }
  const permanent=await require('./permanentState').syncPermanent({tx,identity,history,observedAt});
  await grantCosmetics(tx,identity,new Date(),permanent.verifiedPurchaseIds);
  // Unknown refund transactions remain retryable until complete history sees them.
  for(const item of inbox){const signal=refundSignal(config,identity,item);if(signal&&!await tx.billingPurchase.findUnique({where:{canonicalKey:signal.key}}))continue;await tx.billingInbox.update({where:{id:item.id},data:{processedAt:new Date()}});}
  return {complete:!permanent.verificationDeferred,verificationDeferred:permanent.verificationDeferred};
 },{maxWait:10000,timeout:30000});
}
module.exports={claimLease,refreshLease,releaseLease,applyHistory,grantCosmetics,keyFor,reversePurchase};
