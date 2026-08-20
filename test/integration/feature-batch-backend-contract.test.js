const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { etDayKey } = require("../../src/shared/time/etSchedule");

let server;
const ADMIN_EMAIL = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

describe("2026-07-22 additive backend contracts", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({ where: { key: "dualBoxBannersEnabled" } });
    // App-funded prize pools now default ON and zero buy-ins at create; the
    // buy-in assertions here belong to the legacy model, so pin the flag OFF.
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
    await appSettings.setFlag("redisCacheCatalogsEnabled", false);
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
    // `steps.date` is a @db.Date, which Prisma fills from the JS Date's UTC
    // calendar date — but the DAU query buckets by
    // `(now() AT TIME ZONE 'America/New_York')::date`. Deriving the row from
    // `new Date()` therefore lands it on the UTC day, which is NOT the ET day
    // once UTC has rolled over for the night — from 20:00 ET under EDT (UTC-4)
    // and from 19:00 ET under EST (UTC-5) — and the watcher silently drops out
    // of DAU. That is 4-5 hours of every day. So anchor to the ET calendar day
    // explicitly via the app's own ET helper: it reads wall-clock ET through
    // Intl, so it tracks the EDT/EST offset change on its own rather than
    // assuming a fixed -4 or -5. Noon UTC keeps the instant far from either
    // midnight, so no further rounding can move it off the intended day.
    const today = new Date(`${etDayKey(new Date())}T12:00:00.000Z`);
    await prisma.step.create({ data: { userId: watcher.user.id, date: today, steps: 10 } });
    await prisma.adRewardGrant.createMany({ data: [
      { userId: watcher.user.id, transactionId: "coin-1", rewardKind: "coin_reward", grantedDate: "ignored" },
      { userId: watcher.user.id, transactionId: "coin-2", rewardKind: "coin_reward", grantedDate: "ignored" },
      { userId: watcher.user.id, transactionId: "spin-1", rewardKind: "extra_daily_spin", grantedDate: "ignored" },
      { userId: watcher.user.id, transactionId: "reroll-1", rewardKind: "box_reroll", grantedDate: "ignored" },
      { userId: nonDau.user.id, transactionId: "coin-nondau", rewardKind: "coin_reward", grantedDate: "ignored" },
    ] });
    const res = await request(server.baseUrl, "GET", "/admin/stats", { token: admin.token });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).stats.activity.rewardedAds, {
      timeZone: "America/New_York",
      coinReward: { uniqueDauWatchers: 1, pctOfDau: 100 },
      extraSpin: { uniqueDauWatchers: 1, pctOfDau: 100 },
      boxReroll: { uniqueDauWatchers: 1, pctOfDau: 100 },
    });
  });

  it("GET /powerups/catalog selects copy and Quicksand by request capabilities", async () => {
    // Powerup copy is operational data and deliberately survives the shared
    // database cleanup. Own these rows explicitly so this compatibility test
    // never inherits a seed written by an earlier suite.
    await prisma.powerupCopy.deleteMany({
      where: { powerupType: { in: ["STEALTH_MODE", "HITCHHIKE", "QUICKSAND"] } },
    });
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
    // §3.4 standardization (2026-07-25, supersedes the 07-24 nerf): stealth
    // labels come straight from the DB row for every client, including ones
    // advertising `stealth_runner_duration` (prod bug 2026-07-29: the override
    // served the dead 60/75/90/120 ladder to exactly the newest builds).
    assert.deepEqual(next.powerups.find((p) => p.type === "STEALTH_MODE").upgradeTierLabels, ["Hide 1h", "Hide 2h", "Hide 3h", "Hide 4h"]);
    assert.match(next.powerups.find((p) => p.type === "HITCHHIKE").description, /boosts and reversals/i);
  });
});
