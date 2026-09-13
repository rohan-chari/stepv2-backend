require('./adminRedisFixture.cjs');
const assert = require('node:assert/strict');
const { before, after, it } = require('node:test');
const { cleanDatabase, createTestUser, startServer, request } = require('./setup');
const { appSettings } = require('../../src/shared/config/appSettings');
const { pool } = require('../../src/db');
let faulty, peer, admin;
let slowQueries = 0;
let failExtraction = false;
const events = [];
before(async () => {
  await cleanDatabase();
  await appSettings.setFlag('adminMetricsV2DashboardEnabled', true);
  await appSettings.setFlag('adminMetricsV2TelemetryEnabled', false);
  admin = await createTestUser({ email: 'admin@test.com' });
  const faultPool = { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, key) {
      if (key === 'query') return (sql, ...args) => {
        if (typeof sql === 'string' && (sql.startsWith('DECLARE admin_page_0 NO SCROLL CURSOR FOR SELECT rp.user_id,rp.joined_at occurred_at') ||
            (failExtraction && sql.startsWith('SELECT id,is_review_account')))) {
          slowQueries++;
          return target.query('SELECT pg_sleep(10)');
        }
        return target.query(sql, ...args);
      };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  faulty = await startServer({ pool: faultPool });
  peer = await startServer({ adminAnalyticsObserver: e => events.push(e) });
});
after(async () => { await faulty?.close(); await peer?.close(); });
const get = (server, section, window = '7d') => request(server.baseUrl, 'GET', `/admin/stats?sections=${section}&window=${window}`, { token: admin.token });
it('a timed-out Activity section backs off across workers without blocking uncached Ads or Growth', async () => {
  assert.equal((await get(faulty, 'dashboard-dau-engagement')).status, 503);
  assert.equal(slowQueries, 1);
  assert.equal((await get(peer, 'dashboard-revenue')).status, 200);
  assert.equal((await get(peer, 'ads')).status, 200);
  assert.equal((await get(peer, 'dashboard-growth')).status, 200);
  const before = events.filter(e => e.event === 'query').length;
  assert.equal((await get(peer, 'dashboard-dau-engagement')).status, 503);
  assert.equal((await get(peer, 'dashboard-dau-engagement', '30d')).status, 503);
  assert.equal(events.filter(e => e.event === 'query').length, before);
  assert.equal(slowQueries, 1);
});

it('a shared extraction timeout still prevents other sections from starting database work', async () => {
  failExtraction = true;
  try {
    assert.equal((await get(faulty, 'dashboard-growth')).status, 503);
    const before = events.filter(e => e.event === 'query').length;
    assert.equal((await get(peer, 'ads')).status, 503);
    assert.equal((await get(peer, 'dashboard-summary')).status, 503);
    assert.equal(events.filter(e => e.event === 'query').length, before);
  } finally { failExtraction = false; }
});
