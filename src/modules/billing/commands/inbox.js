const { timingSafeEqual } = require('node:crypto');
const { AppError } = require('../../../shared/errors/AppError');
async function enqueue(db,identityId){await db.billingReconciliation.upsert({where:{identityId},create:{identityId,requestedVersion:1},update:{nextAttemptAt:new Date(),requestedVersion:{increment:1}}});}
async function receiveWebhook({db,config,authorization,body}){
 const expected=Buffer.from(config.webhookAuthorization||''),actual=Buffer.from(authorization||'');
 if(!expected.length||actual.length!==expected.length||!timingSafeEqual(expected,actual))throw new AppError('Unauthorized','UNAUTHORIZED',401);
 const event=body?.event;if(!event||typeof event.id!=='string'||event.id.length<1||event.id.length>256||typeof event.type!=='string')throw new AppError('Invalid billing event','INVALID_BILLING_EVENT',400);
 const identity=typeof event.app_user_id==='string'?await db.billingIdentity.findUnique({where:{id:event.app_user_id}}):null;
 await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe("INSERT INTO billing_inbox (id, identity_id, payload, created_at) VALUES ($1, $2, $3::jsonb, NOW()) ON CONFLICT (id) DO NOTHING", `${config.projectId}:${event.id}`, identity?.id||null, JSON.stringify(body));
  if(identity&&!identity.deletedAt)await enqueue(tx,identity.id);
 });
 return {received:true};
}
module.exports={receiveWebhook,enqueue};
