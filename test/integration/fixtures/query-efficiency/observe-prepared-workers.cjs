// Observation only: no SQL, results, timing, or worker scheduling is replaced.
const { Client } = require('pg');
const events = [];
function family(sql) {
  if (sql.includes('WITH candidate AS') && sql.includes('UPDATE race_resolution_jobs_v2 j')) return 'resolution-claim';
  if (sql.includes('WITH candidate AS') && sql.includes('UPDATE race_placement_transition_jobs p')) return 'placement-claim';
  if (sql.includes('SELECT LEAST(') && sql.includes('race_placement_transition_jobs p')) return 'placement-due';
  if (sql.includes('WITH candidate_ids AS MATERIALIZED') && sql.includes('UPDATE race_resolution_post_tasks task')) return 'post-task-claim';
  if (sql.includes('SELECT DISTINCT ON (requested."userId")') && sql.includes('global_step_event_entitlements')) return 'active-event-read';
  return null;
}
const original = Client.prototype.query;
Client.prototype.query = function (config, ...args) {
  const sql = typeof config === 'string' ? config : config?.text || '';
  const selected = family(sql);
  if (selected) {
    const event = { family: selected, query: sql, name: config?.name || null,
      values: config?.values || args[0] || [], backendPid: this.processID };
    events.push(event);
    if (process.send) process.send(event);
  }
  return original.call(this, config, ...args);
};
module.exports = { events, family };
