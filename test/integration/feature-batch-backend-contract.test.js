const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require("./setup");

let server;
const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

describe("2026-07-22 additive backend contracts", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({ where: { key: "dualBoxBannersEnabled" } });
  });

  it("serves and patches dualBoxBannersEnabled while /auth/me defaults it off", async () => {
    const { user, token } = await createTestUser({ email: ADMIN_EMAIL });
    const me = await request(server.baseUrl, "GET", "/auth/me", { token });
    assert.equal((await me.json()).user.featureFlags.dualBoxBannersEnabled, false);

    const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
      token, body: { dualBoxBannersEnabled: true },
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).settings.dualBoxBannersEnabled, true);
    assert.ok(user.id);
  });

  it("GET /admin/stats counts distinct stepped-today verified watchers by placement", async () => {
    const admin = await createTestUser({ email: ADMIN_EMAIL });
    const watcher = await createTestUser();
    const nonDau = await createTestUser();
    const today = new Date(); today.setUTCHours(12, 0, 0, 0);
    await prisma.step.create({ data: { userId: watcher.user.id, date: today, steps: 10 } });
    await prisma.adRewardGrant.createMany({ data: [
      { userId: watcher.user.id, transactionId: "coin-1", rewardKind: "coin_reward", grantedDate: "ignored" },
      { userId: watcher.user.id, transactionId: "coin-2", rewardKind: "coin_reward", grantedDate: "ignored" },
      { userId: watcher.user.id, transactionId: "spin-1", rewardKind: "extra_daily_spin", grantedDate: "ignored" },
      { userId: nonDau.user.id, transactionId: "coin-nondau", rewardKind: "coin_reward", grantedDate: "ignored" },
    ] });
    const res = await request(server.baseUrl, "GET", "/admin/stats", { token: admin.token });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).stats.activity.rewardedAds, {
      timeZone: "America/New_York",
      coinReward: { uniqueDauWatchers: 1, pctOfDau: 100 },
      extraSpin: { uniqueDauWatchers: 1, pctOfDau: 100 },
    });
  });

  it("GET /powerups/catalog selects copy and Quicksand by request capabilities", async () => {
    await prisma.powerupCopy.createMany({ data: [
      { powerupType: "STEALTH_MODE", name: "Stealth Mode", description: "Hide for 1 hour", upgradeTierLabels: ["Hide 1h", "Hide 2h", "Hide 3h", "Hide 4h"] },
      { powerupType: "HITCHHIKE", name: "Hitchhike", description: "Copy raw steps", upgradeTierLabels: [] },
      { powerupType: "QUICKSAND", name: "Quicksand", description: "Freeze three", upgradeTierLabels: [] },
    ], skipDuplicates: true });
    const oldRes = await request(server.baseUrl, "GET", "/powerups/catalog");
    const old = await oldRes.json();
    assert.equal(old.powerups.some((p) => p.type === "QUICKSAND"), false);
    assert.match(old.powerups.find((p) => p.type === "STEALTH_MODE").description, /1 hour/);

    const nextRes = await request(server.baseUrl, "GET", "/powerups/catalog", { headers: {
      "X-Client-Features": "powerups4,stealth_runner_duration,hitchhike_effective_steps",
    } });
    const next = await nextRes.json();
    assert.ok(next.powerups.some((p) => p.type === "QUICKSAND"));
    // Item 7 (owner nerf 2026-07-24): stealth durations are now 60/75/90/120 min.
    assert.deepEqual(next.powerups.find((p) => p.type === "STEALTH_MODE").upgradeTierLabels, ["Hide 1h", "Hide 75m", "Hide 90m", "Hide 2h"]);
    assert.match(next.powerups.find((p) => p.type === "HITCHHIKE").description, /boosts and reversals/i);
  });
});
