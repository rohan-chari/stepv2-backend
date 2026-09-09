const { randomUUID } = require('node:crypto');
const { upcomingWindowFor, windowFor } = require('./seededRaceBuckets');
function targetWindows(requestedAt, { current = false } = {}) {
  return ['DAILY','WEEKLY'].map(cadence => ({ cadence, ...(current ? windowFor : upcomingWindowFor)({cadence}, requestedAt) }));
}
// Called ONLY inside the user preference/account transaction. It acquires no
// race, global or window locks. The exact accepted request time is immutable.
async function persistEnrollmentIntents(tx, { user, requestedAt, source = 'PREFERENCE', current = false }) {
  if (!user || user.isReviewAccount || !user.autoJoinFeaturedRaces) return;
  const seeds = await tx.raceSeed.findMany({ where:{active:true,kind:{in:['DAILY_10K','WEEKLY_50K']}},select:{id:true,cadence:true} });
  const windows = targetWindows(requestedAt,{current});
  await tx.seededChallengeEnrollmentRequest.createMany({ data:seeds.map(seed => {
    const window=windows.find(w=>w.cadence===seed.cadence);
    return {id:randomUUID(),userId:user.id,seedId:seed.id,windowStart:window.windowStart,windowEnd:window.windowEnd,source,requestedAt,availableAt:requestedAt};
  }),skipDuplicates:true });
}
module.exports={targetWindows,persistEnrollmentIntents};
