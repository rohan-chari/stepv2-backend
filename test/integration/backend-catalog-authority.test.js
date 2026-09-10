const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const IORedis = require('ioredis');
const { startTestRedis } = require('./redisTestServer');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
process.env.CACHE_ENV_PREFIX = 't:backend-catalog-authority:';
delete process.env.REDIS_URL;
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require('./setup');
// Cache connection setup only; all behavior assertions use the public HTTP path.
const cache = require('../../src/shared/cache/redisCache');
const { appSettings } = require('../../src/shared/config/appSettings');
let server, live, redis;
const CURRENT = { 'X-Client-Features': 'characters,powerups3,powerups4,powerups5,powerup_stacking_guide_v1' };
const LEGACY = { 'X-Client-Features': 'characters' };
async function get(user, path, headers = CURRENT) {
  const response = await request(server.baseUrl, 'GET', path, { token: user.token, headers });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}
async function fixture() {
  const alice = await createTestUser({ displayName: 'Catalog Alice' });
  const bob = await createTestUser({ displayName: 'Catalog Bob' });
  const race = await prisma.race.create({ data: {
    creatorId: alice.user.id, name: 'Backend authority', targetSteps: 500000,
    status: 'ACTIVE', startedAt: new Date(Date.now() - 3600000),
    endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000,
  } });
  const participants = [];
  for (const user of [alice, bob]) participants.push(await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.user.id, status: 'ACCEPTED', joinedAt: race.startedAt,
    nextBoxAtSteps: 5000, powerupSlots: 3,
  } }));
  return { alice, bob, race, participants };
}
async function item(f, owner, type, status = 'HELD', earnedAtSteps = 1000) {
  const participant = f.participants.find(p => p.userId === owner.user.id);
  return prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: participant.id,
    userId: owner.user.id, type, status, rarity: type === 'MYSTERY_BOX' ? null : 'RARE', earnedAtSteps } });
}
async function lucky(f, owner, status = 'ACTIVE') {
  const held = await item(f, owner, 'LUCKY_HORSESHOE');
  return prisma.raceActiveEffect.create({ data: {
    raceId: f.race.id, targetParticipantId: held.participantId, targetUserId: owner.user.id,
    sourceUserId: owner.user.id, powerupId: held.id, type: 'LUCKY_HORSESHOE', status,
    startsAt: new Date(), expiresAt: null, metadata: { minRarity: 'RARE' },
  } });
}
describe('backend catalog authority — real HTTP, Postgres and Redis', () => {
  before(async () => {
    live = await startTestRedis();
    assert.ok(live, 'A real local Redis is required for warm-cache coverage');
    assert.ok(['localhost', '127.0.0.1'].includes(new URL(live.url).hostname));
    process.env.REDIS_URL = live.url;
    await cache.close();
    redis = new IORedis(live.url);
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys);
    await appSettings.setFlag('redisStandingsEnabled', true);
  });
  after(async () => {
    await cache.close();
    await redis?.quit();
    await live?.close();
    delete process.env.REDIS_URL;
  });

  for (const [name, headers] of [['current', CURRENT], ['legacy', LEGACY]]) {
    it(`${name} projections hide retired held rows after cold and warm raw cache reads without mutating ownership`, async () => {
      const f = await fixture();
      const retired = await item(f, f.alice, 'IMPOSTER');
      const ordinary = await item(f, f.alice, 'PROTEIN_SHAKE', 'HELD', 2000);
      const box = await item(f, f.alice, 'MYSTERY_BOX', 'MYSTERY_BOX', 3000);
      await item(f, f.alice, 'MYSTERY_BOX', 'QUEUED', 4000);
      await prisma.userPowerupItem.createMany({ data: [
        { userId: f.alice.user.id, powerupType: 'IMPOSTER', quantity: 2 },
        { userId: f.alice.user.id, powerupType: 'CAMPFIRE_REST', quantity: 1 },
      ] });
      const slotKey = `${process.env.CACHE_ENV_PREFIX}ce:v1:slots:${f.race.id}:${f.alice.user.id}:${f.participants[0].id}`;
      for (const pass of ['cold', 'warm']) {
        const progress = (await get(f.alice, `/races/${f.race.id}/progress`, headers)).progress;
        assert.deepEqual(progress.powerupData.inventory.map(row => row.id), [ordinary.id, box.id], pass);
        assert.equal(progress.powerupData.powerupSlots, 3);
        assert.equal(progress.powerupData.queuedBoxCount, 1);
        const listing = await get(f.alice, '/races', headers);
        const summary = listing.active.find(row => row.id === f.race.id);
        assert.deepEqual(summary.slotItems.map(row => row.id), [ordinary.id, box.id], pass);
        assert.equal(summary.mysteryBoxCount, 1);
        const inventory = await get(f.alice, `/races/${f.race.id}/inventory`, headers);
        assert.deepEqual(inventory.inventory.map(row => row.id), [ordinary.id]);
        assert.deepEqual(inventory.mysteryBoxes, [{ id: box.id }]);
        const global = await get(f.alice, '/powerups/inventory', headers);
        assert.deepEqual(global.items, [{ powerupType: 'CAMPFIRE_REST', quantity: 1 }]);
        const rawCache = await redis.get(slotKey);
        assert.ok(rawCache, 'real slot cache is warm');
        assert.ok(rawCache.includes(retired.id), 'raw cache retains canonical rows; outgoing policy filters afterward');
      }
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: retired.id } })).status, 'HELD');
      assert.equal((await prisma.userPowerupItem.findUnique({ where: { userId_powerupType: { userId: f.alice.user.id, powerupType: 'IMPOSTER' } } })).quantity, 2);
    });
  }

  it('ordinary preview is true with complete unchanged ordinary odds and a real open result', async () => {
    const f = await fixture();
    const box = await item(f, f.alice, 'MYSTERY_BOX', 'MYSTERY_BOX');
    const first = (await get(f.alice, `/races/${f.race.id}/progress`)).progress;
    const odds = first.powerupData.dropOdds;
    assert.equal(odds.reelPreviewAvailable, true);
    assert.ok(Math.abs(Object.values(odds.byType).reduce((a, b) => a + b, 0) - 1) <= 1e-6);
    const warm = (await get(f.alice, `/races/${f.race.id}/progress`)).progress;
    assert.deepEqual(warm.powerupData.dropOdds.byType, odds.byType);
    const opened = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${box.id}/open`, { token: f.alice.token, headers: CURRENT });
    assert.equal(opened.status, 200);
    const result = await opened.json();
    const row = await prisma.racePowerup.findUnique({ where: { id: box.id } });
    assert.equal(row.status, 'HELD');
    assert.ok(odds.byType[row.type] > 0, JSON.stringify(result));
  });

  it('active Lucky Horseshoe disables only its owner preview on a shared warm snapshot, preserving byType', async () => {
    const f = await fixture();
    const horseshoe = await item(f, f.alice, 'LUCKY_HORSESHOE');
    const ordinary = (await get(f.alice, `/races/${f.race.id}/progress`)).progress;
    assert.equal(ordinary.powerupData.dropOdds.reelPreviewAvailable, true);
    const activation = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${horseshoe.id}/use`, { token: f.alice.token, headers: CURRENT, body: {} });
    assert.equal(activation.status, 200);
    const alice = (await get(f.alice, `/races/${f.race.id}/progress`)).progress;
    assert.deepEqual(alice.powerupData.dropOdds.byType, ordinary.powerupData.dropOdds.byType, 'preview metadata never rewrites existing ordinary disclosure');
    const bob = (await get(f.bob, `/races/${f.race.id}/progress`)).progress;
    assert.equal(alice.powerupData.dropOdds.reelPreviewAvailable, false);
    assert.equal(bob.powerupData.dropOdds.reelPreviewAvailable, true);
    const again = (await get(f.alice, `/races/${f.race.id}/progress`)).progress;
    assert.equal(again.powerupData.dropOdds.reelPreviewAvailable, false);
    assert.deepEqual(again.powerupData.dropOdds.byType, alice.powerupData.dropOdds.byType);
    const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}v1:race:progress:${f.race.id}*`);
    assert.ok(keys.length > 0, 'a real shared standings snapshot is warm');
    for (const key of keys) assert.ok(!(await redis.get(key)).includes('reelPreviewAvailable'), 'viewer preview is never stored in shared snapshot');
  });

  it('expired Lucky Horseshoe does not suppress the ordinary preview', async () => {
    const f = await fixture();
    await lucky(f, f.alice, 'EXPIRED');
    assert.equal((await get(f.alice, `/races/${f.race.id}/progress`)).progress.powerupData.dropOdds.reelPreviewAvailable, true);
  });
});
