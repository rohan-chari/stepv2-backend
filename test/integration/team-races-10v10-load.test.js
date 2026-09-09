const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, after, describe, it } = require("node:test");
// Query observation is local-only; initialize the test DB client before
// enabling permanent production behavior for the real HTTP handler chain.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
process.env.DATABASE_POOL_MAX_DEFAULT = "8";
const { prisma } = require("../../src/db");
delete process.env.PRISMA_QUERY_EVENTS_ENABLED;
process.env.NODE_ENV = "production";
process.env.STEPS_PROCESS_ROLE = "http";
process.env.REDIS_URL = "";
process.env.CACHE_ENV_PREFIX = `t:large-team-load:${randomUUID()}:`;
// Load app/settings only after choosing production semantics; its historical
// unit-test override mode is captured at construction, not at request time.
const { cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { buildRaceResolutionPostTaskRunner } = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");

const FEATURES = "characters,team_races,team_races_10v10_v1,powerups3,powerups4,powerups5,race_participants_paging,api_payload_compact_v1";
const HEADERS = { "X-Client-Features": FEATURES, "X-Timezone": "UTC" };
let server, live, capture;
let fixtureSequence = 0;

async function fixture(size, { powerups = false } = {}) {
  const fixtureId = ++fixtureSequence;
  const users = [];
  for (let i = 0; i < size * 2; i++) users.push(await createTestUser({
    displayName: `Load ${fixtureId} racer ${i}`, clientFeatures: FEATURES.split(","),
  }));
  const start = new Date(Date.now() - 3_600_000);
  const race = await prisma.race.create({ data: {
    name: `Load ${size}v${size}`, creatorId: users[0].user.id,
    targetSteps: 0, timeBased: true, timezone: "UTC", status: "ACTIVE",
    maxDurationDays: 1, startedAt: start, endsAt: new Date(Date.now() + 86_400_000),
    isTeamRace: true, teamSize: size, maxParticipants: size * 2,
    teamAName: "Acorns", teamBName: "Berries", powerupsEnabled: powerups,
    powerupStepInterval: 5000, fundedPrize: true,
    teamPayoutVersion: 1, teamWinnerRewardCoins: 100,
  } });
  const participants = users.map((entry, i) => ({
    id: randomUUID(), raceId: race.id, userId: entry.user.id,
    status: "ACCEPTED", team: i < size ? "TEAM_A" : "TEAM_B",
    joinedAt: start, totalSteps: i + 100, rawSteps: i + 100,
    nextBoxAtSteps: 5000,
  }));
  await prisma.raceParticipant.createMany({ data: participants });
  return { race, users, participants, size };
}

async function measured(label, work) {
  capture = { statements: 0, byLeadingVerb: {}, participantUpdates: 0, summedQueryMs: 0 };
  const started = performance.now();
  try {
    const value = await work();
    await new Promise(setImmediate);
    return { value, measurement: {
      label, ...capture, wallMs: Math.round((performance.now() - started) * 100) / 100,
    } };
  } finally { capture = null; }
}

async function jsonRequest(user, method, path, body) {
  const response = await request(server.baseUrl, method, path, {
    token: user.token, headers: HEADERS, body,
  });
  const json = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${response.status}: ${JSON.stringify(json)}`);
  return json;
}

describe("10v10 bounded HTTP load and powerup fan-out", () => {
  before(async () => {
    await cleanDatabase();
    await prisma.appSetting.upsert({
      where: { key: "apiRaceBootstrapV1Enabled" },
      create: { key: "apiRaceBootstrapV1Enabled", value: true }, update: { value: true },
    });
    live = await startTestRedis();
    assert.ok(live, "capacity smoke requires local test Redis");
    const url = new URL(live.url);
    assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
    assert.equal(url.pathname, "/15");
    process.env.REDIS_URL = live.url;
    await require("../../src/shared/cache/redisCache").close();
    server = await getSharedServer();
    prisma.$on("query", ({ query, duration }) => {
      if (!capture) return;
      const verb = query.replace(/^\s*(?:--[^\n]*\n\s*)*/, "").match(/^\s*([a-z]+)/i)?.[1]?.toUpperCase() || "OTHER";
      capture.statements++;
      if (/\bUPDATE\s+(?:"public"\.)?"?race_participants"?\b/i.test(query)) capture.participantUpdates++;
      capture.byLeadingVerb[verb] = (capture.byLeadingVerb[verb] || 0) + 1;
      capture.summedQueryMs += duration;
    });
  });
  beforeEach(cleanDatabase);
  after(async () => {
    capture = null;
    await require("../../src/shared/cache/redisCache").close();
    await live?.close();
  });

  for (const size of [5, 10]) {
    it(`${size}v${size} bootstrap returns every member cold and warm`, async (t) => {
      const f = await fixture(size);
      const samples = [];
      for (let i = 0; i < 12; i++) {
        const result = await measured(`${size}v${size}-bootstrap-${i === 0 ? "cold" : "warm"}`, () =>
          jsonRequest(f.users[0], "GET", `/races/${f.race.id}/bootstrap?view=participants-v1&offset=15&limit=1&shape=compact-v1`));
        assert.equal(result.value.race.teamRosterComplete, true);
        assert.equal(result.value.race.teamAcceptedParticipants.length, size * 2);
        assert.equal(result.value.progress.participants.length, size * 2);
        assert.equal(result.measurement.participantUpdates, 0, "team reads cannot update every member's score");
        samples.push(result.measurement);
      }
      const ordered = samples.slice(1).map((row) => row.wallMs).sort((a, b) => a - b);
      t.diagnostic(JSON.stringify({ cold: samples[0], warm: samples.slice(1), warmP95Ms: ordered[Math.ceil(ordered.length * .95) - 1] }));
    });

    for (const type of ["RALLY_FLAG", "UPRISING", "RAINSTORM"]) {
      it(`${size}v${size} ${type} reaches every eligible member`, async (t) => {
        const f = await fixture(size, { powerups: true });
        if (type === "UPRISING") {
          // Prove the losing-side check through real scoring inputs rather
          // than assuming stale participant totals make TEAM_A eligible.
          await prisma.stepSample.createMany({ data: f.participants.map((row) => ({
            userId: row.userId, periodStart: f.race.startedAt,
            periodEnd: new Date(Date.now() - 60_000),
            steps: row.team === "TEAM_A" ? 100 : 200, sourceName: "healthkit",
          })) });
        }
        const item = await prisma.racePowerup.create({ data: {
          raceId: f.race.id, participantId: f.participants[0].id,
          userId: f.users[0].user.id, type, rarity: "RARE", status: "HELD", earnedAtSteps: 100,
        } });
        const result = await measured(`${size}v${size}-${type}`, () =>
          jsonRequest(f.users[0], "POST", `/races/${f.race.id}/powerups/${item.id}/use`, {}));
        const effects = await prisma.raceActiveEffect.findMany({ where: { raceId: f.race.id, type } });
        const expected = f.participants.filter((row) => row.team === (type === "RAINSTORM" ? "TEAM_B" : "TEAM_A"));
        assert.deepEqual(effects.map((row) => row.targetUserId).sort(), expected.map((row) => row.userId).sort());
        assert.equal(effects.length, size);
        const progress = await jsonRequest(f.users[0], "GET", `/races/${f.race.id}/progress`);
        assert.equal(progress.progress.participants.length, size * 2);
        t.diagnostic(JSON.stringify({ ...result.measurement, effectRows: effects.length,
          queuedRaceJobs: await prisma.raceResolutionJobV2.count({ where: { raceId: f.race.id } }) }));
      });
    }
  }

  it("compares the same20 syncing players in two5v5 races and one10v10 race", async (t) => {
    for (const sizes of [[5, 5], [10]]) {
      await cleanDatabase();
      const fixtures = [];
      for (const size of sizes) fixtures.push(await fixture(size));
      const users = fixtures.flatMap((entry) => entry.users);
      let next = 0;
      const result = await measured(`20-players-${sizes.join("+")}-per-side-sync-concurrency8`, async () => {
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (next < users.length) {
            const user = users[next++];
            const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
              token: user.token, headers: { ...HEADERS, "Idempotency-Key": randomUUID() },
              body: { date: new Date().toISOString().slice(0, 10), steps: 100, samples: [] },
            });
            assert.equal(response.status, 202, await response.text());
          }
        }));
      });
      assert.equal(await prisma.step.count({ where: { steps: 100 } }), 20);
      assert.equal(await prisma.raceResolutionJobV2.count(), sizes.length);
      t.diagnostic(JSON.stringify({ ...result.measurement, requests: 20, queuedRaceJobs: sizes.length }));
    }
  });

  it("2000 players syncing across100 full10v10 races preserve durable intake with bounded concurrency", async (t) => {
    const fixtures = [];
    for (let i = 0; i < 100; i++) fixtures.push(await fixture(10));
    const users = fixtures.flatMap((entry) => entry.users);
    const sample = { periodStart: new Date(Date.now() - 600_000).toISOString(),
      periodEnd: new Date(Date.now() - 300_000).toISOString(), steps: 100, sourceName: "healthkit" };
    let next = 0;
    const latencies = [];
    const result = await measured("2000-players-100-races-sync-concurrency8", async () => {
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < users.length) {
          const user = users[next++];
          const started = performance.now();
          const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
            token: user.token,
            headers: { ...HEADERS, "Idempotency-Key": randomUUID() },
            body: { date: new Date().toISOString().slice(0, 10), steps: 100, samples: [sample] },
          });
          assert.equal(response.status, 202, await response.text());
          latencies.push(performance.now() - started);
        }
      }));
    });
    assert.equal(latencies.length, 2000);
    assert.equal(await prisma.step.count({ where: { steps: 100 } }), 2000);
    assert.equal(await prisma.raceResolutionJobV2.count(), 100, "one coalesced job per race");
    latencies.sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ ...result.measurement, requests: latencies.length,
      requestP95Ms: latencies[Math.ceil(latencies.length * .95) - 1], queuedRaceJobs: 100,
      note: "Local producer phase. Downstream worker and publication phases measured separately below." }));

    // Resolution and publication have no HTTP trigger. Drive their actual
    // scheduler entrypoints, then verify what the real HTTP client sees.
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0, processRole: "resolution" });
    const post = buildRaceResolutionPostTaskRunner();
    let nextRace = 0;
    const resolution = await measured("100-full10v10-resolution-concurrency2", async () => {
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (nextRace < fixtures.length) {
          await worker.processRace({ raceId: fixtures[nextRace++].race.id });
        }
      }));
    });
    assert.equal(await prisma.raceResolutionJobV2.count({ where: { state: "SUCCEEDED" } }), 100);
    t.diagnostic(JSON.stringify(resolution.measurement));
    const publication = await measured("100-full10v10-post-tasks", async () => {
      for (let i = 0; i < 1000; i++) {
        const snapshot = await post.snapshotTick();
        const task = await post.tick();
        if (!snapshot && !task) return;
      }
      assert.fail("publication must finish within bounded drain");
    });
    t.diagnostic(JSON.stringify(publication.measurement));
    for (const f of fixtures) {
      const result = await jsonRequest(f.users[0], "GET", `/races/${f.race.id}/progress`);
      assert.equal(result.progress.participants.length, 20);
      assert.ok(result.progress.participants.every((row) => row.totalSteps === 100), "worker commits all20 sample-derived totals");
      assert.equal(result.progress.teams.teamA.totalSteps, 1000);
      assert.equal(result.progress.teams.teamB.totalSteps, 1000);
    }
  });
});
