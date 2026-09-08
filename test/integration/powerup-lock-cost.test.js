const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { describe, it, before, beforeEach, after } = require('node:test');
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
delete process.env.PRISMA_QUERY_EVENTS_ENABLED;
let server;
let sql = null;

async function fixture(size) {
  const caster = await createTestUser({ displayName: 'CostCaster' });
  const target = await createTestUser({ displayName: 'CostTarget' });
  const others = Array.from({ length: size - 2 }, () => ({ id: randomUUID() }));
  await prisma.user.createMany({ data: others.map(({ id }, index) => ({ id, appleId: `lock-cost-${id}`, displayName: `CostPlayer${index}` })) });
  const startedAt = new Date(Date.now() - 3600000);
  const race = await prisma.race.create({ data: {
    creatorId: caster.user.id, name: 'Uncontended powerup cost', status: 'ACTIVE',
    timeBased: true, maxDurationDays: 7, maxParticipants: null, targetSteps: 1000000,
    startedAt, endsAt: new Date(Date.now() + 7 * 86400000), timezone: 'UTC', powerupsEnabled: true,
  } });
  const participants = [caster.user, target.user, ...others].map((user) => ({
    id: randomUUID(), raceId: race.id, userId: user.id, status: 'ACCEPTED',
    totalSteps: 10000, bonusSteps: 10000, nextBoxAtSteps: 900000, joinedAt: startedAt,
  }));
  await prisma.raceParticipant.createMany({ data: participants });
  return { race, caster, target, casterParticipant: participants[0], targetParticipant: participants[1] };
}

describe('uncontended powerup HTTP cost at small and weekly-race size', () => {
  before(async () => {
    prisma.$on('query', (event) => { if (sql) sql.push(event.query); });
    server = await startServer();
  });
  beforeEach(cleanDatabase);
  after(async () => { await server.close(); await prisma.$disconnect(); });
  for (const size of [4, 2000]) {
    it(`preserves outcomes for ${size} participants while recording request cost`, { timeout: 120000 }, async () => {
      const f = await fixture(size);
      let earned = 900000;
      // Same deterministic operation order in each revision. Round0 is reported
      // as warmup; three measured rounds follow without timing fixture setup.
      for (let round = 0; round <= 3; round += 1) {
        for (const type of ['PROTEIN_SHAKE', 'TRAIL_MIX', 'SHORTCUT']) {
          const held = await prisma.racePowerup.create({ data: {
            raceId: f.race.id, participantId: f.casterParticipant.id, userId: f.caster.user.id,
            type, rarity: 'RARE', status: 'HELD', earnedAtSteps: ++earned,
          } });
          const before = await prisma.raceParticipant.findMany({ where: { id: { in: [f.casterParticipant.id, f.targetParticipant.id] } } });
          sql = [];
          const started = performance.now();
          const response = await request(server.baseUrl, 'POST', `/races/${f.race.id}/powerups/${held.id}/use`, {
            token: f.caster.token,
            headers: { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' },
            body: type === 'SHORTCUT' ? { targetUserId: f.target.user.id } : {},
          });
          const body = await response.json();
          const elapsedMs = performance.now() - started;
          const queryCount = sql.length;
          sql = null;
          console.log('UNCONTENDED_LOCK_COST ' + JSON.stringify({ size, type, round, warmup: round === 0, elapsedMs, queryCount, status: response.status }));
          assert.equal(response.status, 200, JSON.stringify(body));
          const result = body.result;
          const delta = type === 'SHORTCUT' ? result.stolen : result.bonus;
          assert.ok(Number.isInteger(delta) && delta > 0);
          const after = await prisma.raceParticipant.findMany({ where: { id: { in: [f.casterParticipant.id, f.targetParticipant.id] } } });
          const previousCaster = before.find((p) => p.id === f.casterParticipant.id);
          const currentCaster = after.find((p) => p.id === f.casterParticipant.id);
          assert.equal(currentCaster.bonusSteps, previousCaster.bonusSteps + delta);
          const previousTarget = before.find((p) => p.id === f.targetParticipant.id);
          const currentTarget = after.find((p) => p.id === f.targetParticipant.id);
          assert.equal(currentTarget.bonusSteps, previousTarget.bonusSteps - (type === 'SHORTCUT' ? delta : 0));
          assert.equal((await prisma.racePowerup.findUnique({ where: { id: held.id } })).status, 'USED');
        }
      }
    });
  }
});
