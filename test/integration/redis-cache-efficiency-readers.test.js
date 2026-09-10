const assert = require("node:assert/strict");
const { before, beforeEach, after, describe, it } = require("node:test");
const IORedis = require("ioredis");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const dbUrl = new URL(process.env.DATABASE_URL || "postgresql://invalid/unsafe");
assert.ok(["localhost", "127.0.0.1"].includes(dbUrl.hostname) && dbUrl.pathname.endsWith("_test"));
process.env.CACHE_ENV_PREFIX = "t:ce-readers:";
process.env.REDIS_URL = process.env.REDIS_TEST_URL || "redis://127.0.0.1:6401";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(process.env.REDIS_URL).hostname));
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { cleanDatabase, request, getSharedServer, createTestUser, prisma } = require("./setup");
let server, probe, child, sibling;
const queries = [];
const queryEvents = [];
async function get(path, user, features = "") {
  const response = await request(server.baseUrl, "GET", path, { token: user.token, headers: { "X-Client-Features": features } });
  assert.equal(response.status, 200);
  return response.json();
}
describe("Redis efficiency release B public reads", () => {
  before(async () => {
    for (const key of ["apiFriendsSummaryV1Enabled", "apiRaceBootstrapV1Enabled", "apiHomeShellV1Enabled", "apiImpactSummariesEnabled", "redisCacheHomeImpactSummaryEnabled", "redisCacheFriendsEnabled", "redisPresentationGenerationGuardEnabled"]) {
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
    }
    probe = new IORedis(process.env.REDIS_URL);
    server = await getSharedServer();
    child = spawn(process.execPath, ["test/integration/helpers/standaloneServer.js"], {
      cwd: process.env.CACHE_TEST_WRITER_ROOT || process.cwd(), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    sibling = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sibling API failed to start")), 10000);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Sibling exited ${code}`)); });
      child.stdout.on("data", bytes => { const match = String(bytes).match(/LISTENING (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    prisma.$on("query", (event) => { queries.push(event.query); queryEvents.push(event); });
  });
  beforeEach(async () => {
    await cleanDatabase();
    const keys = await probe.keys("t:ce-readers:*");
    if (keys.length) await probe.del(...keys);
    queries.length = 0;
  });
  after(async () => {
    await probe.quit();
    if (child?.exitCode === null) { const closed = once(child, "exit"); child.kill("SIGTERM"); await closed; }
  });

  it("stores explicit empty summaries for 15 seconds and avoids their SQL on a warm HTTP read", async () => {
    const user = await createTestUser({ displayName: "Empty Summary" });
    const features = "impact_summaries,impact_summary_expiry_v1";
    const first = await get("/home/race-card", user, features);
    const key = `t:ce-readers:ce:v1:summary:${user.user.id}`;
    const value = JSON.parse(await probe.get(key));
    assert.deepEqual(value.value, { kind: "empty" });
    assert.ok(await probe.pttl(key) <= 15000);
    queries.length = 0;
    const second = await get("/home/race-card", user, features);
    assert.equal(first.globalEventSummary, undefined);
    assert.equal(second.globalEventSummary, undefined);
    assert.equal(queries.filter((sql) => /FROM global_event_user_summaries s/.test(sql)).length, 0);
  });

  it("expires only the pending list fragment and preserves the completed payload and wire result", async () => {
    const user = await createTestUser({ displayName: "Split List" });
    const response = await request(server.baseUrl, "POST", "/races", { token: user.token, body: { name: "Pending Fragment", targetSteps: 50000, maxDurationDays: 7 } });
    assert.equal(response.status, 201);
    const first = await get("/races", user);
    assert.deepEqual(Object.keys(first.pending[0].creator).sort(), ["displayName", "id", "profilePhotoUrl"]);
    const keys = await probe.keys(`t:ce-readers:ce:v1:list:${user.user.id}:*`);
    assert.equal(keys.length, 3);
    const pending = keys.find((key) => key.includes(":pending:"));
    const completed = keys.find((key) => key.includes(":completed:"));
    const active = keys.find((key) => key.includes(":membership:"));
    assert.ok(await probe.ttl(pending) <= 60);
    assert.ok(await probe.ttl(completed) > 850);
    assert.ok(await probe.ttl(active) > 100);
    const retained = await probe.get(completed);
    await probe.del(pending);
    const second = await get("/races", user);
    assert.equal(await probe.get(completed), retained);
    assert.deepEqual(second.pending.map((row) => [row.id, row.name]), first.pending.map((row) => [row.id, row.name]));
    for (const key of keys) {
      const box = JSON.parse(await probe.get(key));
      for (const race of box.races) {
        assert.equal("creator" in race, false);
        assert.equal("winner" in race, false);
        assert.equal("myStatus" in race, false);
      }
    }
  });
  it("hydrates mutable catalog fields on warm Home equipment references and preserves friend summaries", async () => {
    const user = await createTestUser({ displayName: "Equipment Owner" });
    const friend = await createTestUser({ displayName: "Cached Friend" });
    await prisma.friendship.create({ data: { requesterId: user.user.id, addresseeId: friend.user.id, status: "ACCEPTED" } });
    const item = await prisma.shopItem.create({ data: { sku: `ce-${Date.now()}`, name: "Original Hat", slot: "HEAD", priceCoins: 10, assetKey: "ce_hat" } });
    await prisma.userEquippedAccessory.create({ data: { userId: user.user.id, shopItemId: item.id, slot: "HEAD" } });
    const path = "/home/race-card?view=shell-v1";
    const features = "home_shell_v1,home_active_races,characters,remote_assets";
    const first = await get(path, user, features);
    assert.equal(first.contract, "home-shell-v1");
    assert.equal(first.presentation.equipped.HEAD.name, "Original Hat");
    assert.equal(first.friends.friends[0].displayName, "Cached Friend");
    const key = `t:ce-readers:v1:user:cosmetics:${user.user.id}:ce:v1`;
    const envelope = JSON.parse(await probe.get(key));
    assert.deepEqual(envelope.value.equipment, [{ slot: "HEAD", shopItemId: item.id }]);
    assert.equal("coins" in envelope.value, false);
    assert.equal(JSON.stringify(envelope).includes("Original Hat"), false);
    await prisma.shopItem.update({ where: { id: item.id }, data: { name: "Catalog Changed" } });
    queries.length = 0;
    queryEvents.length = 0;
    const second = await get(path, user, features);
    assert.equal(second.presentation.equipped.HEAD.name, "Catalog Changed");
    assert.equal(second.friends.friends[0].displayName, "Cached Friend");
    assert.equal(queryEvents.filter((event) => /user_equipped_accessories/.test(event.query) && event.params.includes(user.user.id)).length, 0);
    console.log("Home warm SQL total", queries.length);
    assert.equal(queries.filter((sql) => /FROM "?public"?\."friendships"|FROM friendships/.test(sql)).length, 0);
  });

  it("refreshes empty invite candidates after an HTTP invite and keeps metadata/counts out of the candidate", async () => {
    const owner = await createTestUser({ displayName: "Inviter Cached" });
    const viewer = await createTestUser({ displayName: "Invite Viewer" });
    await prisma.friendship.create({ data: { requesterId: owner.user.id, addresseeId: viewer.user.id, status: "ACCEPTED" } });
    await get("/home/race-card", viewer);
    const key = `t:ce-readers:ce:v1:invites:${viewer.user.id}`;
    assert.deepEqual(JSON.parse(await probe.get(key)).value, []);
    const created = await request(server.baseUrl, "POST", "/races", { token: owner.token, body: { name: "Cache Invitation", targetSteps: 50000, maxDurationDays: 7 } });
    const race = (await created.json()).race;
    const invite = await request(server.baseUrl, "POST", `/races/${race.id}/invite`, { token: owner.token, body: { inviteeIds: [viewer.user.id] } });
    assert.equal(invite.status, 200);
    const first = await get("/home/race-card", viewer);
    assert.equal(first.state, "PENDING_INVITE");
    assert.equal(first.data.name, "Cache Invitation");
    assert.equal(first.data.inviter.displayName, "Inviter Cached");
    const candidates = JSON.parse(await probe.get(key)).value;
    assert.equal(candidates.length, 1);
    assert.deepEqual(Object.keys(candidates[0]).sort(), ["createdAt", "expiresAt", "inviterId", "participantId", "raceId"]);
    for (const domain of ["race-meta", "race-members"]) assert.ok(await probe.ttl(`t:ce-readers:ce:v1:${domain}:${race.id}`) > 250);
    const renamed = await request(server.baseUrl, "PATCH", `/races/${race.id}`, { token: owner.token, body: { name: "Updated Invitation" } });
    assert.equal(renamed.status, 200);
    assert.equal((await get("/home/race-card", viewer)).data.name, "Updated Invitation");
    const decline = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, { token: viewer.token, body: { accept: false } });
    assert.equal(decline.status, 200);
    assert.notEqual((await get("/home/race-card", viewer)).state, "PENDING_INVITE");
  });

  it("caches viewer event display without changing the authenticated progress banner", async () => {
    const user = await createTestUser({ displayName: "Event Display" });
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: "Event Cache", targetSteps: 500000,
      status: "ACTIVE", startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000) } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: user.user.id, status: "ACCEPTED" } });
    const event = await prisma.globalStepEvent.create({ data: { startsAt: new Date(Date.now() - 10000), endsAt: new Date(Date.now() + 60000), multiplier: 2 } });
    const first = (await get(`/races/${race.id}/progress`, user)).progress;
    assert.equal(first.globalEvent.multiplier, 2);
    const keys = await probe.keys(`t:ce-readers:ce:v1:event-display:${race.id}:${user.user.id}:*`);
    assert.equal(keys.length, 1);
    const envelope = JSON.parse(await probe.get(keys[0]));
    assert.equal(envelope.value.eventId, event.id);
    assert.ok(await probe.pttl(keys[0]) <= 30000);
    assert.deepEqual((await get(`/races/${race.id}/progress`, user)).progress.globalEvent, first.globalEvent);
    assert.equal(await probe.get(keys[0]), JSON.stringify(envelope));
  });

  it("shares descriptive metadata across authenticated bootstrap reads while retaining fresh access", async () => {
    const user = await createTestUser({ displayName: "Bootstrap Cache" });
    const race = await prisma.race.create({ data: { creatorId: user.user.id, name: "Bootstrap metadata", targetSteps: 500000,
      status: "ACTIVE", startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 86400000),
      participants: { create: { userId: user.user.id, status: "ACCEPTED" } } } });
    const response = await get(`/races/${race.id}/bootstrap`, user);
    assert.equal(response.race.name, race.name);
    const key = `t:ce-readers:ce:v1:race-meta:${race.id}`;
    const cached = JSON.parse(await probe.get(key));
    assert.equal(cached.value.name, race.name);
    assert.equal("status" in cached.value, false);
    assert.equal("potCoins" in cached.value, false);
    assert.equal("participants" in cached.value, false);
    assert.equal((await get(`/races/${race.id}/bootstrap`, user)).race.name, race.name);
    const stranger = await createTestUser({ displayName: "No Access" });
    const denied = await request(server.baseUrl, "GET", `/races/${race.id}/bootstrap`, { token: stranger.token });
    assert.equal(denied.status, 403);
  });

  it("observes another API worker's friend request, acceptance, identity update and removal immediately", async () => {
    const alice = await createTestUser({ displayName: "Alice Cached" });
    const bob = await createTestUser({ displayName: "Bob Cached" });
    const path = "/friends?view=summary-v1";
    assert.deepEqual((await get(path, alice)).friends, []);
    const sent = await request(sibling, "POST", "/friends/request", { token: bob.token, body: { addresseeId: alice.user.id } });
    assert.equal(sent.status, 201);
    const friendship = (await sent.json()).friendship;
    const pending = await get(path, alice);
    assert.equal(pending.incomingFriendRequests, 1);
    assert.deepEqual(Object.keys(pending.pending.incoming[0].user).sort(), ["displayName", "firstName", "id", "lastName", "profilePhotoUrl"]);
    const accepted = await request(sibling, "PUT", `/friends/request/${friendship.id}`, { token: alice.token, body: { accept: true } });
    assert.equal(accepted.status, 200);
    assert.equal((await get(path, alice)).friends[0].displayName, "Bob Cached");
    const changed = await request(sibling, "PUT", "/auth/me/discoverable-name", { token: bob.token, body: { firstName: "Bobby", lastName: "Walker" } });
    assert.equal(changed.status, 200);
    const completed = await request(sibling, "PUT", "/auth/me/display-name", { token: bob.token,
      body: { displayName: "BobbyRunner", completeDiscoverableNameSetup: true } });
    assert.equal(completed.status, 200);
    assert.equal((await get(path, alice)).friends[0].discoverableName, "Bobby Walker");
    const removed = await request(sibling, "DELETE", `/friends/${friendship.id}`, { token: alice.token });
    assert.equal(removed.status, 200);
    assert.deepEqual((await get(path, alice)).friends, []);
  });

  it("treats malformed null candidate and equipment rows as misses through real Home HTTP", async () => {
    const user = await createTestUser({ displayName: "MalformedReader" });
    const route = "/home/race-card?view=shell-v1";
    const first = await get(route, user, "home_shell_v1");
    const equipmentKey = `t:ce-readers:v1:user:cosmetics:${user.user.id}:ce:v1`;
    const equipment = JSON.parse(await probe.get(equipmentKey));
    equipment.value.equipment = [null];
    await probe.set(equipmentKey, JSON.stringify(equipment), "EX", 3600);
    const inviteKey = `t:ce-readers:ce:v1:invites:${user.user.id}`;
    const invites = JSON.parse(await probe.get(inviteKey));
    invites.value = [null];
    await probe.set(inviteKey, JSON.stringify(invites), "EX", 60);
    const second = await get(route, user, "home_shell_v1");
    assert.deepEqual(second.presentation, first.presentation);
    assert.equal(second.resolved.presentation, true);
    assert.deepEqual(JSON.parse(await probe.get(inviteKey)).value, []);
    assert.deepEqual(JSON.parse(await probe.get(equipmentKey)).value.equipment, []);
  });

});
