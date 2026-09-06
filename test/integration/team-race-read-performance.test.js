const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, after, describe, it } = require("node:test");
const IORedis = require("ioredis");

// Enable SQL observation on the disposable DB before loading the production
// HTTP handlers. Production itself still prohibits query instrumentation.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma } = require("../../src/db");
const { appSettings } = require("../../src/shared/config/appSettings");
delete process.env.PRISMA_QUERY_EVENTS_ENABLED;
process.env.NODE_ENV = "production";
process.env.STEPS_PROCESS_ROLE = "http";
process.env.CACHE_ENV_PREFIX = `t:team-read:${randomUUID()}:`;
delete process.env.REDIS_URL;
const { cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const redisCache = require("../../src/shared/cache/redisCache");

const HEADERS = {
  "X-Client-Features": "characters,team_races,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,api_payload_compact_v1",
  "X-Timezone": "UTC",
  "X-Release-Channel": "prod",
};
let server, live, probe, monitor, capturedQueries, commands;

async function fixture({ timezone = "UTC", status = "ACTIVE" } = {}) {
  const users = [];
  for (let i = 0; i < 4; i++) users.push(await createTestUser({ displayName: `Team runner ${i}` }));
  const hat = await prisma.shopItem.create({ data: {
    sku: `team-read-hat-${randomUUID()}`, name: "Test hat", slot: "HEAD",
    priceCoins: 0, assetKey: "cowboy_hat", renderMetadata: { offsetX: 0.02 },
  } });
  await prisma.userEquippedAccessory.createMany({ data: [users[1], users[2]].map((u) => ({
    userId: u.user.id, slot: "HEAD", shopItemId: hat.id,
  })) });
  const race = await prisma.race.create({ data: {
    creatorId: users[0].user.id, name: "Team read regression", status,
    targetSteps: 0, timeBased: true, maxDurationDays: 7, maxParticipants: 4,
    startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
    timezone, powerupsEnabled: false, isTeamRace: true, teamSize: 2,
    teamAName: "Acorns", teamBName: "Berries", fundedPrize: true,
    teamPayoutVersion: 1, teamWinnerRewardCoins: 500,
  } });
  await prisma.raceParticipant.createMany({ data: users.map((u, i) => ({
    raceId: race.id, userId: u.user.id, status: "ACCEPTED",
    team: i < 2 ? "TEAM_A" : "TEAM_B", totalSteps: (i + 1) * 100,
    rawSteps: (i + 1) * 100, nextBoxAtSteps: 5000,
    joinedAt: new Date(Date.now() - 3600000 + i),
    ...(i === 3 ? { forfeitedAt: new Date() } : {}),
  })) });
  return { race, users, viewer: users[0] };
}

async function read(f, { endpoint = "bootstrap", paged = true, viewer = f.viewer } = {}) {
  const query = paged ? "?view=participants-v1&offset=0&limit=1&shape=compact-v1" : "";
  const headers = paged ? HEADERS : { "X-Client-Features": "characters,team_races", "X-Timezone": "UTC" };
  const response = await request(server.baseUrl, "GET", `/races/${f.race.id}/${endpoint}${query}`, { token: viewer.token, headers });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.progress, JSON.stringify(body));
  return body;
}

