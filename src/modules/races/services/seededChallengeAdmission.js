const { randomUUID } = require('node:crypto');
const { prisma: defaultPrisma } = require('../../../db');
const { AppError } = require('../../../shared/errors/AppError');
const { appSettings } = require('../../../shared/config/appSettings');
const { acquireRaceWriteFences, lockCompetitionRows } = require('./raceWriteFence');
const { acquireGlobalEnrollmentLock, enrollIfGlobalEventActive } = require('../../steps/services/globalEventEnrollment');
const { lockFundedExposureUsers, reserveFundedExposure, computeRaceExposureStamp, newRacePrizeStamp } = require('./fundedExposure');
const { windowFor, cohortMaximumForSeed, matchStepsForCandidates, acquireSeededWindowLock } = require('./seededRaceBuckets');
const { normalizePowerupConfig } = require('./validateRaceConfig');
const { enqueueRaceResolution } = require('./enqueueRaceResolution');
const KINDS = ['DAILY_10K', 'WEEKLY_50K'];
const busy = () => new AppError('Could not join right now. Try again.', 'CHALLENGE_JOIN_BUSY', 503, { retryable: true });
const retry = () => { const error = busy(); error.admissionRetry = true; return error; };
function buildSeededChallengeAdmission(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const settings = dependencies.appSettings || appSettings;
  async function raceData(seed, window, id, active) {
    const [funded, geometric, rounded] = await Promise.all(['fundedPrizePoolsEnabled', 'seededGeometricPayoutsEnabled', 'payoutRoundingV1Enabled'].map(k => settings.getFlag(k)));
    const stamp = newRacePrizeStamp();
    return { id, seedId: seed.id, name: seed.name, targetSteps: seed.targetSteps, status: active ? 'ACTIVE' : 'PENDING', isPublic: false,
      maxParticipants: cohortMaximumForSeed(seed), powerupsEnabled: seed.powerupsEnabled, timeBased: seed.timeBased,
      timezone: 'America/New_York', scheduledStartAt: window.windowStart, startedAt: active ? window.windowStart : null,
      endsAt: window.windowEnd, maxDurationDays: seed.cadence === 'WEEKLY' ? 7 : 1, payoutPreset: 'TOP_HALF',
      payoutCurve: geometric === true ? 'GEOMETRIC' : null, fundedPrize: funded === true,
      prizeCalculationVersion: stamp.prizeCalculationVersion, prizeCoinUnit: stamp.prizeCalculationVersion >= 2 ? stamp.prizeCoinUnit : null,
      prizePoolMaxCoins: stamp.prizeCalculationVersion >= 2 ? stamp.prizePoolMaxCoins : null, payoutRoundingVersion: rounded === true ? 1 : 0,
      powerupStepInterval: normalizePowerupConfig({ powerupsEnabled: seed.powerupsEnabled ?? false }) };
  }
  // One window-scoped bounded shortlist. Reserved users count only until their
  // participant exists; accepted counts come from the transactional DB aggregate.
  async function candidates(client, seed, window, matchSteps) {
    return client.$queryRaw`
      WITH capacity AS (
        SELECT b.id::text AS "bucketId", b.race_id::text AS "raceId", NULL::text AS "groupId",
               COALESCE(c.accepted_count,0)+COALESCE(res.n,0) AS occupied,
               abs(COALESCE(skill.mean,0)-${matchSteps}::double precision) AS distance
        FROM seeded_race_buckets b JOIN races r ON r.id=b.race_id
        LEFT JOIN race_accepted_participant_counts c ON c.race_id=r.id
        LEFT JOIN LATERAL (SELECT count(*)::int n FROM seeded_race_window_memberships m
          JOIN seeded_challenge_preparation_groups g ON g.id=m.preparation_group_id
          WHERE g.reserved_race_id=r.id AND m.race_id IS NULL) res ON true
        LEFT JOIN LATERAL (SELECT avg(a.match_steps) mean FROM seeded_race_bucket_assignments a WHERE a.bucket_id=b.id) skill ON true
        WHERE b.seed_id=${seed.id} AND b.window_start=${window.windowStart} AND b.window_end=${window.windowEnd}
          AND r.status IN ('pending','active') AND COALESCE(c.accepted_count,0)+COALESCE(res.n,0)<r.max_participants
        UNION ALL
        SELECT g.reserved_bucket_id,g.reserved_race_id,g.id,COALESCE(res.n,0),
               abs(COALESCE(skill.mean,0)-${matchSteps}::double precision)
        FROM seeded_challenge_preparation_groups g
        JOIN seeded_challenge_preparations p ON p.id=g.preparation_id AND p.generation=g.generation
        LEFT JOIN LATERAL (SELECT count(*)::int n FROM seeded_race_window_memberships m WHERE m.preparation_group_id=g.id AND m.race_id IS NULL) res ON true
        LEFT JOIN LATERAL (SELECT avg((member->>'matchSteps')::int) mean FROM jsonb_array_elements(g.members) member) skill ON true
        WHERE p.seed_id=${seed.id} AND p.window_start=${window.windowStart} AND p.window_end=${window.windowEnd}
          AND p.state IN ('PUBLISHED','MATERIALIZING','COMPLETE')
          AND NOT EXISTS(SELECT 1 FROM seeded_race_buckets b WHERE b.race_id=g.reserved_race_id)
          AND COALESCE(res.n,0)<${cohortMaximumForSeed(seed)}
      ) SELECT * FROM capacity ORDER BY distance,occupied DESC,"raceId" LIMIT 8`;
  }

  async function response(client, receipt, alreadyJoined) {
    const race = await client.race.findUnique({ where: { id: receipt.raceId }, select: { status: true, startedAt: true } });
    if (!race) throw busy();
    return { joined: true, alreadyJoined, seedKind: receipt.seedKind, raceId: receipt.raceId, participantId: receipt.participantId,
      windowStart: receipt.windowStart, windowEnd: receipt.windowEnd, joinedAt: receipt.joinedAt,
      scoringStartsAt: new Date(Math.max(new Date(receipt.joinedAt).getTime(), new Date(race.startedAt || receipt.windowStart).getTime())), raceStatus: race.status };
  }
  async function admit({ userId, seedKind, requestId, source = 'MANUAL_CURRENT', targetWindow = null, acceptedAt = null }) {
    if (!KINDS.includes(seedKind)) throw new AppError('Unsupported challenge kind', 'INVALID_SEED_KIND', 400);
    const seed = await db.raceSeed.findUnique({ where: { kind: seedKind } });
    if (!seed) throw new AppError('Seed not found or disabled', 'SEED_NOT_FOUND_OR_DISABLED', 404);
    const receiptWhere = requestId ? { userId_requestId: { userId, requestId } } : null;
    async function replay(client) {
      if (!receiptWhere) return null;
      const found = await client.seededChallengeJoinReceipt.findUnique({ where: receiptWhere });
      if (!found) return null;
      if (found.seedId !== seed.id) throw new AppError('Request ID belongs to another challenge', 'IDEMPOTENCY_CONFLICT', 409);
      return response(client, { ...found, seedKind }, true);
    }
    const replayed = await replay(db); if (replayed) return replayed;
    if (!seed.active) throw new AppError('Seed not found or disabled','SEED_NOT_FOUND_OR_DISABLED',404);
    for (let attempt = 0; attempt < 3; attempt++) {
      const window = targetWindow || windowFor(seed, now());
      if (now() >= window.windowEnd) throw busy();
      const key = { seedId: seed.id, windowStart: window.windowStart, userId };
      const ledger = await db.seededRaceWindowMembership.findUnique({ where: { seedId_windowStart_userId: key } });
      const owned = await db.raceParticipant.findFirst({ where: { userId, ...(ledger?.raceId?{raceId:ledger.raceId}:{}), race: { seedId: seed.id, OR: [{ scheduledStartAt: window.windowStart }, { scheduledStartAt: null, startedAt: window.windowStart }] } }, include: { race: true } });
      const reservation = ledger?.preparationGroupId ? await db.seededChallengePreparationGroup.findUnique({ where: { id: ledger.preparationGroupId } }) : null;
      const preparation = reservation ? await db.seededChallengePreparation.findUnique({ where: { id: reservation.preparationId } }) : null;
      const published = reservation && !ledger.raceId && ['PUBLISHED','MATERIALIZING','COMPLETE'].includes(preparation?.state);
      const [{ matchSteps }] = owned && owned.status === 'ACCEPTED' ? [{ matchSteps: 0 }] : await matchStepsForCandidates({ prisma: db, candidates: [{ userId }], seed, windowStart: window.windowStart });
      const pruneCandidate = owned?.status === 'DECLINED';
      const proposedRaceId = randomUUID();
      const shellTemplate = await raceData(seed, window, proposedRaceId, now() >= window.windowStart);
      try {
        const result = await db.$transaction(async tx => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1500ms'");
          // Admission-only placement guard precedes C0. Selecting after this
          // guard prevents HTTP callers from repeatedly racing stale capacity
          // snapshots or creating competing overflow shells. Background writers
          // never take it; their existing C0/user/window guards still arbitrate
          // materialization, pruning and lifecycle changes below.
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            `seeded-current-admission:${seed.id}:${window.windowStart.toISOString()}`);
          const shortlist = (!owned || pruneCandidate) && !published ? await candidates(tx, seed, window, matchSteps) : [];
          const originalHasRoom = pruneCandidate && await tx.raceParticipant.count({where:{raceId:owned.raceId,status:'ACCEPTED'}}) < owned.race.maxParticipants;
          const chosen = owned && (!pruneCandidate || originalHasRoom) ? { raceId: owned.raceId, bucketId: owned.race.seededBucketId } : published ? { raceId: reservation.reservedRaceId, bucketId: reservation.reservedBucketId } : shortlist[0];
          const raceId = chosen?.raceId || proposedRaceId, bucketId = chosen?.bucketId || randomUUID();
          const shell = { ...shellTemplate, id: raceId };
          const shellExists = await tx.race.findUnique({ where: { id: raceId }, select: { id: true } });
          if (!shellExists) await tx.race.createMany({ data: [shell], skipDuplicates: true });
          await acquireRaceWriteFences(tx, [raceId, ...(ledger?.raceId ? [ledger.raceId] : [])]);
          await acquireGlobalEnrollmentLock(tx);
          await lockFundedExposureUsers(tx, [userId]);
          await lockCompetitionRows(tx, { raceIds: [raceId, ...(ledger?.raceId ? [ledger.raceId] : [])] });
          const lockedPolicy = await tx.race.findUnique({where:{id:raceId}});
          let exposure = null;
          if (lockedPolicy.fundedPrize && (!owned || pruneCandidate)) {
            exposure = computeRaceExposureStamp({ maxDurationDays:lockedPolicy.maxDurationDays,prizeCoinUnit:lockedPolicy.prizeCoinUnit,teamPoolMultBps:lockedPolicy.teamPoolMultBps });
            await reserveFundedExposure({tx,userId,stamp:exposure,competition:{raceId},enforceLimits:false});
          }
          await acquireSeededWindowLock(tx, seed.id, window.windowStart);
          const replayInside = await replay(tx);
          if (replayInside) { const error=new Error('Receipt committed by another request'); error.committedReplay=replayInside; throw error; }
          const decisionAt = now();
          if (decisionAt >= window.windowEnd || (!targetWindow && windowFor(seed, decisionAt).windowStart.getTime() !== window.windowStart.getTime())) throw retry();
          const freshSeed = await tx.raceSeed.findUnique({ where: { id: seed.id } });
          if (!freshSeed?.active) throw new AppError('Seed not found or disabled','SEED_NOT_FOUND_OR_DISABLED',404);
          const freshLedger = await tx.seededRaceWindowMembership.findUnique({ where: { seedId_windowStart_userId: key } });
          if (freshLedger?.raceId && freshLedger.raceId !== raceId && !pruneCandidate) {
            const previous = await tx.raceParticipant.findFirst({ where: { raceId: freshLedger.raceId, userId } });
            if (previous || freshLedger.stream !== 'LEGACY') throw retry();
            // Historical legacy election without a participant: both race fences
            // and the user/window guards are held before repairing its pointer.
            await tx.seededRaceWindowMembership.update({ where: { id: freshLedger.id }, data: { stream: 'BUCKET', raceId: null } });
          }
          let participant = await tx.raceParticipant.findFirst({ where: { userId, raceId } });
          let race = await tx.race.findUnique({ where: { id: raceId } });
          const alreadyJoined = participant?.status === 'ACCEPTED';
          let priorPruned = null;
          if (pruneCandidate) {
            priorPruned = await tx.raceParticipant.findUnique({where:{id:owned.id}});
            const originalRace = await tx.race.findUnique({where:{id:owned.raceId}});
            const assignment = await tx.seededRaceBucketAssignment.findUnique({where:{raceParticipantId:owned.id}});
            if (priorPruned?.forfeitedAt || priorPruned?.finishedAt || assignment?.state !== 'PRUNED') throw new AppError('You have left this challenge','CHALLENGE_FORFEITED',409);
            if (priorPruned?.status !== 'DECLINED') throw retry();
            const empty = await require('./seededChallengeMembershipRepair').isEmptySystemPrune(tx,{participant:priorPruned,race:originalRace,assignment});
            if (!empty) {
              await tx.seededChallengeMembershipRepair.upsert({where:{userId_seedId_windowStart:{userId,seedId:seed.id,windowStart:window.windowStart}},create:{userId,seedId:seed.id,windowStart:window.windowStart,sourceParticipantId:priorPruned.id,reason:'ENTANGLED_SYSTEM_PRUNE',availableAt:decisionAt},update:{}});
              await enqueueRaceResolution({raceId:originalRace.id,userId,now:decisionAt,reason:'MEMBERSHIP_CHANGED'},tx);
              if (!shellExists) await tx.race.delete({where:{id:raceId}});
              return {needsRepair:true};
            }
            participant = null;
          }
          if (participant?.forfeitedAt || (participant && participant.status !== 'ACCEPTED')) {
            throw new AppError('You have left this challenge', 'CHALLENGE_FORFEITED', 409);
          }
          if (!participant) {
            if (!chosen && (await candidates(tx, seed, window, matchSteps)).length) throw retry();
            if (!race.seededBucketId) {
              await tx.seededRaceBucket.create({ data: { id: bucketId, seedId: seed.id, ...window, raceId, admissionVersion: 1, status: shell.status } });
              race = await tx.race.update({ where: { id: raceId }, data: { seededBucketId: bucketId } });
              await require('./raceCacheInvalidation').raceChanged(raceId, { seededBucketId: true });
            }
            if (!['ACTIVE','PENDING'].includes(race.status) || race.endsAt <= decisionAt) throw retry();
            const accepted = await tx.raceParticipant.count({ where: { raceId, status: 'ACCEPTED' } });
            const reserved = await tx.seededRaceWindowMembership.count({ where: { preparationGroupId: published ? reservation.id : undefined, raceId: null, ...(published ? {} : { preparationGroupId: { in: (await tx.seededChallengePreparationGroup.findMany({ where: { reservedRaceId: raceId }, select: { id: true } })).map(g => g.id) } }) } });
            if (accepted + reserved - (published && !freshLedger?.raceId ? 1 : 0) >= race.maxParticipants) throw retry();
            const preElected = !priorPruned && freshLedger?.stream === 'BUCKET' && freshLedger.createdAt <= window.windowStart;
            const joinedAt = preElected || source === 'AUTOMATIC' ? window.windowStart
              : source === 'SIGNUP' && acceptedAt ? new Date(Math.max(window.windowStart.getTime(), Math.min(decisionAt.getTime(),new Date(acceptedAt).getTime()))) : decisionAt;
            const participantData = {userId,raceId,status:'ACCEPTED',joinedAt,nextBoxAtSteps:race.powerupsEnabled?race.powerupStepInterval||5000:0,
              ...(exposure?{fundedExposureMillicoins:exposure.exposureMillicoins,fundedExposureRateMillicoinsPerDay:exposure.exposureRateMillicoinsPerDay}:{})};
            participant = priorPruned?.raceId === raceId
              ? await tx.raceParticipant.update({where:{id:priorPruned.id},data:{...participantData,baselineSteps:0,rawSteps:0,boxProgressSteps:0}})
              : await tx.raceParticipant.create({data:participantData});
            await require('./raceCacheInvalidation').membershipChanged([participant]);
            await tx.seededRaceBucketAssignment.upsert({where:{seedId_windowStart_userId:key},create:{bucketId,userId,seedId:seed.id,windowStart:window.windowStart,raceParticipantId:participant.id,matchSteps,state:'FINAL'},update:{bucketId,raceParticipantId:participant.id,matchSteps,state:'FINAL'}});
            if(priorPruned) await tx.seededChallengeTransfer.create({data:{id:requestId||randomUUID(),userId,seedId:seed.id,windowStart:window.windowStart,oldRaceId:priorPruned.raceId,newRaceId:raceId,oldParticipantId:priorPruned.id,newParticipantId:participant.id,priorAssignment:owned.race.seededBucketId,newAssignment:bucketId,sourceState:'PRUNED',reason:priorPruned.raceId===raceId?'MANUAL_REACTIVATION':'FULL_GROUP_TRANSFER'}});
            if (race.status === 'ACTIVE') await enrollIfGlobalEventActive(tx, { raceId, userIds: [userId], at: participant.joinedAt });
          }
          if (race.status === 'PENDING' && decisionAt >= window.windowStart) {
            race = await tx.race.update({ where: { id: raceId }, data: { status: 'ACTIVE', startedAt: window.windowStart } });
            await require('./raceCacheInvalidation').raceChanged(raceId, { status: true, startedAt: true });
            if (race.seededBucketId) await tx.seededRaceBucket.update({ where: { id: race.seededBucketId }, data: { status: 'ACTIVE' } });
            await enrollIfGlobalEventActive(tx,{raceId,userIds:[userId],at:participant.joinedAt});
          }
          await tx.seededRaceWindowMembership.upsert({ where: { seedId_windowStart_userId: key }, create: { ...key, stream: race.seededBucketId ? 'BUCKET' : 'LEGACY', raceId, admissionSource: source, manualJoinedAt: source === 'MANUAL_CURRENT' ? decisionAt : null }, update: { raceId, stream: race.seededBucketId ? 'BUCKET' : 'LEGACY', admissionSource: source, ...(!published?{preparationGroupId:null}:{}), ...(source === 'MANUAL_CURRENT' ? { manualJoinedAt: decisionAt } : {}) } });
          const receipt = { userId, requestId, seedId: seed.id, ...window, raceId, participantId: participant.id, joinedAt: participant.joinedAt };
          if (requestId) await tx.seededChallengeJoinReceipt.create({ data: receipt });
          if (!alreadyJoined) await enqueueRaceResolution({ raceId, userId, now: decisionAt, reason: 'MEMBERSHIP_CHANGED' }, tx);
          if (now() >= window.windowEnd) throw retry();
          return response(tx, { ...receipt, seedKind }, alreadyJoined);
        }, { timeout: 15000, maxWait: 2000 });
        if (result.needsRepair) throw busy();
        if (!result.alreadyJoined) {
          await Promise.allSettled([
            require('./raceListCache').invalidateUser(userId),
            require('./raceProgressSnapshot').invalidateRaceProgress(result.raceId),
            require('../../steps/services/globalStepEventEntitlement').invalidateHomeActiveGlobalEvent([userId]),
          ]);
        }
        return result;
      } catch (error) {
        if (error.committedReplay) return error.committedReplay;
        if (error.admissionRetry || ['P2002','P2034','P2028'].includes(error.code) || /lock timeout|deadlock/.test(error.message)) { if (attempt < 2) continue; throw busy(); }
        throw error;
      }
    }
    throw busy();
  }
  return { admit, raceData, candidates };
}
module.exports = { buildSeededChallengeAdmission, busy, KINDS };
