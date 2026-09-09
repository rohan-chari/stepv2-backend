const { randomUUID } = require('node:crypto');
const { acquireGlobalEnrollmentLock, enrollIfGlobalEventActive } = require('../../steps/services/globalEventEnrollment');
const { lockFundedExposureUsers, reserveFundedExposures, computeRaceExposureStamp, resolveRacePrizeStamp } = require('./fundedExposure');
const { lockCompetitionRows } = require('./raceWriteFence');
const { acquireSeededWindowLock, cohortMaximumForSeed } = require('./seededRaceBuckets');
// Executed exclusively by the canonical V2 worker, after acquiring its existing
// expectedLeaseToken write fence and BEFORE assembling any scoring snapshot.
function buildSeededChallengeMaterialization() {
  async function processRace({ tx, raceId, now = new Date() }) {
    const group = await tx.seededChallengePreparationGroup.findUnique({ where: { reservedRaceId: raceId } });
    if (!group || group.state === 'MATERIALIZED') return { changed: false, userIds: [] };
    const preparation = await tx.seededChallengePreparation.findUnique({ where: { id: group.preparationId } });
    if (!preparation || preparation.generation !== group.generation || !['PUBLISHED','MATERIALIZING','COMPLETE'].includes(preparation.state)) return { changed:false,userIds:[] };
    const race = await tx.race.findUnique({ where: { id: raceId }, include: { seed: true } });
    if (!race || !['PENDING','ACTIVE'].includes(race.status) || now >= preparation.windowEnd) return { changed:false,userIds:[] };
    const members = group.members;
    if (!Array.isArray(members) || members.length > cohortMaximumForSeed(race.seed) || members.some(m => typeof m.userId !== 'string' || !Number.isInteger(m.matchSteps) || m.matchSteps < 0)) throw new Error('Invalid seeded reservation payload');
    const userIds = [...new Set(members.map(m=>m.userId))].sort();
    if (userIds.length !== members.length) throw new Error('Duplicate seeded reservation member');
    await acquireGlobalEnrollmentLock(tx);
    await lockFundedExposureUsers(tx, userIds);
    const reservations = await tx.seededRaceWindowMembership.findMany({ where:{preparationGroupId:group.id,stream:'BUCKET',raceId:null},select:{id:true,userId:true,createdAt:true,admissionSource:true} });
    // All payload user guards are held. Admission for these users cannot change
    // assignment while exposure helpers acquire their sorted competition rows.
    let exposure = null;
    if (race.fundedPrize) {
      exposure = computeRaceExposureStamp({ maxDurationDays:race.maxDurationDays,prizeCoinUnit:resolveRacePrizeStamp(race).prizeCoinUnit,teamPoolMultBps:race.teamPoolMultBps });
      await reserveFundedExposures({ tx, reservations:reservations.map(({userId})=>({userId,stamp:exposure,competition:{raceId}})),enforceLimits:false });
    } else await lockCompetitionRows(tx,{raceIds:[raceId]});
    await acquireSeededWindowLock(tx, preparation.seedId, preparation.windowStart);
    const lockedGroup = await tx.seededChallengePreparationGroup.findUnique({where:{id:group.id}});
    const lockedPrep = await tx.seededChallengePreparation.findUnique({where:{id:preparation.id}});
    if (lockedGroup.state === 'MATERIALIZED') return {changed:false,userIds:[]};
    const freshReservations = await tx.seededRaceWindowMembership.findMany({where:{preparationGroupId:group.id,stream:'BUCKET',raceId:null},select:{id:true},orderBy:{id:'asc'}});
    if (JSON.stringify(lockedGroup.members) !== JSON.stringify(members) ||
        freshReservations.map(m=>m.id).join(',') !== reservations.map(m=>m.id).sort().join(',')) {
      const error = new Error('Seeded reservation changed before window arbitration');
      error.code = 'SEEDED_RESERVATION_CHANGED';
      throw error;
    }
    if (lockedPrep.generation !== group.generation || !['PUBLISHED','MATERIALIZING','COMPLETE'].includes(lockedPrep.state)) throw new Error('Published seeded preparation changed');

    if (reservations.some(m=>!userIds.includes(m.userId))) throw new Error('Reservation payload mismatch');
    const accepted = await tx.raceParticipant.count({where:{raceId,status:'ACCEPTED'}});
    if (accepted+reservations.length > race.maxParticipants) throw new Error('Reserved group exceeds hard capacity');
    await tx.seededRaceBucket.upsert({where:{id:group.reservedBucketId},create:{id:group.reservedBucketId,seedId:preparation.seedId,windowStart:preparation.windowStart,windowEnd:preparation.windowEnd,raceId,status:race.status,admissionVersion:1},update:{}});
    await tx.race.update({where:{id:raceId},data:{seededBucketId:group.reservedBucketId}});
    const rows=reservations.map(m=>({id:randomUUID(),raceId,userId:m.userId,status:'ACCEPTED',joinedAt:m.admissionSource==='SIGNUP' && m.createdAt>preparation.windowStart?m.createdAt:preparation.windowStart,
      nextBoxAtSteps:race.powerupsEnabled?race.powerupStepInterval||5000:0,
      ...(exposure?{fundedExposureMillicoins:exposure.exposureMillicoins,fundedExposureRateMillicoinsPerDay:exposure.exposureRateMillicoinsPerDay}:{})}));
    if(rows.length){
      await tx.raceParticipant.createMany({data:rows});
      const matchByUser=new Map(members.map(m=>[m.userId,m.matchSteps]));
      await tx.seededRaceBucketAssignment.createMany({data:rows.map(row=>({bucketId:group.reservedBucketId,userId:row.userId,seedId:preparation.seedId,windowStart:preparation.windowStart,raceParticipantId:row.id,matchSteps:matchByUser.get(row.userId),state:'FINAL'}))});
      const updated=await tx.seededRaceWindowMembership.updateMany({where:{id:{in:reservations.map(m=>m.id)},raceId:null,preparationGroupId:group.id},data:{raceId}});
      if(updated.count!==rows.length)throw new Error('Reservation changed during fenced materialization');
      if (race.status === 'ACTIVE') {
        // Scheduled participants share the boundary; delayed signup recovery
        // retains its actual accepted instant for global-event eligibility.
        const byJoinedAt = new Map();
        for (const row of rows) {
          const key = row.joinedAt.toISOString();
          if (!byJoinedAt.has(key)) byJoinedAt.set(key, []);
          byJoinedAt.get(key).push(row.userId);
        }
        for (const [joinedAt, userIds] of byJoinedAt) {
          await enrollIfGlobalEventActive(tx, { raceId, userIds, at: new Date(joinedAt) });
        }
      }
    }
    await tx.seededChallengePreparationGroup.update({where:{id:group.id},data:{state:'MATERIALIZED',materializedAt:now}});
    return {changed:rows.length>0,userIds:rows.map(r=>r.userId)};
  }
  return {processRace};
}
module.exports={buildSeededChallengeMaterialization};
