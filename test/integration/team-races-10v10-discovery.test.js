const assert = require("node:assert/strict");
const { before, beforeEach, after, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");
const IORedis = require("ioredis");
// Exercise permanent production read paths, but only against the explicit
// disposable DATABASE_URL guarded by setup and a local Redis database 15.
process.env.NODE_ENV = "production";
process.env.STEPS_PROCESS_ROLE = "http";
process.env.DATABASE_POOL_MAX_HTTP = "8";
process.env.REDIS_URL = "";
process.env.CACHE_ENV_PREFIX = `t:large-team-discovery:${randomUUID()}:`;
const { cleanDatabase, prisma, createTestUser, getSharedServer, request } = require("./setup");
const { startTestRedis } = require("./redisTestServer");

const BASE = "characters,team_races,race_leave,home_suggested_races";
const headers = (large) => ({
  "X-Client-Features": `${BASE}${large ? ",team_races_10v10_v1" : ""}`,
  "X-App-Version": "2.3.13",
});
let server, live, probe, monitor;
let commands = [];

async function teamRace(size, overrides = {}) {
  return prisma.race.create({ data: {
    name: `Discovery ${size}v${size}`, status: "PENDING", targetSteps: 0,
    timeBased: true, maxDurationDays: 1, maxParticipants: size * 2,
    isPublic: true, isTeamRace: true, teamSize: size,
    teamAName: "Acorns", teamBName: "Berries", powerupsEnabled: false,
    ...overrides,
  } });
}

async function read(viewer, path, large) {
  const response = await request(server.baseUrl, "GET", path, {
    token: viewer.token, headers: headers(large),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

describe("10v10 discovery and existing membership compatibility", () => {
  before(async () => {
    await cleanDatabase();
    live = await startTestRedis();
    assert.ok(live, "warm compatibility regression needs local Redis");
    const url = new URL(live.url);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    assert.equal(url.pathname, "/15");
    process.env.REDIS_URL = live.url;
    await require("../../src/shared/cache/redisCache").close();
    probe = new IORedis(live.url);
    monitor = await probe.monitor();
    monitor.on("monitor", (_time, args) => { commands.push(args); });
    server = await getSharedServer();
  });
  beforeEach(async () => { await cleanDatabase(); commands = []; });
  after(async () => {
    await require("../../src/shared/cache/redisCache").close();
    monitor?.disconnect();
    await probe?.quit();
    await live?.close();
  });

  it("filters larger races consistently in public list, count and Home suggestions by current header", async () => {
    const viewer = await createTestUser({ displayName: "Discovery viewer" });
    const small = await teamRace(5, { createdAt: new Date("2026-01-01") });
    const large = [];
    for (let i = 0; i < 5; i++) large.push(await teamRace(6 + i));
    // Alternation also proves stored sticky user capabilities are NOT the
    // rendering authority when the same account next uses a frozen binary.
    for (const capable of [false, true, false, true]) {
      const publicBody = await read(viewer, "/races/public", capable);
      assert.equal(publicBody.races.length, capable ? 6 : 1);
      assert.ok(publicBody.races.some((race) => race.id === small.id));
      assert.equal(publicBody.races.some((race) => race.id === large[4].id), capable);
      const discovery = await read(viewer, "/races/discovery-summary", capable);
      assert.equal(discovery.resolved.publicRaceCount, true);
      assert.equal(discovery.publicRaceCount, capable ? 6 : 1);
      const home = await read(viewer, "/home/suggested-races", capable);
      const suggestions = home.suggestions.filter((row) => row.kind === "PUBLIC_RACE");
      assert.equal(suggestions.length, capable ? 4 : 1);
      if (!capable) assert.equal(suggestions[0].id, small.id,
        "unsupported newer races must be filtered BEFORE the suggestion limit");
    }
  });

  it("hides unsupported invitations but retains accepted pending and completed cards and earned coins", async () => {
    const viewer = await createTestUser({ displayName: "Member viewer" });
    const invited = await teamRace(10);
    const pending = await teamRace(10);
    const completed = await teamRace(10, {
      status: "COMPLETED", completedAt: new Date(), winnerTeam: "TEAM_A",
    });
    await prisma.raceParticipant.createMany({ data: [
      { raceId: invited.id, userId: viewer.user.id, status: "INVITED", team: "TEAM_A" },
      { raceId: pending.id, userId: viewer.user.id, status: "ACCEPTED", team: "TEAM_A" },
      { raceId: completed.id, userId: viewer.user.id, status: "ACCEPTED", team: "TEAM_A", payoutCoins: 100 },
    ] });
    for (const capable of [true, false, true, false]) {
      const body = await read(viewer, "/races", capable);
      const rows = [...body.pending, ...body.active, ...body.completed];
      assert.equal(rows.some((row) => row.id === invited.id), capable);
      assert.ok(rows.some((row) => row.id === pending.id));
      const reward = rows.find((row) => row.id === completed.id);
      assert.ok(reward, "downgrade cannot hide an earned result");
      assert.equal(reward.myPayoutCoins, 100);
    }
    await probe.ping();
    const fragmentReads = commands.filter(([op]) => op.toLowerCase() === "mget")
      .flatMap(([, ...keys]) => keys)
      .filter((key) => key.includes(viewer.user.id) && key.includes(":pending:"));
    for (const variant of [":tl0:", ":tl1:"]) {
      const reads = fragmentReads.filter((key) => key.includes(variant));
      assert.ok(reads.length >= 2, `must read cold then warm fragments for ${variant}`);
      assert.equal(await probe.exists(reads.at(-1)), 1, "observed fragment is actually cached");
    }
    assert.equal(await prisma.raceParticipant.count({ where: { userId: viewer.user.id } }), 3);
  });

  it("Home invitation count and primary invite omit only incompatible larger races", async () => {
    const viewer = await createTestUser({ displayName: "Invite viewer" });
    const owner = await createTestUser({ displayName: "Invite owner" });
    const big = await teamRace(10, { creatorId: owner.user.id, isPublic: false });
    const small = await teamRace(5, { creatorId: owner.user.id, isPublic: false });
    await prisma.raceParticipant.createMany({ data: [
      { raceId: big.id, userId: viewer.user.id, status: "INVITED", joinedAt: new Date("2026-01-01") },
      { raceId: small.id, userId: viewer.user.id, status: "INVITED", joinedAt: new Date("2026-01-02") },
    ] });
    for (const capable of [true, false, true, false]) {
      const body = await read(viewer, "/home/race-card", capable);
      assert.equal(body.state, "PENDING_INVITE");
      assert.equal(body.pendingInviteCount, capable ? 2 : 1);
      assert.equal(body.data.raceId, capable ? big.id : small.id);
    }
  });
});
