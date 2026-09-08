const {awardCoins}=require('../../../shared/economy/awardCoins');
const {deductCoinsAtomic}=require('../../../shared/economy/deductCoinsAtomic');
const VERSION=1,COINS=500,CREDITS=10,BATCH=12;
function boundaryAt(anchor,period){
 const a=new Date(anchor),month=a.getUTCMonth()+period,year=a.getUTCFullYear()+Math.floor(month/12),m=month%12;
 const day=Math.min(a.getUTCDate(),new Date(Date.UTC(year,m+1,0)).getUTCDate());
 return new Date(Date.UTC(year,m,day,a.getUTCHours(),a.getUTCMinutes(),a.getUTCSeconds(),a.getUTCMilliseconds()));
}
async function recoverGrants(tx,identity,source,receipt,refunded){
 const grants=await tx.billingPermanentGrant.findMany({where:{sourcePurchaseId:source.purchaseId,refundedAt:refunded?null:{not:null}},orderBy:{period:'asc'}});
 for(const grant of grants){
  const operation=`permanent:${receipt.refundSource}:${grant.id}`;
  const lot=await tx.billingCreditLot.findUnique({where:{sourceKey:grant.id}});
  if(refunded){
   const user=await tx.user.findUnique({where:{id:identity.userId},select:{coins:true}}),recovered=Math.min(user.coins,grant.coins),revoked=lot?.remaining||0;
   if(recovered)await deductCoinsAtomic({tx,userId:identity.userId,amount:recovered,reason:'billing_permanent_refund',refId:operation});
   if(revoked){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:0}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:operation,amount:-revoked}});}
   await tx.billingPermanentGrant.update({where:{id:grant.id},data:{refundedAt:receipt.refundedAt,recoveredCoins:recovered,absorbedCoins:grant.coins-recovered,revokedCredits:revoked}});
  }else{
   if(grant.recoveredCoins)await awardCoins({tx,userId:identity.userId,amount:grant.recoveredCoins,reason:'billing_permanent_refund_reversed',refId:operation});
   if(lot&&grant.revokedCredits){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:{increment:grant.revokedCredits}}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:operation,amount:grant.revokedCredits}});}
   await tx.billingPermanentGrant.update({where:{id:grant.id},data:{refundedAt:null}});
  }
 }
}
async function syncPermanent({tx,identity,history,observedAt,now=new Date()}){
 const receipts=await tx.billingPurchase.findMany({where:{identityId:identity.id,productId:'plus_permanent',benefitKind:'permanent',purchasedAt:{lte:now}},orderBy:[{purchasedAt:'asc'},{canonicalKey:'asc'}]});
 if(!receipts.length)return {verifiedPurchaseIds:[],verificationDeferred:false};
 let schedule=await tx.billingPermanentSchedule.findUnique({where:{identityId:identity.id}});
 if(!schedule){
  const first=receipts[0],paid=await tx.billingPurchase.findMany({where:{identityId:identity.id,benefitKind:'paid',fulfillmentStatus:'fulfilled',subscriptionId:{not:null},purchasedAt:{lte:first.purchasedAt}}});
  const ends=paid.map(p=>p.effectiveExpiresAt||p.expiresAt).filter(end=>end&&end>first.purchasedAt);
  const anchorAt=new Date(Math.max(first.purchasedAt.getTime(),...ends.map(d=>d.getTime())));
  schedule=await tx.billingPermanentSchedule.create({data:{identityId:identity.id,benefitVersion:VERSION,anchorAt,nextDueAt:anchorAt}});
 }
 for(const receipt of receipts){
  let source=await tx.billingPermanentSource.findUnique({where:{purchaseId:receipt.id}});
  if(!source)source=await tx.billingPermanentSource.create({data:{purchaseId:receipt.id,identityId:identity.id,purchasedAt:receipt.purchasedAt,observedAt,revokedAt:null}});
  if(receipt.refundedAt&&!source.revokedAt){
   await recoverGrants(tx,identity,source,receipt,true);
   await tx.billingPermanentRevocation.create({data:{id:`${receipt.id}:${receipt.refundSource}`,sourcePurchaseId:receipt.id,revokedAt:receipt.refundedAt,observedAt:receipt.refundObservedAt||observedAt}});
  }
  if(!receipt.refundedAt&&source.revokedAt){
   await recoverGrants(tx,identity,source,receipt,false);
   await tx.billingPermanentRevocation.updateMany({where:{sourcePurchaseId:receipt.id,reversedAt:null},data:{reversedAt:receipt.refundObservedAt||observedAt}});
   // Rescan original boundaries after reversal. Immutable unique grant rows
   // preserve already issued and partially recovered value.
   schedule=await tx.billingPermanentSchedule.update({where:{identityId:identity.id},data:{nextPeriod:0,nextDueAt:schedule.anchorAt}});
  }
  await tx.billingPermanentSource.update({where:{purchaseId:receipt.id},data:{revokedAt:receipt.refundedAt,refundOperation:receipt.refundSource,observedAt:receipt.refundObservedAt||observedAt}});
  if(!receipt.refundedAt&&receipt.fulfillmentStatus!=='fulfilled')await tx.billingPurchase.update({where:{id:receipt.id},data:{fulfillmentStatus:'fulfilled'}});
 }
 const sources=await tx.billingPermanentSource.findMany({where:{identityId:identity.id,revokedAt:null},orderBy:[{purchasedAt:'asc'},{purchaseId:'asc'}]});
 if(!sources.length)return {verifiedPurchaseIds:[],verificationDeferred:false};
 const canonicalById=new Map(receipts.map(r=>[r.id,r.canonicalKey]));sources.sort((a,b)=>a.purchasedAt-b.purchasedAt||canonicalById.get(a.purchaseId).localeCompare(canonicalById.get(b.purchaseId)));
 // Permanent payment ends the trial-only benefit once; paid lots are untouched.
 const trialLots=await tx.billingCreditLot.findMany({where:{identityId:identity.id,kind:'trial',remaining:{gt:0}}});
 for(const lot of trialLots){await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:0}});await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:`permanent-trial-ended:${lot.id}`,amount:-lot.remaining}});}
 const verifiedPurchaseIds=sources.filter(source=>{const receipt=receipts.find(r=>r.id===source.purchaseId);return history.purchases.some(p=>p.transactionId===receipt.transactionId&&p.appId===receipt.appId&&p.store===receipt.store&&p.paid===true&&p.purchaseStatus==='owned');}).map(s=>s.purchaseId);
 let verificationDeferred=false;
 let period=schedule.nextPeriod,processed=0;
 while(processed<BATCH){
  const boundary=boundaryAt(schedule.anchorAt,period);if(boundary>now)break;
  const id=`permanent:${identity.id}:${schedule.benefitVersion}:${period}`;
  if(!await tx.billingPermanentGrant.findUnique({where:{id}})){
   // Currently revoked sources never fund historical backlog. Repurchases
   // begin only at their own interval; reversal explicitly restores the source.
   const eligible=sources.filter(s=>s.purchasedAt<=boundary);
   const source=eligible.find(s=>verifiedPurchaseIds.includes(s.purchaseId));
   if(!source&&eligible.length){verificationDeferred=true;break;}
   if(source){
    await tx.billingPermanentGrant.create({data:{id,identityId:identity.id,benefitVersion:VERSION,period,sourcePurchaseId:source.purchaseId,boundaryAt:boundary,coins:COINS,credits:CREDITS}});
    await awardCoins({tx,userId:identity.userId,amount:COINS,reason:'billing_permanent_reward',refId:id});
    await tx.billingCreditLot.create({data:{identityId:identity.id,sourceKey:id,kind:'paid',granted:CREDITS,remaining:CREDITS}});
   }
  }
  period++;processed++;
 }
 const nextDueAt=boundaryAt(schedule.anchorAt,period);
 await tx.billingPermanentSchedule.update({where:{identityId:identity.id},data:{nextPeriod:period,nextDueAt}});
 return {verifiedPurchaseIds,verificationDeferred};
}
async function permanentAccess(db,identityId){
 if(!db.billingPermanentSource)return null;
 const source=await db.billingPermanentSource.findFirst({where:{identityId,revokedAt:null}});
 if(!source)return null;
 const schedule=await db.billingPermanentSchedule.findUnique({where:{identityId}});
 return schedule?{source,schedule}:null;
}
module.exports={syncPermanent,permanentAccess,boundaryAt};
