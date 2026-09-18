const assert = require("node:assert/strict");
const { before, after, beforeEach, describe, it } = require("node:test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase, createTestUser, startServer, request } = require("./setup");

const servers = [];
let observed = null;
function settings(parallel) {
  return { async getFlag(key) {
    return key === "apiHomeShellV1Enabled" ||
      (key === "homeRaceCardParallelOptionalV1Enabled" && parallel);
  } };
}
const coreOf = ({ contract, resolved, presentation, friends, ...core }) => core;
const query = (view) => `/home/race-card?view=${view}&homeActiveRaces=1&localDate=2026-09-09`;
async function get(server, token, view, headers) {
  const res = await request(server.baseUrl, "GET", query(view), { token, headers });
  return { status: res.status, body: await res.json() };
}
describe("Home sync refresh contract", () => {
  before(async () => {
    prisma.$on("query", ({ query }) => { if (observed) observed.push(query); });
    for (const parallel of [false, true]) servers.push(await startServer({ appSettings: settings(parallel) }));
  });
  after(async () => { await Promise.all(servers.map((s) => s.close())); });
  beforeEach(cleanDatabase);

  it("preserves populated full core across capabilities and both assembly settings", async () => {
    const viewer = await createTestUser({ displayName: "Viewer", coins: 321 });
    const friend = await createTestUser({ displayName: "Friend" });
    await prisma.friendship.create({ data: { requesterId: viewer.user.id, addresseeId: friend.user.id, status: "ACCEPTED" } });
    const race = await prisma.race.create({ data: { creatorId: viewer.user.id, name: "Joined race", targetSteps: 10000,
      status: "ACTIVE", startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() + 3600000), isPublic: false } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: viewer.user.id, status: "ACCEPTED" } });
    await prisma.globalStepEvent.create({ data: { startsAt: new Date(Date.now() - 3600000),
      endsAt: new Date(Date.now() + 3600000), multiplier: 2, scheduleMode: "LEGACY_GLOBAL" } });
    for (const server of servers) {
      for (const headers of [
        { "X-App-Version": "2.2.4", "X-Client-Features": "" },
        { "X-App-Version": "2.3.13", "X-Client-Features": "characters,remote_assets,team_races,next_race_cta,ads,inbox_v1,impact_summaries,impact_summary_expiry_v1" },
      ]) {
        const full = await get(server, viewer.token, "shell-v1", headers);
        const narrow = await get(server, viewer.token, "sync-refresh-v1", headers);
        assert.equal(full.status, 200);
        assert.equal(full.body.contract, "home-shell-v1");
        assert.equal(full.body.presentation.coins, 321);
        assert.equal(full.body.friends.friends.length, 1);
        assert.deepEqual(narrow, { status: 200, body: {
          contract: "home-sync-refresh-v1", home: coreOf(full.body), retainedSections: ["presentation", "friends"],
        } });
        const legacy = await get(server, viewer.token, "unknown", headers);
        assert.deepEqual(legacy.body, coreOf(full.body));
      }
    }
  });

  it("never executes shell equipment, cape or friendship presentation queries", async () => {
    const viewer = await createTestUser();
    const headers = { "X-App-Version": "2.3.13" };
    observed = [];
    const full = await get(servers[0], viewer.token, "shell-v1", headers);
    const fullSql = observed;
    observed = [];
    const narrow = await get(servers[0], viewer.token, "sync-refresh-v1", headers);
    const narrowSql = observed;
    observed = null;
    assert.equal(full.status, 200);
    assert.equal(narrow.body.contract, "home-sync-refresh-v1");
    assert.ok(fullSql.some((q) => /user_equipped_accessories/.test(q)));
    assert.ok(fullSql.some((q) => /friendships/.test(q)));
    // Core race discovery also reads equipment/friend IDs. Compare the exact
    // legacy core path to attribute only the two skipped presentation services.
    observed = [];
    const legacy = await get(servers[0], viewer.token, "unknown", headers);
    const coreSql = observed;
    observed = null;
    assert.equal(legacy.status, 200);
    const presentationSql = (queries) => queries.filter((q) => /user_equipped_accessories|shop_items|friendships/.test(q)).sort();
    assert.deepEqual(presentationSql(narrowSql), presentationSql(coreSql));
    assert.ok(presentationSql(fullSql).length > presentationSql(narrowSql).length);
  });

  it("keeps optional failure semantics and existing authorization", async () => {
    const viewer = await createTestUser();
    const server = await startServer({ appSettings: settings(true),
      getStepMilestonesToday: async () => { throw new Error("injected optional failure"); } });
    try {
      const headers = { "X-App-Version": "2.3.13" };
      const full = await get(server, viewer.token, "shell-v1", headers);
      const narrow = await get(server, viewer.token, "sync-refresh-v1", headers);
      assert.equal(narrow.status, 200);
      assert.deepEqual(narrow.body.home, coreOf(full.body));
      assert.equal(narrow.body.home.stepMilestones, undefined);
      assert.equal((await get(server, null, "sync-refresh-v1", headers)).status, 401);
      assert.equal((await get(server, "invalid", "sync-refresh-v1", headers)).status, 401);
    } finally { await server.close(); }
  });
  it("returns the existing 500 body when required core assembly fails", async () => {
    const viewer = await createTestUser();
    const server = await startServer({ appSettings: settings(false),
      getHomeRaceCard: async () => { throw new Error("injected core failure"); } });
    try {
      for (const view of ["shell-v1", "sync-refresh-v1"]) {
        assert.deepEqual(await get(server, viewer.token, view, { "X-App-Version": "2.3.13" }), {
          status: 500, body: { error: "Internal server error" },
        });
      }
    } finally { await server.close(); }
  });

});
