const {AppError}=require('../../../shared/errors/AppError');
const {configured}=require('../catalog');
const {ensureIdentity,bootstrap}=require('../queries/bootstrap');
const {enqueue}=require('./inbox');
const {reconcileIdentity}=require('../services/reconcile');
async function syncBilling({db,config,provider,userId,platform,clientFeatures,channel,body}){
 if(!configured(config))throw new AppError('Billing is not configured','BILLING_UNAVAILABLE',503);
 const hint=body?.transactionId;if(hint!==undefined&&(typeof hint!=='string'||!hint||hint.length>256))throw new AppError('Invalid transaction hint','INVALID_TRANSACTION_ID',400);
 const {identity}=await ensureIdentity(db,userId);await enqueue(db,identity.id);
 const reconciliation=await reconcileIdentity({db,config,provider,identity});
 const known=hint?await db.billingPurchase.findFirst({where:{identityId:identity.id,transactionId:hint,fulfillmentStatus:{in:['fulfilled','reversed']}}}):reconciliation.complete;
 const state=await bootstrap({db,config,userId,platform,clientFeatures,channel});
 return {statusCode:known?200:202,body:{status:known?'complete':'pending',...(!known?{retryAfterMs:2000}:{}),...state}};
}
module.exports={syncBilling};
