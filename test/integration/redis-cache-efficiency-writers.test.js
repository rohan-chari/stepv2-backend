const assert = require("node:assert/strict");
const { before, beforeEach, after, describe, it } = require("node:test");
const IORedis = require("ioredis");
process.env.CACHE_ENV_PREFIX = "t:ce-writers:";
process.env.REDIS_URL = process.env.REDIS_TEST_URL || "redis://127.0.0.1:6401";
const databaseUrl = new URL(process.env.DATABASE_URL || "postgresql://invalid/unsafe");
assert.ok(["localhost", "127.0.0.1"].includes(databaseUrl.hostname) && databaseUrl.pathname.endsWith("_test"),
  "Writer fixtures require an explicit local *_test DATABASE_URL before setup loads");
const { cleanDatabase, request, getSharedServer, createTestUser, prisma } = require("./setup");

let server;
let probe;
const key = (domain, id) => `t:ce-writers:ce:v1:g:${domain}:${id}`;
async function marker(domain, id) {
  const token = await probe.get(key(domain, id));
  assert.match(token || "", /^[a-f0-9-]{36}$/, `${domain} must be fenced before HTTP returns`);
  return token;
}
async function createRace(user) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: user.token, body: { name: "Writer fence race", targetSteps: 50000, maxDurationDays: 7 },
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).race;
}

describe("Redis efficiency release A awaited public writer fencing", () => {
  before(async () => {
    const redisUrl = new URL(process.env.REDIS_URL);
    assert.ok(["localhost", "127.0.0.1"].includes(redisUrl.hostname));
    probe = new IORedis(process.env.REDIS_URL);
    await prisma.appSetting.upsert({ where: { key: "apiImpactSummariesEnabled" }, create: { key: "apiImpactSummariesEnabled", value: true }, update: { value: true } });
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await probe.keys("t:ce-writers:*");
    if (keys.length) await probe.del(...keys);
  });
  after(async () => { await probe.quit(); });

  it("creation and edit advance shared race tokens before the mutation response", async () => {
    const alice = await createTestUser({ displayName: "Alice Fence" });
    const race = await createRace(alice);
    const previous = await marker("race-meta", race.id);
    await marker("race-members", race.id);
    await marker("list", alice.user.id);
    const response = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
      token: alice.token, body: { name: "Renamed fenced race" },
    });
    assert.equal(response.status, 200);
    assert.notEqual(await marker("race-meta", race.id), previous);
    const list = await request(server.baseUrl, "GET", "/races", { token: alice.token });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.pending.find((row) => row.id === race.id).name, "Renamed fenced race");
  });

  it("invite and decline immediately fence both users and race membership", async () => {
    const alice = await createTestUser({ displayName: "Alice Invite" });
    const bob = await createTestUser({ displayName: "Bob Invite" });
    await prisma.friendship.create({ data: { requesterId: alice.user.id, addresseeId: bob.user.id, status: "ACCEPTED" } });
    const race = await createRace(alice);
    const before = await marker("race-members", race.id);
    const invite = await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      token: alice.token, body: { inviteeIds: [bob.user.id] },
    });
    assert.equal(invite.status, 200, JSON.stringify(await invite.clone().json()));
    const invited = await marker("invites", bob.user.id);
    await marker("invites", alice.user.id);
    assert.notEqual(await marker("race-members", race.id), before);
    const decline = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
      token: bob.token, body: { accept: false },
    });
    assert.equal(decline.status, 200, JSON.stringify(await decline.clone().json()));
    assert.notEqual(await marker("invites", bob.user.id), invited);
    const list = await request(server.baseUrl, "GET", "/races", { token: bob.token });
    const body = await list.json();
    assert.equal([...(body.pending || []), ...(body.active || [])].some((row) => row.id === race.id), false);
  });

  it("discoverable identity changes remove the additive presentation payload before returning", async () => {
    const user = await createTestUser({ displayName: "Named Friend" });
    const payloadKey = `t:ce-writers:v1:user:cosmetics:${user.user.id}:ce:v1`;
    await probe.set(payloadKey, JSON.stringify({ old: true }), "EX", 3600);
    const response = await request(server.baseUrl, "PUT", "/auth/me/discoverable-name", {
      token: user.token, body: { firstName: "Alice", lastName: "Walker" },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(await probe.get(payloadKey), null);
  });

  it("summary acknowledgement advances its marker and leaves other users isolated", async () => {
    const user = await createTestUser({ displayName: "Summary Viewer" });
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000), multiplier: 2,
    } });
    const summary = await prisma.globalEventUserSummary.create({ data: {
      eventId: event.id, userId: user.user.id, extraRaceSteps: 400, raceCount: 1,
    } });
    const response = await request(server.baseUrl, "POST", `/home/global-event-summaries/${summary.id}/acknowledge`, {
      token: user.token, headers: { "X-Client-Features": "impact_summaries" },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    await marker("summary", user.user.id);
  });

  it("a rejected edit does not advance another viewer's marker", async () => {
    const alice = await createTestUser({ displayName: "Alice Fence" });
    const bob = await createTestUser({ displayName: "Bob Fence" });
    const race = await createRace(alice);
    const previous = await marker("race-meta", race.id);
    const response = await request(server.baseUrl, "PATCH", `/races/${race.id}`, {
      token: bob.token, body: { name: "Forbidden" },
    });
    assert.equal(response.status, 403);
    assert.equal(await marker("race-meta", race.id), previous);
    assert.equal(await probe.get(key("list", bob.user.id)), null);
  });
});
