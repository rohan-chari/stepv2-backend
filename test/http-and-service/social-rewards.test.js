const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");

let server;

describe("social rewards API", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("returns all platforms and preserves open/claim state", async () => {
    const user = await createTestUser();
    const status = await request(server.baseUrl, "GET", "/social-rewards/status", { token: user.token });
    assert.equal(status.status, 200);
    assert.deepEqual((await status.json()).rewards.map((r) => [r.platform, r.handle, r.amount, r.state]), [
      ["instagram", "@bara.steps.app", 200, "not_started"],
      ["tiktok", "@bara.app", 200, "not_started"],
      ["x", "@BaraStepsApp", 200, "not_started"],
    ]);
    const opened = await request(server.baseUrl, "POST", "/social-rewards/instagram/open", { token: user.token });
    assert.equal((await opened.json()).state, "opened");
    const claimed = await request(server.baseUrl, "POST", "/social-rewards/instagram/claim", { token: user.token, body: { amount: 999999 } });
    const claimBody = await claimed.json();
    assert.equal(claimBody.awarded, true); assert.equal(claimBody.amount, 200); assert.equal(claimBody.coins, 200);
    const retry = await request(server.baseUrl, "POST", "/social-rewards/instagram/claim", { token: user.token });
    assert.equal((await retry.json()).awarded, false);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.user.id, reason: "social_follow_reward", refId: "instagram" } }), 1);
  });

  it("rejects unauthenticated, invalid, and unopened claims", async () => {
    assert.equal((await request(server.baseUrl, "GET", "/social-rewards/status")).status, 401);
    const user = await createTestUser();
    assert.equal((await request(server.baseUrl, "POST", "/social-rewards/facebook/open", { token: user.token })).status, 400);
    const unopened = await request(server.baseUrl, "POST", "/social-rewards/x/claim", { token: user.token });
    assert.equal(unopened.status, 409);
  });

  it("concurrent claims grant exactly once", async () => {
    const user = await createTestUser();
    await request(server.baseUrl, "POST", "/social-rewards/tiktok/open", { token: user.token });
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(server.baseUrl, "POST", "/social-rewards/tiktok/claim", { token: user.token })));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(bodies.filter((body) => body.awarded === true).length, 1);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.user.id, reason: "social_follow_reward", refId: "tiktok" } }), 1);
    assert.equal((await prisma.user.findUnique({ where: { id: user.user.id }, select: { coins: true } })).coins, 200);
    assert.equal(await prisma.socialRewardClaim.count({ where: { userId: user.user.id, platform: "tiktok", claimedAt: { not: null } } }), 1);
  });
});
