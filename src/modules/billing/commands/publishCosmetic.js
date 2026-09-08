async function publishCosmetic({db,month,itemId,apply=false}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))throw new Error('month must be YYYY-MM in UTC');
 const item=await db.shopItem.findUnique({where:{id:itemId}});if(!item||!item.active||item.testOnly||!item.assetKey)throw new Error('Select an active, published compatible shop item with asset metadata');
 if(item.remoteOnly&&!item.assetVersion)throw new Error('Remote-only cosmetic requires a published asset version');
 const existing=await db.billingCosmeticRelease.findUnique({where:{month}});if(existing&&existing.shopItemId!==itemId)throw new Error('This calendar month already has a different immutable release');
 if(apply)await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('INSERT INTO billing_cosmetic_releases (month, shop_item_id, published_at) VALUES ($1, $2, NOW()) ON CONFLICT (month) DO NOTHING',month,itemId);
  const stored=await tx.billingCosmeticRelease.findUnique({where:{month}});if(stored.shopItemId!==itemId)throw new Error('Concurrent publication selected a different cosmetic');
  await tx.$executeRawUnsafe('INSERT INTO billing_reconciliation (identity_id, next_attempt_at, attempts, updated_at) SELECT DISTINCT p.identity_id, NOW(), 0, NOW() FROM billing_purchases p JOIN billing_identities i ON i.id=p.identity_id WHERE i.deleted_at IS NULL AND (p.subscription_id IS NOT NULL OR p.product_id=\'plus_permanent\') ON CONFLICT (identity_id) DO UPDATE SET next_attempt_at=NOW(), requested_version=billing_reconciliation.requested_version+1, updated_at=NOW()');
 });return {apply,month,itemId,alreadyPublished:Boolean(existing)};
}
module.exports={publishCosmetic};