function assertFullTeams(body, f) {
  assert.equal(body.progress.isTeamRace, true);
  assert.equal(body.progress.participants.length, 4, "both columns retain every accepted member even with limit=1");
  assert.deepEqual(body.progress.participants.map((p) => p.userId).sort(), f.users.map((u) => u.user.id).sort());
  assert.deepEqual(body.progress.teams, {
    teamA: { name: "Acorns", totalSteps: 300, memberCount: 2 },
    teamB: { name: "Berries", totalSteps: 700, memberCount: 2 },
  });
  for (const [i, u] of f.users.entries()) {
    const row = body.progress.participants.find((p) => p.userId === u.user.id);
    assert.equal(row.displayName, `Team runner ${i}`);
    assert.equal(row.totalSteps, (i + 1) * 100);
    assert.equal(row.team, i < 2 ? "TEAM_A" : "TEAM_B");
    assert.ok(Array.isArray(row.accessories));
    if (i === 1 || i === 2) {
      assert.equal(row.accessories[0]?.assetKey, "cowboy_hat");
      assert.equal(row.accessories[0]?.renderMetadata?.offsetX, 0.02);
    }
    if (i === 3) assert.ok(row.forfeitedAt, "frozen members remain visible");
  }
  if (body.race) {
    assert.equal(body.contract, "race-bootstrap-v1", "keep the established full-team contract");
    assert.equal(body.race.acceptedCount, 4);
    assert.equal(body.race.teamAAcceptedCount, 2);
    assert.equal(body.race.teamBAcceptedCount, 2);
    assert.equal(body.race.teamWinnerRewardCoins, 500);
  }
}

