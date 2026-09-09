const { acquireGlobalEnrollmentLock } = require('../../steps/services/globalEventEnrollment');
const { lockFundedExposureUsers } = require('./fundedExposure');
const { lockCompetitionRows } = require('./raceWriteFence');
const { acquireSeededWindowLock } = require('./seededRaceBuckets');
// Prove a system prune is empty from authoritative inputs. Cached totalSteps
// alone is never evidence: a delayed scoring worker may not have persisted it.
async function isEmptySystemPrune(tx, {participant,race,assignment}) {
  if (!participant || participant.status !== 'DECLINED' || assignment?.state !== 'PRUNED' || participant.forfeitedAt || participant.finishedAt || race.status !== 'ACTIVE') return false;
  if (participant.totalSteps || participant.rawSteps || participant.bonusSteps || participant.maxBonusSteps) return false;
  const from = new Date(Math.max(new Date(participant.joinedAt).getTime(),new Date(race.startedAt).getTime()));
  const until = race.endsAt;
  const [row] = await tx.$queryRaw`
    SELECT (
      EXISTS(SELECT 1 FROM step_samples WHERE user_id=${participant.userId} AND steps>0 AND period_end>${from} AND period_start<${until}) OR
      EXISTS(SELECT 1 FROM steps WHERE user_id=${participant.userId} AND steps>0 AND date>=${new Date(from.toISOString().slice(0,10))} AND date<=${new Date(until.toISOString().slice(0,10))}) OR
      EXISTS(SELECT 1 FROM race_powerups WHERE race_id=${race.id} AND (user_id=${participant.userId} OR target_user_id=${participant.userId})) OR
      EXISTS(SELECT 1 FROM race_active_effects WHERE race_id=${race.id} AND (source_user_id=${participant.userId} OR target_user_id=${participant.userId})) OR
      EXISTS(SELECT 1 FROM race_powerup_events WHERE race_id=${race.id} AND (actor_user_id=${participant.userId} OR target_user_id=${participant.userId})) OR
      EXISTS(SELECT 1 FROM global_event_race_impacts WHERE race_id=${race.id} AND user_id=${participant.userId})
    ) AS entangled`;
  return row?.entangled === false;
}
function buildSeededChallengeMembershipRepair(){
  async function processRace({tx,raceId,now=new Date()}){
    // Race job ownership has already been fenced by the canonical V2 caller.
    const tasks=await tx.seededChallengeMembershipRepair.findMany({where:{state:'PENDING',availableAt:{lte:now},sourceParticipantId:{in:(await tx.raceParticipant.findMany({where:{raceId,status:'DECLINED'},select:{id:true},take:100})).map(p=>p.id)}},orderBy:{id:'asc'},take:100});
    if(!tasks.length)return {changed:false,userIds:[]};
    await acquireGlobalEnrollmentLock(tx);await lockFundedExposureUsers(tx,tasks.map(t=>t.userId));await lockCompetitionRows(tx,{raceIds:[raceId]});
    const race=await tx.race.findUnique({where:{id:raceId}});
    for(const task of tasks){
      await acquireSeededWindowLock(tx,task.seedId,task.windowStart);
      const participant=await tx.raceParticipant.findUnique({where:{id:task.sourceParticipantId}});
      const assignment=await tx.seededRaceBucketAssignment.findUnique({where:{raceParticipantId:task.sourceParticipantId}});
      const clear=await isEmptySystemPrune(tx,{participant,race,assignment});
      await tx.seededChallengeMembershipRepair.update({where:{id:task.id},data:{state:clear?'COMPLETE':'PENDING',result:clear?'CLEARED_PRUNE':'INCONSISTENT_HISTORY',attempts:{increment:1},availableAt:new Date(now.getTime()+Math.min(3600000,1000*2**Math.min(task.attempts,12))),leaseToken:null,leaseExpiresAt:null}});
      if(!clear)console.error(JSON.stringify({event:'seeded_membership_inconsistent_history',raceId,repairId:task.id}));
    }
    return {changed:false,userIds:[]};
  }
  return {processRace};
}
module.exports={buildSeededChallengeMembershipRepair,isEmptySystemPrune};
