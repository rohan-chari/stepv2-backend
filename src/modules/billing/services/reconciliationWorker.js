const {prisma:defaultPrisma}=require('../../../db');
const {readBillingConfig,configured}=require('../catalog');
const {createRevenueCatProvider}=require('./revenueCatProvider');
const {reconcileIdentity}=require('./reconcile');
async function runBillingReconciliation({db=defaultPrisma,config=readBillingConfig(),provider=createRevenueCatProvider({config}),identityId=null,limit=5,logger=console}={}){
 if(!configured(config))return {available:false,processed:0,failed:0};
 const rows=await db.billingReconciliation.findMany({where:identityId?{identityId}:{nextAttemptAt:{lte:new Date()},OR:[{leaseUntil:null},{leaseUntil:{lte:new Date()}}]},orderBy:{nextAttemptAt:'asc'},take:identityId?1:limit});
 let processed=0,failed=0;
 for(const row of rows){const identity=await db.billingIdentity.findUnique({where:{id:row.identityId}});if(!identity||identity.deletedAt){await db.billingReconciliation.deleteMany({where:{identityId:row.identityId}});continue;}
  try{const result=await reconcileIdentity({db,config,provider,identity});if(result.complete)processed++;}
  catch(error){failed++;logger.error('Billing reconciliation failed',{identityId:identity.id,code:error.code||'BILLING_RECONCILIATION_FAILED'});}
 }
 return {available:true,processed,failed};
}
function scheduleBillingReconciliation(options={}){
 const config=options.config||readBillingConfig();if(!configured(config))return null;
 let stopped=false,running=false;const run=options.run||(()=>runBillingReconciliation({...options,config}));
 const tick=async()=>{if(stopped||running)return;running=true;try{await run();}catch(error){(options.logger||console).error('Billing worker failed',{code:error.code||'BILLING_WORKER_FAILED'});}finally{running=false;}};
 const timer=(options.setInterval||setInterval)(tick,30000);timer.unref?.();void tick();
 return {stop(){stopped=true;(options.clearInterval||clearInterval)(timer);}};
}
module.exports={runBillingReconciliation,scheduleBillingReconciliation};