describe("team race HTTP read performance and compatibility", () => {
  before(async () => {
    await cleanDatabase();
    server = await getSharedServer();
    live = await startTestRedis();
    assert.ok(live, "these regressions require a real local test Redis");
    const url = new URL(live.url);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.equal(url.pathname, "/15");
    probe = new IORedis(live.url);
    monitor = await probe.monitor();
    monitor.on("monitor", (_time, args) => { if (commands) commands.push(args); });
    prisma.$on("query", (event) => { if (capturedQueries) capturedQueries.push(event); });
  });
  beforeEach(async () => {
    capturedQueries = null;
    commands = null;
    await redisCache.close();
    delete process.env.REDIS_URL;
    await cleanDatabase();
    for (const key of ["apiRaceBootstrapV1Enabled", "apiRaceBootstrapCompactV1Enabled", "raceProgressLeanProjectionV1Enabled", "redisStandingsEnabled"]) {
      await appSettings.setFlag(key, true);
    }
    process.env.REDIS_URL = live.url;
    await redisCache.close();
  });
  after(async () => {
    capturedQueries = null;
    commands = null;
    await redisCache.close();
    monitor?.disconnect();
    await probe?.quit();
    await live?.close();
    await cleanDatabase();
  });

  it("loads the team scoring roster once instead of reloading the cosmetic graph", async () => {
    const f = await fixture();
    capturedQueries = [];
    const body = await read(f);
    assertFullTeams(body, f);
    assert.equal(body.progress.pagination.total, 4);
    assert.equal(body.progress.pagination.hasMore, false);
    const coreReads = capturedQueries.filter(({ query }) => query.includes('FROM "public"."races"') && query.includes('"name"'));
    assert.equal(coreReads.length, 2, `only access plus the lean scoring context should load race core; saw ${coreReads.length}`);
  });

  for (const paged of [true, false]) {
    it(`serves a cold ${paged ? "paged" : "frozen unpaged"} team bootstrap without polling for worker output`, async () => {
      const f = await fixture();
      commands = [];
      const body = await read(f, { paged });
      assertFullTeams(body, f);
      // MONITOR observes the real Redis operations from the HTTP path. An
      // absent snapshot must be read once, never polled for a whole second.
      await probe.ping();
      const reads = commands.filter(([op, key]) => op.toLowerCase() === "get" && key.includes(`v1:race:progress:${f.race.id}`));
      assert.equal(reads.length, 1, `cold team read polled Redis ${reads.length} times`);
      const job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: f.race.id } });
      assert.ok(job?.dirtyReasons.includes("DISPLAY_REFRESH"), "authoritative refresh remains queued");
      const persisted = await prisma.raceParticipant.findMany({ where: { raceId: f.race.id }, orderBy: { joinedAt: "asc" } });
      assert.deepEqual(persisted.map((p) => p.totalSteps), [100, 200, 300, 400], "GET must not replay and write race-wide totals");
    });
  }

  it("keeps direct progress, legacy bootstrap, and null-timezone teams compatible with Redis disabled", async () => {
    delete process.env.REDIS_URL;
    await redisCache.close();
    await appSettings.setFlag("redisStandingsEnabled", false);
    const f = await fixture({ timezone: null });
    assertFullTeams(await read(f, { endpoint: "progress" }), f);
    assertFullTeams(await read(f, { paged: false }), f);
  });

  for (const stale of [false, true]) {
    it(`uses the worker's ${stale ? "stale" : "fresh"} lean team snapshot and hydrates names after masking`, async () => {
      const f = await fixture();
      const rows = await prisma.raceParticipant.findMany({ where: { raceId: f.race.id }, orderBy: { joinedAt: "asc" } });
      // Seed the Redis wire artifact as a worker would publish it, deliberately
      // different from stored totals. Exercise only the real HTTP read path.
      await probe.set(`${process.env.CACHE_ENV_PREFIX}v1:race:progress:${f.race.id}:lean-v3`, JSON.stringify({
        v: 3, asOf: new Date(Date.now() - (stale ? 60000 : 0)).toISOString(),
        scoringTimeZone: "UTC", source: "worker-persisted",
        race: {
          raceId: f.race.id, status: "ACTIVE", isTeamRace: true, teamSize: 2,
          endsAt: f.race.endsAt, maxDurationDays: 7, targetSteps: 0,
          powerupsEnabled: true,
        },
        participants: rows.map((p, i) => ({
          participantId: p.id, userId: p.userId, totalSteps: (i + 1) * 1000,
          finishedAt: null, forfeitedAt: p.forfeitedAt, team: p.team,
          placement: 4 - i, currentMultiplier: 1, baseAdjusted: p.rawSteps,
        })),
        teams: {
          teamA: { name: "Acorns", totalSteps: 3000, memberCount: 2 },
          teamB: { name: "Berries", totalSteps: 7000, memberCount: 2 },
        },
        activeEffects: [{
          id: randomUUID(), type: "STEALTH_MODE", targetUserId: rows[2].userId,
          targetParticipantId: rows[2].id, sourceUserId: rows[2].userId,
          status: "ACTIVE", startsAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(), metadata: {},
        }],
      }), "EX", 120);
      const body = await read(f);
      assert.equal(body.progress.participants.length, 4);
      assert.equal(body.progress.teams.teamA.totalSteps, 3000);
      assert.equal(body.progress.teams.teamB.totalSteps, 7000, "team aggregate stays honest when a member is masked");
      const hidden = body.progress.participants.find((p) => p.userId === rows[2].userId);
      assert.equal(hidden.displayName, "???");
      assert.equal(hidden.totalSteps, null);
      assert.equal(hidden.stealthed, true);
      assert.deepEqual(hidden.accessories, []);
      const visible = body.progress.participants.find((p) => p.userId === rows[1].userId);
      assert.equal(visible.displayName, "Team runner 1");
      assert.equal(visible.totalSteps, 2000);
      assert.equal(visible.accessories[0]?.assetKey, "cowboy_hat");
      if (!stale) {
        assert.equal(await prisma.raceResolutionJobV2.count({ where: { raceId: f.race.id } }), 0, "fresh worker snapshot needs no refresh");
      } else {
        // Stale serves enqueue in the background. Observe completion before
        // cleanup so the next case cannot race this request's durable write.
        const deadline = Date.now() + 2000;
        let job;
        do {
          job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: f.race.id } });
          if (job?.dirtyReasons.includes("DISPLAY_REFRESH")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (Date.now() < deadline);
        assert.ok(job?.dirtyReasons.includes("DISPLAY_REFRESH"), "stale team snapshot still requests an authoritative refresh");
      }
    });
  }

  it("preserves access checks for outsiders and forfeited viewers", async () => {
    const f = await fixture();
    const outsider = await createTestUser();
    for (const [viewer, expected] of [[outsider, 403], [f.users[3], 404]]) {
      const response = await request(server.baseUrl, "GET", `/races/${f.race.id}/bootstrap?view=participants-v1&limit=1`, { token: viewer.token, headers: HEADERS });
      assert.equal(response.status, expected);
    }
  });
});
