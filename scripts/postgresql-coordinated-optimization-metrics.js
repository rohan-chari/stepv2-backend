#!/usr/bin/env node

const fs = require("node:fs");
const { Pool } = require("pg");

function parseArgs(argv) {
  return Object.fromEntries(argv.flatMap((value, index) =>
    value.startsWith("--") ? [[value.slice(2), argv[index + 1]]] : []));
}

const DELTA_FIELDS = [
  "calls", "total_exec_time", "rows", "shared_blks_hit", "shared_blks_read",
  "wal_bytes",
];

function buildIntervalStatements(previousArtifact, currentSnapshot, capturedAt, pgssInfo) {
  const previousSnapshot = previousArtifact?.statementSnapshot;
  if (!Array.isArray(previousSnapshot)) {
    throw new Error("baseline evidence has no raw pg_stat_statements snapshot");
  }
  const previousReset = previousArtifact.pgStatStatements?.statsResetAt || null;
  const currentReset = pgssInfo?.statsResetAt || null;
  if (!previousReset || !currentReset || previousReset !== currentReset) {
    throw new Error("pg_stat_statements reset window changed between snapshots");
  }
  const previousDealloc = Number(previousArtifact.pgStatStatements?.dealloc || 0);
  const currentDealloc = Number(pgssInfo?.dealloc || 0);
  if (currentDealloc !== previousDealloc) {
    throw new Error("pg_stat_statements entries were deallocated between snapshots");
  }
  const startedAt = new Date(previousArtifact.capturedAt);
  const endedAt = new Date(capturedAt);
  const elapsedSeconds = (endedAt - startedAt) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    throw new Error("baseline snapshot must precede the current snapshot");
  }
  const previousById = new Map(previousSnapshot.map((row) => [String(row.queryid), row]));
  return {
    elapsedSeconds,
    statements: currentSnapshot.flatMap((row) => {
      const prior = previousById.get(String(row.queryid));
      if (!prior) return [];
      const delta = Object.fromEntries(DELTA_FIELDS.map((field) => {
        const value = Number(row[field]) - Number(prior[field]);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`invalid pg_stat_statements delta for ${row.queryid}:${field}`);
        }
        return [field, value];
      }));
      if (delta.calls === 0) return [];
      return [{
        queryid: String(row.queryid),
        calls: delta.calls,
        callsPerSecond: delta.calls / elapsedSeconds,
        total_exec_time: delta.total_exec_time,
        mean_exec_time: delta.total_exec_time / delta.calls,
        rows: delta.rows,
        shared_blks_hit: delta.shared_blks_hit,
        shared_blks_read: delta.shared_blks_read,
        wal_bytes: String(delta.wal_bytes),
        normalizedQuery: row.query,
      }];
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.output) throw new Error("--output is required");
  if (fs.existsSync(args.output)) throw new Error("output already exists");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout='10s'");
      // A pg Client owns one connection. Keep these reads sequential so the
      // evidence collector never pipelines queries on an already-busy client
      // (pg 9 removes that deprecated behavior).
      const database = await client.query(`SELECT current_database() AS database,now() AS captured_at,
          (SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()) AS stats_reset`);
      const statements = await client.query(`SELECT queryid::text,calls,total_exec_time,mean_exec_time,rows,
          shared_blks_hit,shared_blks_read,wal_bytes::text,query
          FROM pg_stat_statements
          WHERE query ~* '(race_resolution|race_placement|domain_event|notification_schedule|inbox_delivery|global_event_summary|step_samples)'
          ORDER BY total_exec_time DESC LIMIT 100`).catch(() => ({ rows: [] }));
      const pgss = await client.query(`SELECT stats_reset,dealloc FROM pg_stat_statements_info`)
        .catch(() => ({ rows: [] }));
      const queues = await client.query(`SELECT * FROM (
          SELECT 'race_resolution_jobs_v2' AS queue,status,COUNT(*)::bigint AS rows FROM race_resolution_jobs_v2 GROUP BY status
          UNION ALL SELECT 'race_placement_transition_jobs',state,COUNT(*) FROM race_placement_transition_jobs GROUP BY state
          UNION ALL SELECT 'race_resolution_post_tasks',state,COUNT(*) FROM race_resolution_post_tasks GROUP BY state
          UNION ALL SELECT 'domain_event_outbox',status,COUNT(*) FROM domain_event_outbox GROUP BY status
          UNION ALL SELECT 'notification_schedules',status,COUNT(*) FROM notification_schedules GROUP BY status
          UNION ALL SELECT 'inbox_delivery_outbox',status,COUNT(*) FROM inbox_delivery_outbox GROUP BY status
          UNION ALL SELECT 'global_event_summary_work',status,COUNT(*) FROM global_event_summary_work GROUP BY status
        ) queues ORDER BY queue,status`);
      const tables = await client.query(`SELECT relname,n_live_tup,n_dead_tup,n_tup_ins,n_tup_upd,n_tup_hot_upd,n_tup_del,
          seq_scan,seq_tup_read,idx_scan,last_autovacuum,autovacuum_count
          FROM pg_stat_user_tables
          WHERE relname ~ '(race_resolution|race_placement|domain_event|notification_schedule|inbox_delivery|global_event_summary)'
          ORDER BY relname`);
      const provisionals = await client.query(`SELECT COUNT(*)::bigint AS count,
          EXTRACT(EPOCH FROM (now()-MIN(created_at)))::float8 AS oldest_seconds
          FROM domain_event_receipts WHERE receipt_state='PROVISIONAL'`);
      await client.query("COMMIT");
      const capturedAt = new Date(database.rows[0].captured_at);
      const resetAt = database.rows[0].stats_reset && new Date(database.rows[0].stats_reset);
      const pgssInfo = pgss.rows[0] ? {
        statsResetAt: new Date(pgss.rows[0].stats_reset).toISOString(),
        dealloc: Number(pgss.rows[0].dealloc),
      } : null;
      const statementSnapshot = statements.rows.map((row) => ({
        ...row,
        calls: Number(row.calls),
      }));
      const baseline = args.baseline
        ? JSON.parse(fs.readFileSync(args.baseline, "utf8"))
        : null;
      const interval = baseline
        ? buildIntervalStatements(baseline, statementSnapshot, capturedAt, pgssInfo)
        : null;
      const artifact = {
        schema: "postgresql-coordinated-optimization-evidence-v2",
        capturedAt: capturedAt.toISOString(),
        statsResetAt: resetAt?.toISOString() || null,
        pgStatStatements: pgssInfo,
        intervalStartedAt: baseline?.capturedAt || null,
        intervalSeconds: interval?.elapsedSeconds || null,
        statements: interval?.statements || [],
        statementSnapshot,
        queues: queues.rows,
        tables: tables.rows,
        provisionalReceipts: provisionals.rows[0],
        ...(args["runtime-evidence"] ? {
          runtimeEvidence: JSON.parse(fs.readFileSync(args["runtime-evidence"], "utf8")),
        } : {}),
      };
      fs.writeFileSync(args.output, `${JSON.stringify(artifact, null, 2)}\n`, {
        mode: 0o600, flag: "wx",
      });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildIntervalStatements };
