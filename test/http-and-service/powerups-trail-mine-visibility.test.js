const assert = require('node:assert/strict');
const { before, beforeEach, after, describe, it } = require('node:test');
const IORedis = require('ioredis');
const { startTestRedis } = require('./redisTestServer');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
process.env.CACHE_ENV_PREFIX = 't:trail-mine-visibility:';
delete process.env.REDIS_URL;
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require('./setup');
// Infrastructure setup only. All effect behavior is asserted through real HTTP.
const cache = require('../../src/shared/cache/redisCache');
const { appSettings } = require('../../src/shared/config/appSettings');
let server, live, redis;
async function get(user, race, headers) {
  const r = await request(server.baseUrl, 'GET', `/races/${race.id}/progress`, { token: user.token, headers });
  assert.equal(r.status, 200); return (await r.json()).progress.powerupData.activeEffects;
}
describe('owner Trail Mine placement with real shared snapshots', () => {
  before(async () => {
    live = await startTestRedis(); assert.ok(live); process.env.REDIS_URL = live.url;
    await cache.close(); redis = new IORedis(live.url); server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase(); const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}*`);
    if (keys.length) await redis.del(...keys); await appSettings.setFlag('redisStandingsEnabled', true);
  });
  after(async () => { await cache.close(); await redis?.quit(); await live?.close(); delete process.env.REDIS_URL; });
  for (const isTeamRace of [false, true]) {
    it(`keeps multiple placements private on cold/warm reads and tolerates old metadata (team ${isTeamRace})`, async () => {
      const owner = await createTestUser({ displayName: 'Mine owner' });
      const rival = await createTestUser({ displayName: 'Mine rival' });
      const teammate = await createTestUser({ displayName: 'Mine teammate' });
      const race = await prisma.race.create({ data: { creatorId: owner.user.id, name: 'Mine preview',
        status: 'ACTIVE', targetSteps: 500000, startedAt: new Date(Date.now() - 3600000),
        endsAt: new Date(Date.now() + 86400000), powerupsEnabled: true, powerupStepInterval: 5000,
        isTeamRace, teamSize: isTeamRace ? 2 : null } });
      const participants = [];
      for (const [i, u] of [owner, rival, teammate].entries()) participants.push(await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: u.user.id, status: 'ACCEPTED', joinedAt: race.startedAt,
          nextBoxAtSteps: 5000, team: isTeamRace ? (i === 1 ? 'TEAM_B' : 'TEAM_A') : null } }));
      const effects = [];
      for (const [i, positionSteps] of [5000, 9000, undefined, '1000', -1].entries()) {
        const held = await prisma.racePowerup.create({ data: { raceId: race.id, participantId: participants[0].id,
          userId: owner.user.id, type: 'TRAIL_MINE', rarity: 'RARE', status: 'USED', earnedAtSteps: i * 1000 } });
        effects.push(await prisma.raceActiveEffect.create({ data: { raceId: race.id, targetParticipantId: participants[0].id,
          targetUserId: owner.user.id, sourceUserId: owner.user.id, powerupId: held.id, type: 'TRAIL_MINE',
          status: 'ACTIVE', startsAt: new Date(), expiresAt: null, metadata: { positionSteps } } }));
      }
      for (const headers of [{}, { 'X-Client-Features': 'characters,powerups3,powerups4,powerups5' }]) {
        for (const pass of ['cold', 'warm']) {
          const own = (await get(owner, race, headers)).filter(e => e.type === 'TRAIL_MINE');
          assert.equal(own.length, 5, pass);
          for (let i = 0; i < effects.length; i++) {
            const e = own.find(e => e.id === effects[i].id); assert.equal(e.onSelf, true); assert.equal(e.expiresAt, null);
            if (i < 2) assert.deepEqual(e.trailMine, { positionSteps: [5000, 9000][i] });
            else assert.ok(!('trailMine' in e));
            assert.ok(!('metadata' in e));
          }
          for (const viewer of [rival, teammate]) assert.ok(!(await get(viewer, race, headers)).some(e => e.type === 'TRAIL_MINE'));
        }
      }
      const keys = await redis.keys(`${process.env.CACHE_ENV_PREFIX}v1:race:progress:${race.id}*`);
      assert.ok(keys.length > 0, 'real shared race snapshot was populated');
      for (const key of keys) assert.ok(!(await redis.get(key)).includes('"trailMine"'), 'owner projection is never shared cached');
    });
  }
});
