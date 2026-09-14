// Test-only external monitoring fixture and accelerated maintenance clock.
// The production entrypoint, scheduler, budget SQL and deletion SQL run unchanged.
const assert = require('node:assert/strict');
const target = new URL(process.env.DATABASE_URL);
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(['localhost', '127.0.0.1'].includes(target.hostname));
assert.match(target.pathname, /_test$/);
const pg = require('pg');
const OriginalPool = pg.Pool;
pg.Pool = class extends OriginalPool {
  constructor(options) {
    super({ ...options, options: `${options.options || ''} -c search_path=cleanup_fixture,pg_catalog,public` });
  }
};
const interval = global.setInterval;
global.setInterval = (callback, ms, ...args) => interval(callback, ms === 600000 ? 100 : ms, ...args);
const { prisma } = require('../../../../src/db');
prisma.$on('query', (event) => {
  if (event.query.includes('pg_stat_replication') || event.query.includes('DELETE FROM race_resolution_post_tasks task')) {
    process.send?.({ kind: 'query', query: event.query, duration: event.duration });
  }
});
