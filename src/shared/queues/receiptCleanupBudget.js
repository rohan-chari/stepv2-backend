const PAGE_WAL_LIMIT_BYTES = 16 * 1024 * 1024;
const RUN_WAL_LIMIT_BYTES = 64 * 1024 * 1024;
const PAGE_DURATION_LIMIT_MS = 500;
const REPLICA_LAG_LIMIT_SECONDS = 5;

function createReceiptCleanupBudget({
  prisma = null,
  snapshot = null,
  walBytesBetween = null,
  nowMs = () => Number(process.hrtime.bigint()) / 1e6,
} = {}) {
  const readSnapshot = snapshot || (async () => {
    const [row] = await prisma.$queryRawUnsafe(
      `WITH receivers AS MATERIALIZED (
         SELECT state,sent_lsn,replay_lsn,replay_lag,reply_time, COALESCE(
           application_name='pghoard' AND replay_lsn IS NULL
           AND state='streaming' AND sent_lsn IS NOT NULL
           AND write_lsn IS NOT NULL AND flush_lsn IS NOT NULL
           AND reply_time >= statement_timestamp()-INTERVAL '30 seconds',
           false
         ) AS backup_receiver
         FROM pg_stat_replication
       )
       SELECT pg_current_wal_lsn()::text AS lsn,
         COALESCE(MAX(EXTRACT(EPOCH FROM replay_lag))
           FILTER (WHERE NOT backup_receiver),0)::float8 AS "replicaLagSeconds",
         COALESCE(BOOL_OR(NOT backup_receiver AND COALESCE(
           state<>'streaming' OR replay_lsn IS NULL OR sent_lsn IS NULL
           OR reply_time IS NULL
           OR reply_time < statement_timestamp()-INTERVAL '30 seconds'
           OR (replay_lag IS NULL AND replay_lsn IS DISTINCT FROM sent_lsn),
           true
         )),false) AS "replicationEvidenceUnavailable"
       FROM receivers`,
    );
    // A live PGHoard WAL archiver does not replay into a standby database.
    // Do not bypass unknown/nonresponsive receivers or a PGHoard-named sender
    // that actually reports a replay position. An idle, caught-up standby may
    // legitimately report NULL replay_lag; a behind/unknown standby may not.
    if (!row || typeof row.lsn !== "string" || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(row.lsn) ||
        !Number.isFinite(row.replicaLagSeconds) || row.replicaLagSeconds < 0 ||
        row.replicationEvidenceUnavailable !== false) {
      throw new Error("Cleanup replication evidence unavailable");
    }
    return row;
  });
  const diffWal = walBytesBetween || (async (after, before) => {
    const [row = {}] = await prisma.$queryRawUnsafe(
      "SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::bigint AS bytes",
      after,
      before,
    );
    return Number(row.bytes || 0);
  });
  let totalWalBytes = 0;
  let stopped = false;
  return {
    async runPage(operation) {
      if (stopped) return { rows: 0, allowedContinue: false, stopped: true, totalWalBytes };
      let before;
      try {
        before = await readSnapshot();
      } catch {
        stopped = true;
        return { rows: 0, allowedContinue: false, evidenceUnavailable: true };
      }
      if (Number(before.replicaLagSeconds || 0) > REPLICA_LAG_LIMIT_SECONDS) {
        stopped = true;
        return {
          rows: 0, allowedContinue: false, replicaLagSeconds: Number(before.replicaLagSeconds),
          totalWalBytes,
        };
      }
      const startedAt = nowMs();
      const rows = Number(await operation()) || 0;
      const durationMs = Math.max(0, nowMs() - startedAt);
      let after;
      let walBytes;
      try {
        after = await readSnapshot();
        walBytes = await diffWal(after.lsn, before.lsn);
      } catch {
        stopped = true;
        return { rows, allowedContinue: false, durationMs, totalWalBytes, evidenceUnavailable: true };
      }
      totalWalBytes += walBytes;
      const replicaLagSeconds = Number(after.replicaLagSeconds || 0);
      const allowedContinue = durationMs <= PAGE_DURATION_LIMIT_MS &&
        walBytes <= PAGE_WAL_LIMIT_BYTES && totalWalBytes <= RUN_WAL_LIMIT_BYTES &&
        replicaLagSeconds <= REPLICA_LAG_LIMIT_SECONDS;
      if (!allowedContinue) stopped = true;
      return {
        rows,
        allowedContinue,
        durationMs,
        walBytes,
        totalWalBytes,
        replicaLagSeconds,
      };
    },
  };
}

module.exports = {
  PAGE_WAL_LIMIT_BYTES,
  RUN_WAL_LIMIT_BYTES,
  PAGE_DURATION_LIMIT_MS,
  REPLICA_LAG_LIMIT_SECONDS,
  createReceiptCleanupBudget,
};
