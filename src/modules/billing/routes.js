const {Router}=require('express');
const {prisma:defaultPrisma}=require('../../db');
const {buildRequireAuth}=require('../../middleware/requireAuth');
const {asyncHandler}=require('../../shared/http/asyncHandler');
const {readBillingConfig}=require('./catalog');
const {createRevenueCatProvider}=require('./services/revenueCatProvider');
const {bootstrap}=require('./queries/bootstrap');
const {receiveWebhook}=require('./commands/inbox');
const {syncBilling}=require('./commands/sync');
const {assertRerollCapability}=require('./queries/rerollCapability');
const {rerollPurchase}=require('./commands/rerollPurchase');
function createBillingRouter(dependencies={}){
 const router=Router(),db=dependencies.prisma||defaultPrisma,config=dependencies.billingConfig||readBillingConfig();
 const provider=dependencies.billingProvider||createRevenueCatProvider({config});
 router.post('/webhook/revenuecat',asyncHandler(async(req,res)=>res.json(await receiveWebhook({db,config,authorization:req.get('authorization'),body:req.body}))));
 router.use(dependencies.requireAuth||buildRequireAuth(dependencies));
 router.get('/bootstrap',asyncHandler(async(req,res)=>res.json(await bootstrap({db,config,userId:req.user.id,platform:req.query.platform,clientFeatures:req.clientFeatures,channel:req.releaseChannel}))));
 router.post('/sync',asyncHandler(async(req,res)=>{
  const {statusCode,body}=await syncBilling({db,config,provider,userId:req.user.id,platform:req.query.platform,clientFeatures:req.clientFeatures,channel:req.releaseChannel,body:req.body});
  res.status(statusCode).json(body);
 }));return router;
}
function createBillingRerollRouter(dependencies={}){
 const router=Router(),db=dependencies.prisma||defaultPrisma;
 router.post('/:raceId/powerups/reroll-purchase',dependencies.requireAuth||buildRequireAuth(dependencies),asyncHandler(async(req,res)=>{
  await assertRerollCapability({db,raceId:req.params.raceId,clientFeatures:req.clientFeatures});
  res.json(await rerollPurchase({db,userId:req.user.id,raceId:req.params.raceId,requestKey:req.get('Idempotency-Key'),body:req.body,supportsPowerups5:req.clientFeatures?.has('powerups5')===true}));
 }));return router;
}
module.exports={createBillingRouter,createBillingRerollRouter};
