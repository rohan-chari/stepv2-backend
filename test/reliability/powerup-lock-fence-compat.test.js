const assert = require('node:assert/strict');
const { describe, it, before, beforeEach, after } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');

// This suite deliberately holds row locks and creates race fixtures.
const url = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /_test$/);
const { prisma, cleanDatabase, startServer, createTestUser, request } = require('./setup');
let server;

async function waitForBlockedQuery(client, blockerPid, table) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await client.query(
      `SELECT pid, query FROM pg_stat_activity
       WHERE datname = current_database()
         AND $1::int = ANY(pg_blocking_pids(pid))`, [blockerPid],
    );
    const match = rows.find((row) => row.query.includes(table));
    if (match) return match;
    await delay(10);
  }
  assert.fail(`No ${table} writer observed waiting on the expected blocker`);
}

async function fixture(type) {
  const players = [];
  for (const displayName of ['OutageCaster', 'FollowingCaster', 'LockHolder']) {
    players.push(await createTestUser({ displayName }));
  }
  const race = await prisma.race.create({ data: {
    creatorId: players[0].user.id, name: 'Powerup fence order', status: 'ACTIVE',
    timeBased: true, maxDurationDays: 7, targetSteps: 1000000,
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 7 * 86400000),
    timezone: 'UTC', powerupsEnabled: true,
  } });
  for (const player of players) {
    player.participant = await prisma.raceParticipant.create({ data: {
      raceId: race.id, userId: player.user.id, status: 'ACCEPTED',
      totalSteps: 10000, bonusSteps: 10000, nextBoxAtSteps: 900000,
      joinedAt: race.startedAt,
    } });
  }
  const items = [];
  for (const [index, powerupType] of ['POWER_OUTAGE', type].entries()) {
    items.push(await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: players[index].participant.id,
      userId: players[index].user.id, type: powerupType,
      status: 'HELD', rarity: 'RARE', earnedAtSteps: index + 1,
    } }));
  }
  return { race, players, items };
}

describe('narrow powerup locks retain authoritative race ordering', () => {
  before(async () => { server = await startServer(); });
  beforeEach(cleanDatabase);
  after(async () => { await server.close(); await prisma.$disconnect(); });

  for (const type of ['PROTEIN_SHAKE', 'TRAIL_MIX', 'SHORTCUT']) {
    it(`${type} waits for an earlier Outage and rejects without consuming the item`, { timeout: 30000 }, async () => {
      const f = await fixture(type);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      const monitor = new Client({ connectionString: process.env.DATABASE_URL });
      let outageRequest;
      let followingRequest;
      await blocker.connect();
      await monitor.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
        const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
        await blocker.query('SELECT id FROM race_participants WHERE id=$1 FOR UPDATE', [f.players[2].participant.id]);
        const use = async (index, body) => {
          const response = await request(server.baseUrl, 'POST',
            `/races/${f.race.id}/powerups/${f.items[index].id}/use`, {
              token: f.players[index].token, body,
              headers: { 'X-Client-Features': 'powerups2,powerups3,powerups4,powerups5', 'X-Timezone': 'UTC' },
            });
          return { status: response.status, body: await response.json() };
        };
        outageRequest = use(0, {});
        // Observe the real lock graph, rather than guessing HTTP arrival order.
        const outageWait = await waitForBlockedQuery(monitor, pid, 'race_participants');
        followingRequest = use(1, type === 'SHORTCUT' ? { targetUserId: f.players[0].user.id } : {});
        await waitForBlockedQuery(monitor, outageWait.pid, 'race_resolution_jobs_v2');
        assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.items[1].id } })).status, 'HELD');
        await blocker.query('ROLLBACK');
        const outage = await outageRequest;
        const following = await followingRequest;
        assert.equal(outage.status, 200, JSON.stringify(outage.body));
        assert.equal(following.status, 409, JSON.stringify(following.body));
        assert.match(following.body.error, /jammed/i);
        assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.items[1].id } })).status, 'HELD');
        assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.items[0].id, targetUserId: f.players[1].user.id, type: 'POWER_OUTAGE', status: 'ACTIVE' } }), 1);
        assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, actorUserId: f.players[1].user.id, powerupType: type } }), 0);
        const followingParticipant = await prisma.raceParticipant.findUnique({ where: { id: f.players[1].participant.id } });
        assert.equal(followingParticipant.bonusSteps, 10000);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        await Promise.allSettled([outageRequest, followingRequest]);
        await blocker.end();
        await monitor.end();
      }
    });
  }
});
