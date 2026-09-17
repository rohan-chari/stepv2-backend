const LEASE_MS = 30000;
const PAGE_SIZE = 100;

function buildHistoricalRaceDiscoveryCursorModel(prisma) {
  return {
    async upsert({ userId, changedStart, changedEnd, sourceGeneration, cursor = null, now = new Date() }, tx = prisma) {
      await tx.$queryRawUnsafe(
        `INSERT INTO historical_race_discovery_cursors
          (id,user_id,changed_start,changed_end,requested_source_generation,cursor_race_id,cursor_participant_id,status,available_at,created_at,updated_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'queued',$7,$7,$7)
         ON CONFLICT (user_id) DO UPDATE SET
          changed_start=LEAST(historical_race_discovery_cursors.changed_start,EXCLUDED.changed_start),
          changed_end=GREATEST(historical_race_discovery_cursors.changed_end,EXCLUDED.changed_end),
          requested_source_generation=GREATEST(historical_race_discovery_cursors.requested_source_generation,EXCLUDED.requested_source_generation),
          status=CASE WHEN historical_race_discovery_cursors.status='running' THEN 'running'::"HistoricalRaceReconciliationState" ELSE 'queued'::"HistoricalRaceReconciliationState" END,
          available_at=LEAST(historical_race_discovery_cursors.available_at,EXCLUDED.available_at),
          cursor_race_id=CASE WHEN historical_race_discovery_cursors.requested_source_generation <= EXCLUDED.requested_source_generation THEN EXCLUDED.cursor_race_id ELSE historical_race_discovery_cursors.cursor_race_id END,
          cursor_participant_id=CASE WHEN historical_race_discovery_cursors.requested_source_generation <= EXCLUDED.requested_source_generation THEN EXCLUDED.cursor_participant_id ELSE historical_race_discovery_cursors.cursor_participant_id END,
          updated_at=$7`, userId, changedStart, changedEnd, String(sourceGeneration), cursor?.raceId || null, cursor?.participantId || null, now);
    },
    async claim(now = new Date()) {
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `WITH candidate AS (
             SELECT id FROM historical_race_discovery_cursors
              WHERE (status='queued' OR (status='running' AND lease_expires_at <= $1))
                AND available_at <= $1
              ORDER BY available_at,user_id LIMIT 1 FOR UPDATE SKIP LOCKED
           ) UPDATE historical_race_discovery_cursors c
              SET status='running',lease_token=gen_random_uuid(),lease_expires_at=$2,attempt_count=attempt_count+1,updated_at=$1
             FROM candidate WHERE c.id=candidate.id RETURNING c.*`, now, new Date(now.getTime() + LEASE_MS));
        return rows[0] || null;
      });
    },
    async advance(row, nextCursor, exhausted, now = new Date()) {
      await prisma.$queryRawUnsafe(
        `UPDATE historical_race_discovery_cursors SET
          cursor_race_id=$3,cursor_participant_id=$4,
          status=CASE WHEN $5::boolean THEN 'succeeded'::"HistoricalRaceReconciliationState" ELSE 'queued'::"HistoricalRaceReconciliationState" END,
          lease_token=NULL,lease_expires_at=NULL,updated_at=$2
         WHERE id=$1 AND lease_token=$6`, row.id, now, nextCursor?.raceId || null, nextCursor?.participantId || null, exhausted, row.lease_token);
    },
  };
}

module.exports = { PAGE_SIZE, buildHistoricalRaceDiscoveryCursorModel };
