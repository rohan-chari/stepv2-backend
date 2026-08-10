const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { prisma, cleanDatabase, request, getSharedServer } = require("./setup");

// Batch 2026-08-09 — the two backend-only, contract-shaped items.
//
//   Item 9  — `tutorialMandatoryEnabled` remote kill switch for the mandatory
//             onboarding tutorial. Backend deploys FIRST, default OFF.
//   Item 10 — `GET /admin/stats?sections=` opt-in aggregate blocks.
//
// Real HTTP, real DB, real handler chain. `npm run test:integration` pins
// DATABASE_URL to the local steps-tracker-integration database.
describe("feature batch 2026-08-09 (backend)", () => {
  let server;
  let nextAppleId = 0;

  const ADMIN_EMAIL =
    process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    // app_settings is NOT truncated by cleanDatabase and is shared with every
    // other suite — clear ONLY the key this suite writes.
    await prisma.appSetting.deleteMany({
      where: { key: "tutorialMandatoryEnabled" },
    });
    nextAppleId = 0;
  });

  async function signUp() {
    const appleId = `apple-batch-0809-${++nextAppleId}-${Date.now()}`;
    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: appleId },
    });
    assert.equal(res.status, 200, "signup should succeed");
    const body = await res.json();
    return { userId: body.user.id, token: body.sessionToken, user: body.user };
  }

  async function signUpAdmin() {
    const admin = await signUp();
    await prisma.user.update({
      where: { id: admin.userId },
      data: { email: ADMIN_EMAIL },
    });
    return admin;
  }

  // ── Item 9 — tutorialMandatoryEnabled ─────────────────────────────────────

  describe("item 9 — tutorialMandatoryEnabled flag", () => {
    it("is served on /auth/me and defaults to false", async () => {
      const { token } = await signUp();
      const res = await request(server.baseUrl, "GET", "/auth/me", { token });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.user.featureFlags.tutorialMandatoryEnabled, false);
    });

    it("is additive — the pre-existing flags are still served", async () => {
      const { token } = await signUp();
      const res = await request(server.baseUrl, "GET", "/auth/me", { token });
      const body = await res.json();
      // VALUES are not asserted: app_settings is shared across suites and
      // another suite may legitimately have flipped one. Presence + type is
      // the compat property that matters for a frozen client.
      for (const key of [
        "onboardingV2Enabled",
        "onboardingV3Enabled",
        "bannerAdsEnabled",
        "dualBoxBannersEnabled",
        "teamRacesEnabled",
      ]) {
        assert.equal(
          typeof body.user.featureFlags[key],
          "boolean",
          `${key} still served`
        );
      }
    });

    it("PATCH /admin/settings flips it and /auth/me reflects it", async () => {
      const admin = await signUpAdmin();
      const patch = await request(server.baseUrl, "PATCH", "/admin/settings", {
        token: admin.token,
        body: { tutorialMandatoryEnabled: true },
      });
      assert.equal(patch.status, 200);
      const patched = await patch.json();
      assert.equal(patched.settings.tutorialMandatoryEnabled, true);

      const { token } = await signUp();
      const me = await request(server.baseUrl, "GET", "/auth/me", { token });
      const body = await me.json();
      assert.equal(body.user.featureFlags.tutorialMandatoryEnabled, true);
    });

    it("can be flipped back OFF — this is the kill switch, not a one-way door", async () => {
      const admin = await signUpAdmin();
      await request(server.baseUrl, "PATCH", "/admin/settings", {
        token: admin.token,
        body: { tutorialMandatoryEnabled: true },
      });
      const off = await request(server.baseUrl, "PATCH", "/admin/settings", {
        token: admin.token,
        body: { tutorialMandatoryEnabled: false },
      });
      assert.equal(off.status, 200);

      const { token } = await signUp();
      const me = await request(server.baseUrl, "GET", "/auth/me", { token });
      const body = await me.json();
      assert.equal(body.user.featureFlags.tutorialMandatoryEnabled, false);
    });
  });

  // ── Item 8 — Lucky Horseshoe rework ───────────────────────────────────────

  describe("item 8 — Lucky Horseshoe", () => {
    let earnCounter = 0;
    const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

    async function activeRace(creator, opponents) {
      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: {
          name: "Horseshoe Race",
          targetSteps: 200000,
          maxDurationDays: 7,
          powerupsEnabled: true,
          powerupStepInterval: 5000,
        },
        token: creator.token,
      });
      const raceId = (await createRes.json()).race.id;
      for (const o of opponents) {
        const fr = await request(server.baseUrl, "POST", "/friends/request", {
          body: { addresseeId: o.userId },
          token: creator.token,
        });
        const fid = (await fr.json()).friendship.id;
        await request(server.baseUrl, "PUT", `/friends/request/${fid}`, {
          body: { accept: true },
          token: o.token,
        });
      }
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: opponents.map((o) => o.userId) },
        token: creator.token,
      });
      for (const o of opponents) {
        await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
          body: { accept: true },
          token: o.token,
        });
      }
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
        token: creator.token,
      });
      const start = new Date(Date.now() - 8 * 60 * 60 * 1000);
      await prisma.race.update({
        where: { id: raceId },
        data: { startedAt: start, endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      });
      await prisma.raceParticipant.updateMany({
        where: { raceId },
        data: { joinedAt: start },
      });
      return raceId;
    }

    async function giveHeld(raceId, userId, type) {
      const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
      return prisma.racePowerup.create({
        data: {
          raceId,
          participantId: p.id,
          userId,
          type,
          rarity: "RARE",
          status: "HELD",
          earnedAtSteps: ++earnCounter,
        },
      });
    }

    // THE mixed-version case. A frozen binary decides "is this upgradeable?"
    // from its BUNDLED table, so it will keep offering levels 1-3 for the
    // Horseshoe long after the ladder is retired. Removing LUCKY_HORSESHOE from
    // `upgradeableTypes` would make every one of those a permanent 400; zeroing
    // the byType cost instead makes them free and inert. This asserts the old
    // client's request still SUCCEEDS.
    it("a frozen client posting upgradeLevel:3 succeeds and behaves as L0", async () => {
      const alice = await signUp();
      const bob = await signUp();
      const raceId = await activeRace(alice, [bob]);

      const before = await prisma.user.findUnique({ where: { id: alice.userId } });
      const shoe = await giveHeld(raceId, alice.userId, "LUCKY_HORSESHOE");
      const res = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${shoe.id}/use`,
        { body: { upgradeLevel: 3 }, token: alice.token, headers: P5 }
      );
      assert.equal(res.status, 200, "an old client's L3 horseshoe must not 400");

      // Behaves as L0: every level is now a 100% RARE guarantee, so the stamped
      // minimum is RARE regardless of the level claimed.
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "LUCKY_HORSESHOE", status: "ACTIVE" },
      });
      assert.ok(effect, "the horseshoe effect exists");
      assert.equal(effect.metadata.minRarity, "RARE");

      // And the retired ladder is free — no coins were taken for levels 1-3.
      const after = await prisma.user.findUnique({ where: { id: alice.userId } });
      assert.equal(after.coins, before.coins, "a retired upgrade must cost nothing");
    });

    it("an unupgraded horseshoe already guarantees RARE (the ramp is retired)", async () => {
      const alice = await signUp();
      const bob = await signUp();
      const raceId = await activeRace(alice, [bob]);

      const shoe = await giveHeld(raceId, alice.userId, "LUCKY_HORSESHOE");
      const res = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${shoe.id}/use`,
        { body: {}, token: alice.token, headers: P5 }
      );
      assert.equal(res.status, 200);

      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "LUCKY_HORSESHOE", status: "ACTIVE" },
      });
      assert.equal(effect.metadata.minRarity, "RARE", "L0 guarantees RARE now");
    });
  });

  // ── Item 10 — GET /admin/stats?sections= ──────────────────────────────────

  describe("item 10 — admin stats sections", () => {
    it("no sections param returns the legacy payload with no new keys", async () => {
      const admin = await signUpAdmin();
      const res = await request(server.baseUrl, "GET", "/admin/stats", {
        token: admin.token,
      });
      assert.equal(res.status, 200);
      const { stats } = await res.json();

      for (const key of [
        "users",
        "activity",
        "friends",
        "retention",
        "teamRaces",
        "referralFunnel",
        "races",
        "onboardingFunnel",
      ]) {
        assert.ok(key in stats, `legacy key ${key} must still be present`);
      }
      assert.equal("coinEconomy" in stats, false);
      assert.equal("adRevenue" in stats, false);
    });

    it("sections=economy adds coinEconomy in the locked shape", async () => {
      const admin = await signUpAdmin();
      const res = await request(
        server.baseUrl,
        "GET",
        "/admin/stats?sections=economy",
        { token: admin.token }
      );
      assert.equal(res.status, 200);
      const { stats } = await res.json();

      assert.ok(stats.coinEconomy, "coinEconomy present");
      assert.equal(stats.coinEconomy.windowDays, 30);
      assert.ok(Array.isArray(stats.coinEconomy.days));
      assert.ok(Array.isArray(stats.coinEconomy.purchasesBySku));
      assert.ok(Array.isArray(stats.coinEconomy.boxOpens));
      assert.equal("adRevenue" in stats, false);
    });

    it("sections=ads adds adRevenue in the locked shape", async () => {
      const admin = await signUpAdmin();
      const res = await request(
        server.baseUrl,
        "GET",
        "/admin/stats?sections=ads",
        { token: admin.token }
      );
      assert.equal(res.status, 200);
      const { stats } = await res.json();

      assert.ok(stats.adRevenue, "adRevenue present");
      assert.equal(stats.adRevenue.windowDays, 30);
      assert.ok(Array.isArray(stats.adRevenue.days));
      assert.ok(stats.adRevenue.capUtilization);
      assert.ok("avgWatchesPerUser" in stats.adRevenue.capUtilization);
      assert.equal(
        typeof stats.adRevenue.capUtilization.usersAtCap,
        "number"
      );
      assert.equal("coinEconomy" in stats, false);
    });

    it("both sections at once, and an unknown name is ignored not fatal", async () => {
      const admin = await signUpAdmin();
      const res = await request(
        server.baseUrl,
        "GET",
        "/admin/stats?sections=economy,ads,nonsense",
        { token: admin.token }
      );
      assert.equal(res.status, 200);
      const { stats } = await res.json();
      assert.ok(stats.coinEconomy);
      assert.ok(stats.adRevenue);
    });

    it("coinEconomy.days reports a real ledger row as minted", async () => {
      const admin = await signUpAdmin();
      const { userId } = await signUp();
      await prisma.coinTransaction.create({
        data: {
          userId,
          amount: 137,
          reason: "batch_0809_test_faucet",
          refId: `t-${Date.now()}`,
        },
      });

      const res = await request(
        server.baseUrl,
        "GET",
        "/admin/stats?sections=economy",
        { token: admin.token }
      );
      const { stats } = await res.json();
      const minted = stats.coinEconomy.days.reduce((a, d) => a + d.minted, 0);
      const sunk = stats.coinEconomy.days.reduce((a, d) => a + d.sunk, 0);
      assert.ok(minted >= 137, `expected the 137-coin mint, got ${minted}`);
      assert.equal(typeof sunk, "number");
    });

    it("coinEconomy.days reports a negative ledger row as sunk (positive magnitude)", async () => {
      const admin = await signUpAdmin();
      const { userId } = await signUp();
      await prisma.coinTransaction.create({
        data: {
          userId,
          amount: -55,
          reason: "batch_0809_test_sink",
          refId: `t-${Date.now()}`,
        },
      });

      const res = await request(
        server.baseUrl,
        "GET",
        "/admin/stats?sections=economy",
        { token: admin.token }
      );
      const { stats } = await res.json();
      const sunk = stats.coinEconomy.days.reduce((a, d) => a + d.sunk, 0);
      assert.ok(sunk >= 55, `sunk should be a positive magnitude, got ${sunk}`);
    });
  });
});
