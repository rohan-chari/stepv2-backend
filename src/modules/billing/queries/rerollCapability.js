const {AppError}=require('../../../shared/errors/AppError');
const {supportsBuckets}=require('../../races/services/seededRaceBuckets');
async function assertRerollCapability({db,raceId,clientFeatures}){
 if(supportsBuckets(clientFeatures))return;
 const marker=await db.race.findUnique({where:{id:raceId},select:{seededBucketId:true}});
 if(marker?.seededBucketId)throw new AppError('Race not found','RACE_NOT_FOUND',404);
}
module.exports={assertRerollCapability};
