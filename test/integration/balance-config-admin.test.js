const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

let server;
let nextAppleId = 0;

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser() {
  const appleId = `apple-balance-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function createAdmin() {
  const admin = await createUser();
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

function put(token, body) {
  return request(server.baseUrl, "PUT", "/admin/balance-config", { token, body });
}

// Save a baseline config so tests that need an existing version have one.
async function seedV1(token) {
  const res = await put(token, {
    expectedVersion: null,
    config: defaultConfig(),
    note: "baseline",
  });
  assert.equal(res.status, 201, "baseline save should succeed");
  return (await res.json()).version;
}

describe("admin balance config (§5.2)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
  });

  // Test #6
  it("non-admin gets 403 on every balance-config route", async () => {
    const user = await createUser();
    const routes = [
      ["GET", "/admin/balance-config", undefined],
      ["GET", "/admin/balance-config/versions", undefined],
      ["PUT", "/admin/balance-config", { config: defaultConfig() }],
      ["POST", "/admin/balance-config/rollback", { version: 1 }],
    ];
    for (const [method, path, body] of routes) {
      const res = await request(server.baseUrl, method, path, {
        token: user.token,
        body,
      });
      assert.equal(res.status, 403, `${method} ${path} should be 403`);
    }
  });

  // Test #1
  it("PUT with a valid config becomes active and GET returns it", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.typeWeights.RED_CARD = 0.25;

    const res = await put(admin.token, {
      expectedVersion: null,
      config,
      note: "nerf red card further",
    });
    assert.equal(res.status, 201);
    const saved = await res.json();
    assert.equal(saved.version, 1);
    assert.equal(saved.config.typeWeights.RED_CARD, 0.25);
    assert.deepEqual(saved.warnings, []);

    const getRes = await request(server.baseUrl, "GET", "/admin/balance-config", {
      token: admin.token,
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.version, 1);
    assert.equal(body.config.typeWeights.RED_CARD, 0.25);
    assert.equal(body.note, "nerf red card further");
    assert.equal(body.createdBy, admin.userId);
    assert.equal(body.boundOverride, false);
    // Bounds are served so the UI can warn before submitting (D11/D12).
    assert.ok(body.bounds && typeof body.bounds === "object");
    assert.ok(body.bounds["dailyBox.coinRanges.*"]);
  });

  // Test #2 — one case per hard-validation rule (§5.2).
  describe("hard validation → 400", () => {
    const cases = {
      "positionOdds row not summing to 1": (c) => {
        c.positionOdds.first = [0.5, 0.5, 0.5];
      },
      "positionOdds row with a negative entry": (c) => {
        c.positionOdds.last = [-0.1, 0.5, 0.6];
      },
      "dailyBox.odds row not summing to 1": (c) => {
        c.dailyBox.odds.first = [0.1, 0.1, 0.1];
      },
      "dropPool entry that is not a PowerupType": (c) => {
        c.dropPool.COMMON.push("NOT_A_POWERUP");
      },
      "dropPool entry that is store-only": (c) => {
        c.dropPool.RARE.push("LEECH");
      },
      "dropPool entry with no rarity": (c) => {
        delete c.rarityByType.SHORTCUT;
      },
      "rarityByType missing an enum value": (c) => {
        delete c.rarityByType.QUICK_RINSE;
      },
      "upgrade ladder with the wrong length": (c) => {
        c.upgradeCosts.byRarity.COMMON = [0, 5, 15];
      },
      "upgrade ladder whose base is not free": (c) => {
        c.upgradeCosts.byRarity.COMMON = [1, 5, 15, 45];
      },
      "upgrade ladder that decreases": (c) => {
        c.upgradeCosts.byRarity.RARE = [0, 45, 15, 135];
      },
      "upgradeableTypes entry that is not a PowerupType": (c) => {
        c.upgradeableTypes.push("NOPE");
      },
      "luckyHorseshoe ladder not ending at 1.0": (c) => {
        c.luckyHorseshoe.rareChanceByLevel = [0, 0.2, 0.45, 0.9];
      },
      "luckyHorseshoe ladder that decreases": (c) => {
        c.luckyHorseshoe.rareChanceByLevel = [0, 0.5, 0.2, 1.0];
      },
      "coinRange with min greater than max": (c) => {
        c.dailyBox.coinRanges.COMMON = [80, 40];
      },
      "rareCoinsShare outside [0,1]": (c) => {
        c.dailyBox.rareCoinsShare = 1.4;
      },
      "unknown accessoryWeightMode": (c) => {
        c.dailyBox.accessoryWeightMode = "prestige";
      },
      "unrecognised schemaVersion": (c) => {
        c.schemaVersion = 99;
      },
    };

    for (const [label, mutate] of Object.entries(cases)) {
      it(`rejects ${label}`, async () => {
        const admin = await createAdmin();
        const config = defaultConfig();
        mutate(config);
        const res = await put(admin.token, { expectedVersion: null, config });
        assert.equal(res.status, 400, `${label} should be a hard rejection`);
        const body = await res.json();
        assert.ok(
          Array.isArray(body.errors) && body.errors.length > 0,
          "400 body should name the failing field(s)"
        );
        assert.ok(body.errors.every((e) => typeof e.path === "string"));
      });
    }

    it("a hard failure is never overridable by acknowledgeBoundWarnings", async () => {
      const admin = await createAdmin();
      const config = defaultConfig();
      config.positionOdds.first = [0.9, 0.9, 0.9];
      const res = await put(admin.token, {
        expectedVersion: null,
        config,
        acknowledgeBoundWarnings: true,
      });
      assert.equal(res.status, 400);
    });
  });

  // Test #3
  it("a stale expectedVersion is 409 with the current version and config", async () => {
    const admin = await createAdmin();
    await seedV1(admin.token);

    const second = defaultConfig();
    second.dailyBox.streakCap = 21;
    const okRes = await put(admin.token, { expectedVersion: 1, config: second });
    assert.equal(okRes.status, 201);
    assert.equal((await okRes.json()).version, 2);

    // Now save as if we had only ever seen v1.
    const stale = defaultConfig();
    stale.dailyBox.streakCap = 14;
    const res = await put(admin.token, { expectedVersion: 1, config: stale });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "stale_version");
    assert.equal(body.currentVersion, 2);
    // The current config comes back so the UI can re-diff without a 2nd request.
    assert.equal(body.config.dailyBox.streakCap, 21);

    // And the losing write must NOT have landed.
    const count = await prisma.balanceConfig.count();
    assert.equal(count, 2);
  });

  // Test #4 — driven from one test with an explicit barrier rather than relying
  // on wall-clock overlap, so it cannot flake in CI.
  it("two concurrent writers at the same expectedVersion → exactly one 201, one 409", async () => {
    const admin = await createAdmin();
    await seedV1(admin.token);

    const a = defaultConfig();
    a.dailyBox.streakCap = 25;
    const b = defaultConfig();
    b.dailyBox.streakCap = 26;

    const [resA, resB] = await Promise.all([
      put(admin.token, { expectedVersion: 1, config: a, note: "A" }),
      put(admin.token, { expectedVersion: 1, config: b, note: "B" }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      `expected exactly one winner, got ${statuses.join("/")}`
    );

    // Version sequence has no gap and no duplicate.
    const rows = await prisma.balanceConfig.findMany({ orderBy: { version: "asc" } });
    assert.deepEqual(
      rows.map((r) => r.version),
      [1, 2]
    );
    // Exactly one row is active.
    assert.equal(rows.filter((r) => r.active).length, 1);
    assert.equal(rows.find((r) => r.active).version, 2);
  });

  // Test #5
  it("a soft-bound violation is 422, and re-submitting with the ack succeeds and records boundOverride", async () => {
    const admin = await createAdmin();
    await seedV1(admin.token);

    const config = defaultConfig();
    config.dailyBox.coinRanges.COMMON = [0, 0]; // structurally legal, economically catastrophic

    const res = await put(admin.token, { expectedVersion: 1, config });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, "bound_warnings");
    assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0);
    const warning = body.warnings.find((w) => w.path.startsWith("dailyBox.coinRanges"));
    assert.ok(warning, "should warn about the coin range");
    assert.deepEqual(warning.bound, [5, 500]);
    assert.ok(typeof warning.message === "string" && warning.message.length > 0);

    // Nothing was written.
    assert.equal(await prisma.balanceConfig.count(), 1);

    const ackRes = await put(admin.token, {
      expectedVersion: 1,
      config,
      acknowledgeBoundWarnings: true,
    });
    assert.equal(ackRes.status, 201);
    assert.equal((await ackRes.json()).version, 2);

    const saved = await prisma.balanceConfig.findUnique({ where: { version: 2 } });
    assert.equal(
      saved.boundOverride,
      true,
      "the override must be recorded in history"
    );

    const versionsRes = await request(
      server.baseUrl,
      "GET",
      "/admin/balance-config/versions",
      { token: admin.token }
    );
    const { versions } = await versionsRes.json();
    assert.equal(versions.find((v) => v.version === 2).boundOverride, true);
  });

  it("GET /versions lists history newest-first with the active flag", async () => {
    const admin = await createAdmin();
    await seedV1(admin.token);
    const second = defaultConfig();
    second.dailyBox.streakCap = 20;
    await put(admin.token, { expectedVersion: 1, config: second, note: "v2" });

    const res = await request(
      server.baseUrl,
      "GET",
      "/admin/balance-config/versions?limit=50",
      { token: admin.token }
    );
    assert.equal(res.status, 200);
    const { versions } = await res.json();
    assert.deepEqual(
      versions.map((v) => v.version),
      [2, 1]
    );
    assert.equal(versions[0].active, true);
    assert.equal(versions[1].active, false);
    assert.equal(versions[0].note, "v2");
  });

  // Test #7
  describe("rollback", () => {
    it("creates a NEW version holding the old config and never rewrites history", async () => {
      const admin = await createAdmin();
      await seedV1(admin.token); // v1: streakCap 30

      const second = defaultConfig();
      second.dailyBox.streakCap = 15;
      await put(admin.token, { expectedVersion: 1, config: second, note: "v2" });

      const res = await request(
        server.baseUrl,
        "POST",
        "/admin/balance-config/rollback",
        { token: admin.token, body: { version: 1, expectedVersion: 2 } }
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).version, 3);

      // v3 holds v1's values...
      const active = await prisma.balanceConfig.findFirst({ where: { active: true } });
      assert.equal(active.version, 3);
      assert.equal(active.config.dailyBox.streakCap, 30);

      // ...and v1/v2 are untouched.
      const v1 = await prisma.balanceConfig.findUnique({ where: { version: 1 } });
      const v2 = await prisma.balanceConfig.findUnique({ where: { version: 2 } });
      assert.equal(v1.config.dailyBox.streakCap, 30);
      assert.equal(v2.config.dailyBox.streakCap, 15);
      assert.equal(await prisma.balanceConfig.count(), 3);
    });

    it("a stale expectedVersion on rollback is 409", async () => {
      const admin = await createAdmin();
      await seedV1(admin.token);
      const second = defaultConfig();
      second.dailyBox.streakCap = 15;
      await put(admin.token, { expectedVersion: 1, config: second });

      const res = await request(
        server.baseUrl,
        "POST",
        "/admin/balance-config/rollback",
        { token: admin.token, body: { version: 1, expectedVersion: 1 } }
      );
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error, "stale_version");
      assert.equal(body.currentVersion, 2);
    });

    it("rolling back to a version that does not exist is 404", async () => {
      const admin = await createAdmin();
      await seedV1(admin.token);
      const res = await request(
        server.baseUrl,
        "POST",
        "/admin/balance-config/rollback",
        { token: admin.token, body: { version: 99, expectedVersion: 1 } }
      );
      assert.equal(res.status, 404);
    });
  });
});
