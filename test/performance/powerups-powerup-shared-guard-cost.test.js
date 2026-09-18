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
let server; let queries = null;
const headers = { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' };

describe('unpaused mixed powerup HTTP burst cost', () => {
  before(async () => {
    prisma.$on('query', e => { if (queries) queries.push(e.query); });
    server = await startServer();
  });
  beforeEach(cleanDatabase);
  after(async () => { await server.close(); await prisma.$disconnect(); });
  for (const withSync of [false, true]) for (const size of [16, 2000]) it(`${size} participants: eight disjoint actions, sync=${withSync}`, { timeout: 120000 }, async () => {
    const actors = [];
    for (let i = 0; i < 8; i++) actors.push(await createTestUser({ displayName: `Actor${i}` }));
    const others = Array.from({ length: size - 8 }, () => ({ id: randomUUID() }));
    await prisma.user.createMany({ data: others.map(p => ({ id: p.id, appleId: `shared-bench-${p.id}` })) });
    const startedAt = new Date(Date.now() - 3600000);
    const race = await prisma.race.create({ data: { creatorId: actors[0].user.id, name: 'Shared guard comparison',
      status: 'ACTIVE', timeBased: true, maxDurationDays: 7, targetSteps: 1000000,
      startedAt, endsAt: new Date(Date.now() + 86400000), timezone: 'UTC', powerupsEnabled: true } });
    const participants = [...actors.map(p => p.user), ...others].map(p => ({ id: randomUUID(),
      raceId: race.id, userId: p.id, status: 'ACCEPTED', totalSteps: 100000, bonusSteps: 100000,
      nextBoxAtSteps: 900000, joinedAt: startedAt }));
    await prisma.raceParticipant.createMany({ data: participants });
    await prisma.$executeRawUnsafe(`INSERT INTO race_resolution_jobs_v2
      (id, race_id, generation, state, requested_at, completed_at, last_completed_at, created_at, updated_at)
      VALUES (gen_random_uuid()::text, $1, 0, 'succeeded', NOW(), NOW(), NOW(), NOW(), NOW())`, race.id);
    let expectedTotal = size * 100000;
    for (let round = 0; round < 7; round++) {
      const held = [];
      for (let i = 0; i < 8; i++) held.push(await prisma.racePowerup.create({ data: {
        raceId: race.id, participantId: participants[i].id, userId: participants[i].userId,
        type: i < 4 ? 'SHORTCUT' : i < 6 ? 'PROTEIN_SHAKE' : 'TRAIL_MIX',
        status: 'HELD', rarity: 'RARE', earnedAtSteps: 100000 + round * 8 + i,
      } }));
      queries = [];
      const started = performance.now();
      const pending = held.map(async (powerup, i) => {
        const t = performance.now();
        const response = await request(server.baseUrl, 'POST', `/races/${race.id}/powerups/${powerup.id}/use`, {
          token: actors[i].token, headers, body: i < 4 ? { targetUserId: participants[8 + i].userId } : {},
        });
        return { status: response.status, body: await response.json(), ms: performance.now() - t };
      });
      if (withSync) pending.push((async () => {
        const t = performance.now();
        const response = await request(server.baseUrl, 'POST', '/steps/sync-v2', {
          token: actors[7].token, headers: { 'Idempotency-Key': randomUUID() },
          body: { date: new Date().toISOString().slice(0, 10), steps: (round + 1) * 100, samples: [] },
        });
        return { status: response.status, body: await response.json(), ms: performance.now() - t, sync: true };
      })());
      const results = await Promise.all(pending);
      const elapsedMs = performance.now() - started;
      const sql = queries; queries = null;
      console.log('SHARED_GUARD_BURST ' + JSON.stringify({ size, withSync, round, warmup: round < 2, elapsedMs,
        latencyMs: results.filter(r => !r.sync).map(r => r.ms), syncLatencyMs: results.find(r => r.sync)?.ms || null, queryCount: sql.length,
        writes: sql.filter(q => /^(INSERT|UPDATE|DELETE)/i.test(q.trim())).length,
        errors: results.filter(r => r.status !== (r.sync ? 202 : 200)).length }));
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, r.sync ? 202 : 200, JSON.stringify(r.body));
        if (r.sync) { assert.ok(r.body.raceResolution?.jobId); continue; }
        if (i < 4) assert.ok(r.body.result.stolen > 0);
        else { assert.ok(r.body.result.bonus > 0); expectedTotal += r.body.result.bonus; }
      }
      const aggregate = await prisma.raceParticipant.aggregate({ where: { raceId: race.id }, _sum: { totalSteps: true } });
      assert.equal(aggregate._sum.totalSteps, expectedTotal);
      assert.equal(await prisma.racePowerup.count({ where: { id: { in: held.map(p => p.id) }, status: 'USED' } }), 8);
    }
  });
});
