const { slotsChanged } = require('../../powerups/services/raceSlotCacheInvalidation');
const {createHash}=require('node:crypto');
const {AppError}=require('../../../shared/errors/AppError');
const {deductCoinsAtomic}=require('../../../shared/economy/deductCoinsAtomic');
const {acquireRaceWriteFence}=require('../../races/services/raceWriteFence');
const {rollPowerup,buildRollContext,canonicalRarityFor}=require('../../powerups/powerupOdds');
const {rawPositionFor}=require('../../powerups/rawPosition');
const {resolveNullRoll}=require('../../powerups/commands/rerollMysteryBox');
const {DEFAULT_POWERUP_SLOTS,POWERUP_NAMES}=require('../../powerups/commands/rollPowerup');
const {balanceConfig}=require('../../economy/balanceConfig');
const {creditsFor,ensureIdentity}=require('../queries/bootstrap');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function error(message,code,status=409,meta){return new AppError(message,code,status,meta);}
function validate({requestKey,body}){
 if(typeof requestKey!=='string'||!uuid.test(requestKey))throw error('A UUIDv4 Idempotency-Key is required','INVALID_IDEMPOTENCY_KEY',400);
 const ids=body?.powerupIds;
 if(!Array.isArray(ids)||ids.length<1||ids.length>8||ids.some(id=>typeof id!=='string'||!id||id.length>128)||new Set(ids).size!==ids.length||!['coins','credits'].includes(body.funding)||(body.funding==='coins'&&!Number.isInteger(body.expectedCoinCost)))throw error('Invalid reroll request','INVALID_REROLL_REQUEST',400);
 return [...ids].sort();
}
async function rerollPurchase({db,userId,raceId,requestKey,body,supportsPowerups5=false}){
 const ids=validate({requestKey,body});
 const fingerprint=createHash('sha256').update(JSON.stringify({raceId,ids,funding:body.funding,expectedCoinCost:body.funding==='coins'?body.expectedCoinCost:null})).digest('hex');
 const previous=await db.billingRerollOperation.findUnique({where:{userId_requestKey:{userId,requestKey}}});
 if(previous){if(previous.fingerprint!==fingerprint)throw error('Idempotency key was used for another request','IDEMPOTENCY_CONFLICT');return previous.response;}
 const {identity}=await ensureIdentity(db,userId);
 const snapshot=await balanceConfig.getSnapshot();
 return db.$transaction(async tx=>{
  // Canonical mutation fence and lock order match use/open/ad reroll.
  // Check ownership first to avoid creating write-fence jobs for arbitrary IDs.
  const owned=await tx.raceParticipant.findFirst({where:{raceId,userId}});if(!owned)throw error('Not found','NOT_FOUND',404);
  await acquireRaceWriteFence(tx,raceId);
  await tx.$queryRawUnsafe('SELECT id FROM races WHERE id = $1 FOR UPDATE',raceId);
  await tx.$queryRawUnsafe('SELECT id FROM race_participants WHERE race_id = $1 AND user_id = $2 FOR UPDATE',raceId,userId);
  await tx.$queryRawUnsafe('SELECT id FROM race_powerups WHERE id = ANY($1::text[]) AND user_id = $2 AND race_id = $3 ORDER BY id FOR UPDATE',ids,userId,raceId);
  // A same-key request may have waited behind the first transaction.
  const replay=await tx.billingRerollOperation.findUnique({where:{userId_requestKey:{userId,requestKey}}});
  if(replay){if(replay.fingerprint!==fingerprint)throw error('Idempotency key was used for another request','IDEMPOTENCY_CONFLICT');return replay.response;}
  const race=await tx.race.findUnique({where:{id:raceId}}),participant=await tx.raceParticipant.findUnique({where:{id:owned.id}});
  if(!race)throw error('Not found','NOT_FOUND',404);
  if(race.status!=='ACTIVE'||participant.status!=='ACCEPTED'||participant.finishedAt||participant.forfeitedAt)throw error('Race is not active','RACE_NOT_ACTIVE');
  const rows=await tx.racePowerup.findMany({where:{id:{in:ids},raceId,userId}});
  if(rows.length!==ids.length)throw error('Not found','NOT_FOUND',404);
  for(const row of rows){if(row.rerolledAt)throw error('Item already rerolled','ALREADY_REROLLED');if(row.status!=='HELD'||row.usedAt||!row.rarity||(row.upgradeLevel||0)>0)throw error('Item is no longer eligible','NOT_HELD');}
  if(body.funding==='coins'&&body.expectedCoinCost!==50)throw error('Reroll price changed','PRICE_CHANGED',409,{coinCost:50});
  await tx.$queryRawUnsafe('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',userId);
  const walletReplay=await tx.billingRerollOperation.findUnique({where:{userId_requestKey:{userId,requestKey}}});
  if(walletReplay){if(walletReplay.fingerprint!==fingerprint)throw error('Idempotency key was used for another request','IDEMPOTENCY_CONFLICT');return walletReplay.response;}
  await tx.$queryRawUnsafe('SELECT id FROM billing_credit_lots WHERE identity_id = $1 ORDER BY id FOR UPDATE',identity.id);
  const charged={coins:0,paidCredits:0,trialCredits:0};
  if(body.funding==='coins'){
   await deductCoinsAtomic({userId,amount:50,reason:'billing_reroll',refId:requestKey,tx,insufficientError:error('Insufficient coins','INSUFFICIENT_COINS')});charged.coins=50;
  }else{
   const lots=await tx.billingCreditLot.findMany({where:{identityId:identity.id,remaining:{gt:0},OR:[{expiresAt:null},{expiresAt:{gt:new Date()}}]},orderBy:[{createdAt:'asc'},{id:'asc'}]});
   const lot=lots.find(l=>l.kind==='trial')||lots.find(l=>l.kind==='paid');if(!lot)throw error('Insufficient reroll credits','INSUFFICIENT_CREDITS');
   await tx.billingCreditLot.update({where:{id:lot.id},data:{remaining:{decrement:1}}});
   await tx.billingCreditEntry.create({data:{lotId:lot.id,operationKey:`reroll:${userId}:${requestKey}`,amount:-1}});
   charged[lot.kind==='trial'?'trialCredits':'paidCredits']=1;
  }
  const participants=await tx.raceParticipant.findMany({where:{raceId,status:'ACCEPTED'}});
  const {position,totalParticipants}=rawPositionFor({participants,race,userId});
  const ctx=buildRollContext({stepTotals:participants.map(p=>p.totalSteps||0),myTotalSteps:participant.totalSteps||0,position,totalParticipants,isTeamRace:race.isTeamRace===true,supportsPowerups5});
  const {config,version:configVersion}=snapshot;const maxSlots=participant.powerupSlots||DEFAULT_POWERUP_SLOTS,results=[],now=new Date();
  for(const id of ids){let rolled=rollPowerup(position,totalParticipants,Math.random,{ctx,config});
   for(let attempt=0;rolled.type==='FANNY_PACK'&&maxSlots>DEFAULT_POWERUP_SLOTS&&attempt<10;attempt++)rolled=rollPowerup(position,totalParticipants,Math.random,{ctx,config});
   rolled=resolveNullRoll(rolled,config,ctx);const rarity=canonicalRarityFor(rolled.type,rolled.rarity,config,null);
   const changed=await tx.racePowerup.updateMany({where:{id,status:'HELD',usedAt:null,rerolledAt:null,upgradeLevel:0},data:{type:rolled.type,rarity,configVersion,rerolledAt:now}});
   if(changed.count) await slotsChanged({ participantId: participant.id });
   if(changed.count!==1)throw error('Item already rerolled','ALREADY_REROLLED');
   await tx.racePowerupEvent.create({data:{raceId,actorUserId:userId,eventType:'POWERUP_REROLLED',powerupType:rolled.type,description:`A runner rerolled a mystery box: ${POWERUP_NAMES[rolled.type]||rolled.type}!`}});
   results.push({powerupId:id,type:rolled.type,rarity,rerolled:true,rerolledAt:now.toISOString(),configVersion});
  }
  const wallet=await tx.user.findUnique({where:{id:userId},select:{coins:true}});
  const response={results,charged,coins:wallet.coins,credits:await creditsFor(tx,identity.id)};
  await tx.billingRerollOperation.create({data:{userId,requestKey,fingerprint,response}});return response;
 },{maxWait:10000,timeout:20000});
}
module.exports={rerollPurchase,validate};
