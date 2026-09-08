const {AppError}=require('../../../shared/errors/AppError');
const {claimLease,refreshLease,releaseLease,applyHistory}=require('../models/billingState');
async function reconcileIdentity({db,config,provider,identity}){
 const token=await claimLease(db,identity.id);if(!token)return {complete:false};
 const heartbeat=setInterval(()=>refreshLease(db,identity.id,token).catch(()=>{}),20000);heartbeat.unref?.();
 try{const history=await provider.getCustomerHistory(identity);const result=await applyHistory({db,config,identity,token,history});await releaseLease(db,identity.id,token,result.verificationDeferred?{failed:true,message:'BILLING_SOURCE_VERIFICATION_PENDING'}:{});return result;}
 catch(error){await releaseLease(db,identity.id,token,{failed:true,message:error.code||'BILLING_RECONCILIATION_FAILED'});throw error instanceof AppError?error:new AppError('Billing provider unavailable','BILLING_UNAVAILABLE',503);}
 finally{clearInterval(heartbeat);}
}
module.exports={reconcileIdentity};
