const {AppError}=require('../../../shared/errors/AppError');
async function memberDiscount(db,userId){
 // Injected legacy model test doubles do not expose billing tables. The real
 // Prisma client always does; a missing migration therefore fails loudly.
 if(!db.billingIdentity)return 0;
 const identity=await db.billingIdentity.findUnique({where:{userId}});
 if(!identity||identity.deletedAt)return 0;
 return (await require('../queries/bootstrap').membershipFor(db,identity.id)).discountPercent;
}
function priceFields(basePriceCoins,discountPercent){return discountPercent?{priceCoins:basePriceCoins-Math.floor(basePriceCoins*discountPercent/100),basePriceCoins,discountPercent}:{priceCoins:basePriceCoins};}
async function pricedItem(db,userId,item,expectedPriceCoins){
 if(db.$queryRawUnsafe)await db.$queryRawUnsafe('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE',userId);
 const fields=priceFields(item.priceCoins,await memberDiscount(db,userId));
 if(expectedPriceCoins!==undefined){if(!Number.isInteger(expectedPriceCoins)||expectedPriceCoins<0)throw new AppError('Invalid price quote','INVALID_PRICE_QUOTE',400);
  if(expectedPriceCoins!==fields.priceCoins)throw new AppError('The price has changed','PRICE_CHANGED',409,{priceCoins:fields.priceCoins,basePriceCoins:item.priceCoins,discountPercent:fields.discountPercent||0});}
 return {...item,...fields};
}
module.exports={memberDiscount,priceFields,pricedItem};
