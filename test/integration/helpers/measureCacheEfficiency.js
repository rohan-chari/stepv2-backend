// Standalone local measurement harness: real HTTP + PostgreSQL query events +
// Redis commandstats. It never imports a query/command/cache implementation.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const IORedis = require('ioredis');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
assert.ok(process.env.REDIS_TEST_URL);
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_TEST_URL).hostname));
process.env.REDIS_URL = process.env.REDIS_TEST_URL;
process.env.CACHE_ENV_PREFIX = 't:ce-measure:';
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const root = path.resolve(process.env.CACHE_TEST_BACKEND_ROOT || process.cwd());
// Initialize safe local SQL telemetry before constructing the real production-mode handlers.
process.env.NODE_ENV = 'test';
require(path.join(root, 'src/db'));
process.env.NODE_ENV = 'production';
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require(path.join(root, 'test/integration/setup'));
const redis = new IORedis(process.env.REDIS_URL);
const records = [], observed = [];
prisma.$on('query', event => observed.push(event));
function commandCounts(info) {
  return Object.fromEntries([...info.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)].filter(match => match[1] !== 'info').map(match => [match[1], Number(match[2])]));
}
async function clear() {
  await cleanDatabase();
  const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
  if (keys.length) await redis.del(...keys);
}
async function main() {
  for (const key of ['apiHomeShellV1Enabled', 'apiFriendsSummaryV1Enabled', 'apiRaceBootstrapV1Enabled', 'apiImpactSummariesEnabled',
    'redisCacheHomeImpactSummaryEnabled', 'redisCacheFriendsEnabled', 'redisPresentationGenerationGuardEnabled']) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
  }
  const server = await getSharedServer();
  async function measure(surface, route, user, features, verify) {
    for (const phase of ['cold', 'warm']) {
      const before = commandCounts(await redis.info('commandstats'));
      observed.length = 0;
      const at = performance.now();
      const response = await request(server.baseUrl, 'GET', route, { token: user.token, headers: { 'X-Client-Features': features || '' } });
      const body = await response.json();
      const durationMs = performance.now() - at;
      const sql = [...observed];
      const after = commandCounts(await redis.info('commandstats'));
      assert.equal(response.status, 200, JSON.stringify(body));
      verify(body);
      const redisCommands = Object.fromEntries(Object.entries(after).map(([key, count]) => [key, count - (before[key] || 0)]).filter(([, count]) => count));
      const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
      let payloadBytes = 0;
      for (const key of keys) if (!key.includes(':g:') && await redis.type(key) === 'string') payloadBytes += await redis.strlen(key);
      records.push({ surface, phase, response: body, sqlStatements: sql.length, sqlSelects: sql.filter(row => /^\s*(?:SELECT|WITH|\/\*)/i.test(row.query)).length,
        sqlWrites: sql.filter(row => /^\s*(?:INSERT|UPDATE|DELETE)/i.test(row.query)).length,
        redisCommands, redisExecutions: Object.values(redisCommands).reduce((a, b) => a + b, 0),
        responseBytes: Buffer.byteLength(JSON.stringify(body)), retainedPayloadBytes: payloadBytes, durationMs: Number(durationMs.toFixed(2)) });
    }
  }
  await clear();
  let user = await createTestUser({ displayName: 'SummaryMeasure' });
  await measure('empty-summary', '/home/race-card', user, 'impact_summaries,impact_summary_expiry_v1', body => assert.equal(body.globalEventSummary, undefined));
  await clear();
  user = await createTestUser({ displayName: 'EquipmentMeasure' });
  const friend = await createTestUser({ displayName: 'FriendMeasure' });
  await prisma.friendship.create({ data: { requesterId: user.user.id, addresseeId: friend.user.id, status: 'ACCEPTED' } });
  const item = await prisma.shopItem.create({ data: { sku: `measure-${Date.now()}`, name: 'Measure Hat', slot: 'HEAD', assetKey: 'measure_hat', priceCoins: 1 } });
  await prisma.userEquippedAccessory.create({ data: { userId: user.user.id, shopItemId: item.id, slot: 'HEAD' } });
  await measure('home-equipment-and-friends', '/home/race-card?view=shell-v1', user, 'home_shell_v1,characters', body => assert.equal(body.presentation.equipped.HEAD.name, 'Measure Hat'));
  // Clear only cache so the standalone Friends cold read starts independently.
  const friendKeys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`); if (friendKeys.length) await redis.del(...friendKeys);
  await measure('friends', '/friends?view=summary-v1', user, '', body => assert.equal(body.friends.length, 1));
  await clear();
  user = await createTestUser({ displayName: 'InviterMeasure' });
  const invited = await createTestUser({ displayName: 'InvitedMeasure' });
  let race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Invitation Measure', targetSteps: 500000, status: 'PENDING',
    participants: { create: [{ userId: user.user.id, status: 'ACCEPTED' }, { userId: invited.user.id, status: 'INVITED', inviteExpiresAt: new Date(Date.now() + 3600000) }] } } });
  await measure('pending-invite-with-metadata-counts', '/home/race-card', invited, '', body => assert.equal(body.state, 'PENDING_INVITE'));
  await measure('race-list', '/races', user, '', body => assert.equal(body.pending[0].id, race.id));
  await clear();
  user = await createTestUser({ displayName: 'EventMeasure' });
  race = await prisma.race.create({ data: { creatorId: user.user.id, name: 'Event Measure', targetSteps: 500000, status: 'ACTIVE',
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
    participants: { create: { userId: user.user.id, status: 'ACCEPTED' } } } });
  await prisma.globalStepEvent.create({ data: { startsAt: new Date(Date.now() - 10000), endsAt: new Date(Date.now() + 3600000), multiplier: 2 } });
  await measure('race-event-display', `/races/${race.id}/progress`, user, '', body => assert.equal(body.progress.globalEvent.multiplier, 2));
  await measure('race-bootstrap', `/races/${race.id}/bootstrap`, user, '', body => assert.equal(body.race.name, 'Event Measure'));
  const target = process.env.CACHE_TEST_EVIDENCE_PATH;
  assert.ok(target, 'explicit output path required');
  await fs.writeFile(target, JSON.stringify({ backendRoot: root, database: database.pathname.slice(1), measuredAt: new Date().toISOString(), records }, null, 2));
  console.log(`Measured ${records.length} cold/warm HTTP requests`);
}
main().then(async () => { await redis.quit(); await prisma.$disconnect(); process.exit(0); }, async error => {
  console.error(error); await redis.quit(); await prisma.$disconnect(); process.exit(1);
});
