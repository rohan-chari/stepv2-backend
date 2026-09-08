const { AppError } = require('../../../shared/errors/AppError');
const { PRODUCTS,catalogFor,configured } = require('../catalog');
async function ensureIdentity(db,userId){
 return db.$transaction(async tx=>{
 const db=tx;
 await db.$queryRawUnsafe("SELECT id FROM users WHERE id = $1 FOR KEY SHARE",userId);
 const user=await db.user.findUnique({where:{id:userId}});
 if(!user)throw new AppError('Account not found','NOT_FOUND',404);
 await db.$executeRawUnsafe("INSERT INTO billing_identities (id, user_id, environment, created_at) VALUES (gen_random_uuid()::text, $1, $2, NOW()) ON CONFLICT (user_id) DO NOTHING", userId, user.billingRealm||"production");
 const identity=await db.billingIdentity.findUnique({where:{userId}});
 await db.$executeRawUnsafe("INSERT INTO billing_reconciliation (identity_id, next_attempt_at, attempts, updated_at) VALUES ($1, NOW(), 0, NOW()) ON CONFLICT (identity_id) DO NOTHING",identity.id);
 if(identity.deletedAt)throw new AppError('Billing account was deleted','PURCHASE_ACCOUNT_MISMATCH',409);
 return {identity,user};
 });
}
async function creditsFor(db,identityId,now=new Date()){
 const lots=await db.billingCreditLot.findMany({where:{identityId,remaining:{gt:0},OR:[{expiresAt:null},{expiresAt:{gt:now}}]}});
 const paid=lots.filter(l=>l.kind==='paid').reduce((s,l)=>s+l.remaining,0);
 const trialLots=lots.filter(l=>l.kind==='trial');
 return {paid,trial:trialLots.reduce((s,l)=>s+l.remaining,0),trialExpiresAt:trialLots.length?new Date(Math.min(...trialLots.map(l=>l.expiresAt.getTime()))).toISOString():null};
}
async function membershipFor(db,identityId,now=new Date()){
 const subscriptions=await db.billingSubscription.findMany({where:{identityId},orderBy:{accessUntil:'desc'}});
 const active=subscriptions.find(s=>s.givesAccess&&(s.accessUntil>now||['in_grace_period','unknown'].includes(s.providerStatus)));
 const current=active||subscriptions[0];const product=PRODUCTS.find(p=>p.id===current?.productId);
 const permanent=await require('../models/permanentState').permanentAccess(db,identityId);
 const formerPermanent=!permanent&&db.billingPermanentSchedule?await db.billingPermanentSchedule.findUnique({where:{identityId}}):null;
 const manageable=active||subscriptions.find(s=>['active','trialing','in_grace_period','in_billing_retry','paused','unknown','incomplete'].includes(s.providerStatus));
 const subscription=manageable?{givesAccess:Boolean(active),status:active?(active.trial?'trial':'active'):'expired',plan:PRODUCTS.find(p=>p.id===manageable.productId)?.plan||null,accessUntil:manageable.accessUntil?.toISOString()||null,renews:manageable.renews,providerStatus:manageable.providerStatus}:null;
 return {givesAccess:Boolean(permanent||active),status:permanent?'active':active?(active.trial?'trial':'active'):(current||formerPermanent?'expired':'free'),plan:permanent?'permanent':product?.plan||(formerPermanent?'permanent':null),accessUntil:permanent?null:current?.accessUntil?.toISOString()||null,renews:permanent?false:active?.renews||false,discountPercent:permanent||active?15:0,managementUrl:manageable?.managementUrl||null,nextRewardAt:permanent?.schedule.nextDueAt.toISOString()||null,subscription};
}
async function bootstrap({db,config,userId,platform,clientFeatures=new Set(),channel="prod"}){
 if(platform!==undefined&&!['ios','android'].includes(platform))throw new AppError('Invalid platform','INVALID_PLATFORM',400);
 const {identity,user}=await ensureIdentity(db,userId);const selected=platform||(user.googleSub?'android':'ios');
 const [state,credits]=await Promise.all([membershipFor(db,identity.id),creditsFor(db,identity.id)]);
 const {managementUrl,...membership}=state;const available=configured(config,selected);
 let cosmetic=null;
 const granted=await db.billingCosmeticGrant.findFirst({where:{identityId:identity.id},orderBy:{month:'desc'}});
 if(granted){const item=await db.shopItem.findUnique({where:{id:granted.shopItemId}});
  if(item&&!item.testOnly&&(!item.remoteOnly||clientFeatures.has('remote_assets'))&&(item.slot!=='CHARACTER'||clientFeatures.has('characters'))){
   cosmetic={month:granted.month,item:require('../../cosmetics/shopCosmetics').serializeShopItem(item,{owned:true}),owned:true,grantedAt:granted.createdAt.toISOString()};
  }
 }
 return {available,contract:'bara-billing-v1',identity:{appUserId:identity.id,environment:identity.environment},products:available?catalogFor(selected).filter(p=>membership.plan!=='permanent'||!membership.givesAccess||p.kind==='coins'):[],membership,credits,coins:user.coins,reroll:{supported:true,coinCost:50,maxItems:8},cosmetic,managementUrl,termsUrl:config.termsUrl||null,privacyUrl:config.privacyUrl||null};
}
module.exports={bootstrap,ensureIdentity,creditsFor,membershipFor};
