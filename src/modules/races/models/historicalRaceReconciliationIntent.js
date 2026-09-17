const LEASE_MS = 30000;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 100;

function buildHistoricalRaceReconciliationIntentModel(prisma) {
  return {
    async admitMany({ rows, changedStart, changedEnd, sourceGeneration, now = new Date() }, tx = prisma) {
      const unique = new Map();
      for (const row of rows || []) {
        if (row?.raceId && row?.userId) unique.set(`${row.raceId}:${row.userId}`, row);
      }
      if (!unique.size) return { created: 0, coalesced: 0 };
      const payload = [...unique.values()].map((row) => ({
        raceId: row.raceId, userId: row.userId, scopeKind: row.scopeKind || "PARTICIPANT",
      }));
      const result = await tx.$queryRawUnsafe(
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb)
             AS x("raceId" text,"userId" text,"scopeKind" text)
         ), inserted AS (
           INSERT INTO historical_race_reconciliation_intents
           (id,race_id,user_id,scope_kind,changed_start,changed_end,requested_source_generation,phase2_eligible,status,available_at,created_at,updated_at)
           SELECT gen_random_uuid(),"raceId","userId",COALESCE("scopeKind",'PARTICIPANT'),$2,$3,$4,true,'queued', $5,$5,$5
             FROM incoming
           ON CONFLICT (race_id,user_id) DO UPDATE SET
             scope_kind=CASE WHEN historical_race_reconciliation_intents.scope_kind='RACE' OR EXCLUDED.scope_kind='RACE' THEN 'RACE' ELSE historical_race_reconciliation_intents.scope_kind END,
             changed_start=LEAST(historical_race_reconciliation_intents.changed_start,EXCLUDED.changed_start),
             changed_end=GREATEST(historical_race_reconciliation_intents.changed_end,EXCLUDED.changed_end),
             requested_source_generation=GREATEST(historical_race_reconciliation_intents.requested_source_generation,EXCLUDED.requested_source_generation),
             phase2_eligible=true,
             status=CASE WHEN historical_race_reconciliation_intents.status='running' THEN 'running'::"HistoricalRaceReconciliationState" ELSE 'queued'::"HistoricalRaceReconciliationState" END,
             available_at=LEAST(historical_race_reconciliation_intents.available_at,EXCLUDED.available_at),
             last_error_code=NULL, terminal_at=NULL, updated_at=$5
           RETURNING (xmax=0) AS was_inserted
         ) SELECT COUNT(*) FILTER (WHERE was_inserted)::int AS created, COUNT(*) FILTER (WHERE NOT was_inserted)::int AS coalesced FROM inserted`,
        JSON.stringify(payload), changedStart, changedEnd, BigInt(sourceGeneration), now,
      );
      return result[0] || { created: 0, coalesced: 0 };
    },
    async claimBatch({ now = new Date(), limit = BATCH_SIZE } = {}) {
      const bounded = Math.max(1, Math.min(BATCH_SIZE, Number(limit) || BATCH_SIZE));
      return prisma.$transaction(async (tx) => tx.$queryRawUnsafe(
        `WITH candidates AS (
         SELECT historical_race_reconciliation_intents.id FROM historical_race_reconciliation_intents
           JOIN races r ON r.id=historical_race_reconciliation_intents.race_id
           WHERE historical_race_reconciliation_intents.phase2_eligible=true
             AND r.status='completed'
             AND (historical_race_reconciliation_intents.status='queued' OR (historical_race_reconciliation_intents.status='running' AND historical_race_reconciliation_intents.lease_expires_at <= $1))
             AND historical_race_reconciliation_intents.available_at <= $1 AND historical_race_reconciliation_intents.attempt_count < $3
           ORDER BY historical_race_reconciliation_intents.available_at,historical_race_reconciliation_intents.id LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE historical_race_reconciliation_intents i
            SET status='running', lease_token=gen_random_uuid(), lease_expires_at=$4,
                attempt_count=attempt_count+1, updated_at=$1
           FROM candidates c WHERE i.id=c.id
         RETURNING i.*`, now, bounded, MAX_ATTEMPTS, new Date(now.getTime() + LEASE_MS)), { timeout: 15000, maxWait: 10000 });
    },
    async acknowledgeDryRun({ id, leaseToken, claimedGeneration, now = new Date() }, tx = prisma) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE historical_race_reconciliation_intents
            SET status=CASE WHEN requested_source_generation > $3 THEN 'queued'::"HistoricalRaceReconciliationState" ELSE 'succeeded'::"HistoricalRaceReconciliationState" END,
                terminal_at=CASE WHEN requested_source_generation > $3 THEN NULL::timestamp ELSE $4 END,
                lease_token=NULL, lease_expires_at=NULL, updated_at=$4
          WHERE id=$1 AND lease_token=$2 RETURNING status`, id, leaseToken, BigInt(claimedGeneration), now);
      return rows[0] || null;
    },
    async lockClaimed({ id, leaseToken, claimedGeneration }, tx = prisma) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT *
           FROM historical_race_reconciliation_intents
          WHERE id=$1 AND lease_token=$2
            AND status='running'
            AND requested_source_generation=$3
          FOR UPDATE`,
        id, leaseToken, BigInt(claimedGeneration),
      );
      return rows[0] || null;
    },
    async releaseForRetry({ id, leaseToken, now = new Date(), errorCode = "RETRY" }, tx = prisma) {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE historical_race_reconciliation_intents
            SET status=CASE WHEN attempt_count >= $5 THEN 'failed'::"HistoricalRaceReconciliationState" ELSE 'queued'::"HistoricalRaceReconciliationState" END,
                available_at=$3::timestamp,
                lease_token=NULL,
                lease_expires_at=NULL,
                last_error_code=$4,
                terminal_at=CASE WHEN attempt_count >= $5::int THEN $3::timestamp ELSE NULL::timestamp END,
                updated_at=$3::timestamp
          WHERE id=$1 AND lease_token=$2 AND status='running'
          RETURNING id`,
        id, leaseToken, now, String(errorCode).slice(0, 128), MAX_ATTEMPTS,
      );
      return rows[0] || null;
    },
  };
}

module.exports = { LEASE_MS, MAX_ATTEMPTS, BATCH_SIZE, buildHistoricalRaceReconciliationIntentModel };
