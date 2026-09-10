// Test-only protocol observation. Uses synthetic fixtures; never installed by an app entrypoint.
const { Client } = require('pg');
const original = Client.prototype.query;
function family(sql) {
  if (sql.includes('display_boundary_proof')) return 'display-boundary';
  if (sql.includes('WITH failures AS') && sql.includes('UPDATE race_resolution_post_tasks task')) return 'post-task-finish';
  if (sql.includes('AS "oldestPendingLagMs"')) return 'post-task-readiness';
  if (sql.includes('SELECT LEAST(') && sql.includes('durable_capture_compaction_schedule')) return 'summary-due';
  if (sql.includes('category_rank') && sql.includes('FROM tournaments t')) return 'tournament-discovery';
  if (sql.includes('WITH eligible AS MATERIALIZED') && sql.includes('FROM eligible r LEFT JOIN counts')) return 'race-discovery';
  if (sql.includes('AS "viewerAccepted"') && sql.includes('AS "hasLiveRematch"')) return 'viewer-overlay';
  if (sql.includes('WITH candidates AS MATERIALIZED') && sql.includes('FROM race_resolution_full_triggers trigger')) return 'full-trigger-drain';
  if (sql.includes("SELECT 'WELCOME' AS operation")) return 'seeded-preparation';
  if (sql.includes('WITH due AS (SELECT task_id FROM race_snapshot_repair_intents')) return 'snapshot-repair-claim';
  if (sql.includes('SELECT DISTINCT ON (requested."userId")') && sql.includes('global_step_event_entitlements')) return 'active-event-read';
  return null;
}
const events = [];
const persisted = new Set();
Client.prototype.query = function(config, ...args) {
  const sql = typeof config === 'string' ? config : config?.text || '';
  const selected = family(sql);
  if (selected) {
    const event = { kind: 'cpu-query', family: selected, query: sql, values: config?.values || args[0] || [], name: config?.name || null, backendPid: this.processID };
    if(events.length>=4096)throw new Error('CPU test observation exceeded its4096-query budget');
    events.push(event);
    if (process.env.CPU_ALL_QUERY_EVIDENCE && !persisted.has(sql) && persisted.size < 128) {
      persisted.add(sql);
      require('node:fs').appendFileSync(process.env.CPU_ALL_QUERY_EVIDENCE,JSON.stringify(event)+'\n');
    }
    process.send?.(event);
  }
  return original.call(this, config, ...args);
};
module.exports = { events, family };

if (process.env.CPU_ALL_QUERY_EVIDENCE) {
  const target=new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1','localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('test-only observation requires a local test database');
}
