const { createHash } = require('node:crypto');

// Only explicitly selected, parameterized reads and queue queries are prepared.
// PgBouncer transaction pools MUST enable max_prepared_statements before this
// code is deployed. SQL comments are permanent query annotations, not flags.
const PREFIX = '/* steps:prepared-read:v1 */';
const QUEUE_PREFIX = '/* steps:prepared-query:v1 */';
const MAX_STATEMENTS = 128;

function installPreparedReadQueries(pool) {
  // A fixed admission budget also bounds node-postgres's per-connection parsed
  // statement map. Do not evict/re-admit names: that map cannot be LRU-evicted
  // safely through a transaction pool. Overflow runs normally, unnamed.
  const names = new Map();
  pool.on('connect', (client) => {
    const ownQuery = Object.hasOwn(client, 'query') ? client.query : null;
    const prototype = Object.getPrototypeOf(client);
    client.query = (config, ...args) => {
      if (config && typeof config === 'object' && !config.name &&
          typeof config.text === 'string' && (config.text.startsWith(PREFIX) || config.text.startsWith(QUEUE_PREFIX))) {
        let name = names.get(config.text);
        if (!name && names.size < MAX_STATEMENTS) {
          name = (config.text.startsWith(PREFIX) ? 'steps_read_v1_' : 'steps_query_v1_') + createHash('sha256')
            .update(config.text).digest('hex').slice(0, 48);
          names.set(config.text, name);
        }
        if (name) config = { ...config, name };
      }
      // Preserve all adapter parsing options and overload arguments. Never
      // retry here: a failed transaction belongs to its existing caller.
      return (ownQuery || prototype.query).call(client, config, ...args);
    };
  });
}

module.exports = { installPreparedReadQueries };
