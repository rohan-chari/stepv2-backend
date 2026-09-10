const { participantsChanged } = require('../../powerups/services/raceSlotCacheInvalidation');
const { randomUUID } = require('node:crypto');
const { acquireGlobalEnrollmentLock } = require('../../steps/services/globalEventEnrollment');
const { lockFundedExposureUsers } = require('./fundedExposure');
const { lockCompetitionRows } = require('./raceWriteFence');
const { hashAppleSub } = require('../../users/appleSubHash');

// The canonical V2 worker owns the caller transaction/fence. The existing
// once-per-human ledger arbitrates with immediate signup and old clients.
function buildSeededChallengeWelcome() {
  async function processRace({ tx, raceId }) {
    const race = await tx.race.findUnique({ where: { id: raceId }, select: {
      id: true, seedId: true, seed: { select: { kind: true } }, status: true, powerupsEnabled: true, scheduledStartAt: true, startedAt: true,
    } });
    if (!race?.seedId || !['DAILY_10K','WEEKLY_50K'].includes(race.seed?.kind) || race.status !== 'ACTIVE' || !race.powerupsEnabled) return { changed: false, userIds: [], events: [] };
    const participants = await tx.$queryRawUnsafe(`
      SELECT p.id,p.user_id AS "userId",p.powerup_slots AS "powerupSlots",
             u.apple_id AS "appleId",u.google_sub AS "googleSub"
        FROM race_participants p JOIN users u ON u.id=p.user_id
       WHERE p.race_id=$1 AND p.status='accepted' AND p.forfeited_at IS NULL
         AND u.is_review_account=false AND (EXISTS (
           SELECT 1 FROM seeded_challenge_enrollment_requests i
            WHERE i.user_id=u.id AND i.seed_id=$2 AND i.window_start=$3 AND i.source='SIGNUP'
         ) OR EXISTS (
           SELECT 1 FROM onboarding_box_grant g WHERE g.apple_sub_hash=encode(sha256(convert_to(COALESCE(NULLIF(u.apple_id,''),NULLIF(u.google_sub,'')),'UTF8')),'hex')
             AND g.granted_box_count<g.target_box_count
         )) ORDER BY p.user_id LIMIT 100`, raceId, race.seedId, race.scheduledStartAt || race.startedAt);
    if (!participants.length) return { changed: false, userIds: [], events: [] };
    await acquireGlobalEnrollmentLock(tx);
    await lockFundedExposureUsers(tx, participants.map(row => row.userId));
    await lockCompetitionRows(tx, { raceIds: [raceId] });
    const byHash = new Map();
    for (const participant of participants) {
      const hash = hashAppleSub(participant.appleId || participant.googleSub);
      if (hash && participant.powerupSlots > 0 && !byHash.has(hash)) byHash.set(hash, participant);
    }
    if (!byHash.size) return { changed: false, userIds: [], events: [] };
    const claims = [...byHash].map(([hash, participant]) => ({ hash, target: Math.min(3, participant.powerupSlots) }));
    await tx.$executeRawUnsafe(`
      INSERT INTO onboarding_box_grant (apple_sub_hash,target_box_count,granted_box_count)
      SELECT hash,target,0 FROM jsonb_to_recordset($1::jsonb) AS row(hash text,target int) ORDER BY hash
      ON CONFLICT (apple_sub_hash) DO NOTHING`, JSON.stringify(claims));
    const pending = await tx.$queryRawUnsafe(`
      SELECT apple_sub_hash AS hash,target_box_count AS target,granted_box_count AS granted
        FROM onboarding_box_grant WHERE apple_sub_hash=ANY($1::text[])
          AND granted_box_count<target_box_count ORDER BY apple_sub_hash FOR UPDATE`, [...byHash.keys()]);
    const occupied = await tx.racePowerup.groupBy({ by: ['participantId'], where: {
      participantId: { in: participants.map(row => row.id) }, status: { in: ['HELD','MYSTERY_BOX'] },
    }, _count: { _all: true } });
    const occupiedByParticipant = new Map(occupied.map(row => [row.participantId,row._count._all]));
    const deliveries = pending.map(row => {
      const participant = byHash.get(row.hash);
      return { ...row, participant, count: Math.min(row.target-row.granted,
        Math.max(0,participant.powerupSlots-(occupiedByParticipant.get(participant.id)||0))) };
    }).filter(row => row.count > 0);
    const boxes = deliveries.flatMap(({ participant, count, granted }) => Array.from({ length: count }, (_, ordinal) => ({
      id: randomUUID(), raceId, participantId: participant.id, userId: participant.userId,
      type: null, rarity: null, status: 'MYSTERY_BOX', earnedAtSteps: granted+ordinal,
    })));
    if (boxes.length) {
      await tx.racePowerup.createMany({ data: boxes });
      await participantsChanged(boxes.map(row => row.participantId));
      await tx.$executeRawUnsafe(`
        UPDATE onboarding_box_grant g SET granted_box_count=g.granted_box_count+d.count
          FROM jsonb_to_recordset($1::jsonb) AS d(hash text,count int)
         WHERE g.apple_sub_hash=d.hash`, JSON.stringify(deliveries.map(({hash,count}) => ({hash,count}))));
    }
    return { changed: boxes.length > 0, userIds: [...new Set(boxes.map(row => row.userId))],
      events: boxes.map(row => ({ raceId, userId: row.userId, powerupId: row.id })) };
  }
  return { processRace };
}
module.exports = { buildSeededChallengeWelcome };
