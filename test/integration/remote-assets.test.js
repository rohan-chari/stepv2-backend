const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// CDN-served art (remote assets) — end-to-end coverage for:
//   * the static /assets route (immutable cache headers, 404, traversal)
//   * GET /assets/manifest (shape, release-channel filtering, character extras)
//   * catalog gating on the `remote_assets` X-Client-Features token, for both
//     GET /shop/catalog and GET /shop/powerups
//   * admin create/update of `assetVersion` on both shop tables, plus the new
//     renderMetadata.baselineOffset key surviving the PATCH merge
//
// Fixture PNGs live in public/assets/{accessories,characters,powerups}/ and are
// committed; their filenames embed the real sha256-12 of the bytes.

let server;
let nextAppleId = 0;

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

const ASSET_BASE = process.env.ASSET_BASE_URL || "https://steptracker-api.org";

const HAT_VERSION = "4ff6ab670a58";
const PANDA_VERSION = "619b0e8b0c87";
const BOOST_VERSION = "6a34118ba2e0";

async function createUser({ admin = false } = {}) {
  const appleId = `apple-remote-assets-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (admin) {
    await prisma.user.update({
      where: { id: body.user.id },
      data: { email: ADMIN_EMAIL },
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

function get(path, { token, headers } = {}) {
  return request(server.baseUrl, "GET", path, { token, headers });
}

// ── Static asset route ──────────────────────────────────────────────────────

describe("GET /assets/* (static, immutable)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  it("serves a committed PNG with immutable long-lived cache headers", async () => {
    const res = await get(`/assets/accessories/fixture_hat@${HAT_VERSION}.png`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^image\/png/);
    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=31536000, immutable"
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    // PNG magic number — proves we served the real file, not an error page.
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves character and powerup fixtures too", async () => {
    for (const p of [
      `/assets/characters/fixture_panda@${PANDA_VERSION}.png`,
      `/assets/powerups/fixture_boost@${BOOST_VERSION}.png`,
    ]) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /^image\/png/);
    }
  });

  it("404s a missing asset with a JSON body (fallthrough:false → errorMiddleware)", async () => {
    const res = await get("/assets/accessories/does_not_exist@deadbeef1234.png");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });

  it("rejects path traversal attempts and never leaks repo files", async () => {
    for (const p of [
      "/assets/%2e%2e/%2e%2e/package.json",
      "/assets/..%2f..%2fpackage.json",
      "/assets/accessories/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json",
    ]) {
      const res = await get(p);
      assert.ok(
        res.status >= 400 && res.status < 500,
        `${p} expected 4xx, got ${res.status}`
      );
      const text = await res.text();
      assert.ok(
        !text.includes("steps-tracker-backend"),
        `${p} leaked package.json`
      );
    }
  });
});

// ── Manifest ────────────────────────────────────────────────────────────────

describe("GET /assets/manifest", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});

    await prisma.shopItem.createMany({
      data: [
        {
          sku: "remote_hat",
          name: "Remote Hat",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "fixture_hat",
          assetVersion: HAT_VERSION,
          testOnly: false,
          sortOrder: 1,
        },
        {
          sku: "bundled_hat",
          name: "Bundled Hat",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "cowboy_hat",
          testOnly: false,
          sortOrder: 2,
        },
        {
          sku: "remote_hidden_hat",
          name: "Hidden Remote Hat",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "secret_hat",
          assetVersion: "aaaaaaaaaaaa",
          testOnly: true,
          sortOrder: 3,
        },
        {
          sku: "remote_panda",
          name: "Remote Panda",
          slot: "CHARACTER",
          priceCoins: 500,
          assetKey: "fixture_panda",
          assetVersion: PANDA_VERSION,
          renderMetadata: { animationFrames: 6, baselineOffset: -0.09 },
          testOnly: false,
          sortOrder: 4,
        },
        {
          sku: "remote_earn_only_cape",
          name: "Earned Cape",
          slot: "BACK",
          priceCoins: 0,
          assetKey: "earned_cape",
          assetVersion: "bbbbbbbbbbbb",
          earnOnly: true,
          testOnly: false,
          sortOrder: 5,
        },
      ],
    });

    await prisma.powerupShopItem.createMany({
      data: [
        {
          sku: "POWERUP_SHORTCUT",
          name: "Shortcut",
          priceCoins: 75,
          powerupType: "SHORTCUT",
          assetVersion: BOOST_VERSION,
          active: true,
          testOnly: false,
          sortOrder: 1,
        },
        {
          sku: "POWERUP_PROTEIN_SHAKE",
          name: "Protein Shake",
          priceCoins: 75,
          powerupType: "PROTEIN_SHAKE",
          active: true,
          testOnly: false,
          sortOrder: 2,
        },
        // Inactive (drop-pool only) rows must STILL appear in the manifest —
        // that's the whole reason the manifest exists beside the catalogs.
        {
          sku: "POWERUP_RALLY_FLAG",
          name: "Rally Flag",
          priceCoins: 75,
          powerupType: "RALLY_FLAG",
          assetVersion: "cccccccccccc",
          active: false,
          testOnly: false,
          sortOrder: 3,
        },
        {
          sku: "POWERUP_BOUNTY",
          name: "Bounty",
          priceCoins: 75,
          powerupType: "BOUNTY",
          assetVersion: "dddddddddddd",
          active: true,
          testOnly: true,
          sortOrder: 4,
        },
      ],
    });
  });

  it("returns only rows carrying an assetVersion, keyed by assetKey / powerup type", async () => {
    const res = await get("/assets/manifest");
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(Object.keys(body).sort(), [
      "accessories",
      "characters",
      "powerups",
    ]);

    assert.equal(
      body.accessories.fixture_hat.url,
      `${ASSET_BASE}/assets/accessories/fixture_hat@${HAT_VERSION}.png`
    );
    // earnOnly cosmetics are in the manifest even though the catalog omits them.
    assert.ok(body.accessories.earned_cape);
    // No assetVersion → not a remote asset.
    assert.equal(body.accessories.cowboy_hat, undefined);
    // CHARACTER rows live under `characters`, not `accessories`.
    assert.equal(body.accessories.fixture_panda, undefined);

    assert.equal(
      body.characters.fixture_panda.url,
      `${ASSET_BASE}/assets/characters/fixture_panda@${PANDA_VERSION}.png`
    );
    assert.equal(body.characters.fixture_panda.animationFrames, 6);
    assert.equal(body.characters.fixture_panda.baselineOffset, -0.09);

    assert.equal(
      body.powerups.SHORTCUT.url,
      `${ASSET_BASE}/assets/powerups/shortcut@${BOOST_VERSION}.png`
    );
    // Drop-pool-only (active:false) powerup art is still registered.
    assert.ok(body.powerups.RALLY_FLAG);
    assert.equal(body.powerups.PROTEIN_SHAKE, undefined);
  });

  it("sets Cache-Control: no-cache so the registry is never edge-cached", async () => {
    const res = await get("/assets/manifest");
    assert.match(res.headers.get("cache-control"), /no-cache/);
  });

  it("hides testOnly rows from the prod channel and reveals them to testflight", async () => {
    const prodBody = await (await get("/assets/manifest")).json();
    assert.equal(prodBody.accessories.secret_hat, undefined);
    assert.equal(prodBody.powerups.BOUNTY, undefined);

    const tfBody = await (
      await get("/assets/manifest", {
        headers: { "X-Release-Channel": "testflight" },
      })
    ).json();
    assert.ok(tfBody.accessories.secret_hat);
    assert.ok(tfBody.powerups.BOUNTY);
  });
});

// ── Catalog gating ──────────────────────────────────────────────────────────

describe("remote_assets client-feature gating", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
    await prisma.shopItem.createMany({
      data: [
        {
          sku: "remote_hat",
          name: "Remote Hat",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "fixture_hat",
          assetVersion: HAT_VERSION,
          testOnly: false,
          sortOrder: 1,
        },
        {
          sku: "bundled_hat",
          name: "Bundled Hat",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "cowboy_hat",
          testOnly: false,
          sortOrder: 2,
        },
      ],
    });
    await prisma.powerupShopItem.createMany({
      data: [
        {
          sku: "POWERUP_SHORTCUT",
          name: "Shortcut",
          priceCoins: 75,
          powerupType: "SHORTCUT",
          assetVersion: BOOST_VERSION,
          active: true,
          testOnly: false,
          sortOrder: 1,
        },
        {
          sku: "POWERUP_PROTEIN_SHAKE",
          name: "Protein Shake",
          priceCoins: 75,
          powerupType: "PROTEIN_SHAKE",
          active: true,
          testOnly: false,
          sortOrder: 2,
        },
      ],
    });
  });

  it("hides remote-only cosmetics from a client without the token", async () => {
    const user = await createUser();
    const body = await (
      await get("/shop/catalog", { token: user.token })
    ).json();
    const skus = body.items.map((i) => i.sku);
    assert.ok(skus.includes("bundled_hat"));
    assert.ok(!skus.includes("remote_hat"));
    // Bundled rows are byte-compatible: no assetUrl invented for them.
    const bundled = body.items.find((i) => i.sku === "bundled_hat");
    assert.equal(bundled.assetVersion ?? null, null);
    assert.equal(bundled.assetUrl ?? null, null);
  });

  it("serves remote cosmetics with assetVersion + assetUrl to a remote_assets client", async () => {
    const user = await createUser();
    const body = await (
      await get("/shop/catalog", {
        token: user.token,
        headers: { "X-Client-Features": "remote_assets" },
      })
    ).json();
    const skus = body.items.map((i) => i.sku);
    assert.ok(skus.includes("bundled_hat"));
    assert.ok(skus.includes("remote_hat"));

    const remote = body.items.find((i) => i.sku === "remote_hat");
    assert.equal(remote.assetVersion, HAT_VERSION);
    assert.equal(
      remote.assetUrl,
      `${ASSET_BASE}/assets/accessories/fixture_hat@${HAT_VERSION}.png`
    );
  });

  it("hides remote-only powerups from a client without the token", async () => {
    const user = await createUser();
    const body = await (
      await get("/shop/powerups", { token: user.token })
    ).json();
    const skus = body.items.map((i) => i.sku);
    assert.ok(skus.includes("POWERUP_PROTEIN_SHAKE"));
    assert.ok(!skus.includes("POWERUP_SHORTCUT"));
  });

  it("serves remote powerups with assetVersion + assetUrl to a remote_assets client", async () => {
    const user = await createUser();
    const body = await (
      await get("/shop/powerups", {
        token: user.token,
        headers: { "X-Client-Features": "remote_assets" },
      })
    ).json();
    const item = body.items.find((i) => i.sku === "POWERUP_SHORTCUT");
    assert.ok(item, "remote powerup missing for a remote_assets client");
    assert.equal(item.assetVersion, BOOST_VERSION);
    assert.equal(
      item.assetUrl,
      `${ASSET_BASE}/assets/powerups/shortcut@${BOOST_VERSION}.png`
    );

    const plain = body.items.find((i) => i.sku === "POWERUP_PROTEIN_SHAKE");
    assert.equal(plain.assetVersion ?? null, null);
    assert.equal(plain.assetUrl ?? null, null);
  });

  it("serves a CHARACTER remote row only to a characters + remote_assets client", async () => {
    await prisma.shopItem.create({
      data: {
        sku: "remote_panda",
        name: "Remote Panda",
        slot: "CHARACTER",
        priceCoins: 500,
        assetKey: "fixture_panda",
        assetVersion: PANDA_VERSION,
        renderMetadata: { animationFrames: 6, baselineOffset: -0.09 },
        testOnly: false,
        sortOrder: 3,
      },
    });
    const user = await createUser();

    const withoutRemote = await (
      await get("/shop/catalog", {
        token: user.token,
        headers: { "X-Client-Features": "characters" },
      })
    ).json();
    assert.ok(!withoutRemote.items.map((i) => i.sku).includes("remote_panda"));

    const withBoth = await (
      await get("/shop/catalog", {
        token: user.token,
        headers: { "X-Client-Features": "characters,remote_assets" },
      })
    ).json();
    const panda = withBoth.items.find((i) => i.sku === "remote_panda");
    assert.ok(panda);
    assert.equal(
      panda.assetUrl,
      `${ASSET_BASE}/assets/characters/fixture_panda@${PANDA_VERSION}.png`
    );
    assert.equal(panda.renderMetadata.baselineOffset, -0.09);
  });
});

// ── Admin ───────────────────────────────────────────────────────────────────

describe("admin assetVersion management", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.powerupShopItem.deleteMany({});
  });

  it("POST /admin/shop/items persists assetVersion and echoes it back", async () => {
    const admin = await createUser({ admin: true });
    const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
      token: admin.token,
      body: {
        sku: "remote_hat",
        name: "Remote Hat",
        slot: "HEAD",
        priceCoins: 75,
        assetKey: "fixture_hat",
        assetVersion: HAT_VERSION,
      },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.item.assetVersion, HAT_VERSION);
    assert.equal(
      body.item.assetUrl,
      `${ASSET_BASE}/assets/accessories/fixture_hat@${HAT_VERSION}.png`
    );

    const row = await prisma.shopItem.findUnique({ where: { sku: "remote_hat" } });
    assert.equal(row.assetVersion, HAT_VERSION);
  });

  it("POST /admin/shop/items rejects a malformed assetVersion", async () => {
    const admin = await createUser({ admin: true });
    for (const bad of ["zzzz", "abc", 12345, "a1b2c3d4!!!!"]) {
      const res = await request(server.baseUrl, "POST", "/admin/shop/items", {
        token: admin.token,
        body: {
          sku: `bad_${String(bad).replace(/\W/g, "")}`,
          name: "Bad",
          slot: "HEAD",
          priceCoins: 75,
          assetKey: "bad",
          assetVersion: bad,
        },
      });
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
    }
  });

  it("PATCH /admin/shop/items/:id sets and detaches assetVersion", async () => {
    const admin = await createUser({ admin: true });
    const item = await prisma.shopItem.create({
      data: {
        sku: "remote_hat",
        name: "Remote Hat",
        slot: "HEAD",
        priceCoins: 75,
        assetKey: "fixture_hat",
      },
    });

    const setRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: HAT_VERSION } }
    );
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).item.assetVersion, HAT_VERSION);

    const clearRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: null } }
    );
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).item.assetVersion, null);
    const row = await prisma.shopItem.findUnique({ where: { id: item.id } });
    assert.equal(row.assetVersion, null);

    const badRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: "nope" } }
    );
    assert.equal(badRes.status, 400);
  });

  it("PATCH preserves renderMetadata.baselineOffset when tuning other keys", async () => {
    const admin = await createUser({ admin: true });
    const item = await prisma.shopItem.create({
      data: {
        sku: "remote_panda",
        name: "Remote Panda",
        slot: "CHARACTER",
        priceCoins: 500,
        assetKey: "fixture_panda",
        renderMetadata: { animationFrames: 6, baselineOffset: -0.09 },
      },
    });

    const res = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { renderMetadata: { scale: 1.4 } } }
    );
    assert.equal(res.status, 200);
    const row = await prisma.shopItem.findUnique({ where: { id: item.id } });
    assert.equal(row.renderMetadata.scale, 1.4);
    assert.equal(row.renderMetadata.animationFrames, 6);
    assert.equal(
      row.renderMetadata.baselineOffset,
      -0.09,
      "baselineOffset must survive an unrelated tuner save"
    );

    // ...and it is directly settable.
    const setRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { renderMetadata: { baselineOffset: -0.2 } } }
    );
    assert.equal(setRes.status, 200);
    const after = await prisma.shopItem.findUnique({ where: { id: item.id } });
    assert.equal(after.renderMetadata.baselineOffset, -0.2);

    const badRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/shop/items/${item.id}`,
      { token: admin.token, body: { renderMetadata: { baselineOffset: "low" } } }
    );
    assert.equal(badRes.status, 400);
  });

  it("PATCH /admin/powerup-shop/items/:id sets, detaches and validates assetVersion", async () => {
    const admin = await createUser({ admin: true });
    const item = await prisma.powerupShopItem.create({
      data: {
        sku: "POWERUP_SHORTCUT",
        name: "Shortcut",
        priceCoins: 75,
        powerupType: "SHORTCUT",
        active: true,
        testOnly: false,
        sortOrder: 1,
      },
    });

    const setRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: BOOST_VERSION } }
    );
    assert.equal(setRes.status, 200);
    assert.equal((await setRes.json()).item.assetVersion, BOOST_VERSION);

    const listBody = await (
      await get("/admin/powerup-shop/items", { token: admin.token })
    ).json();
    assert.equal(
      listBody.items.find((i) => i.sku === "POWERUP_SHORTCUT").assetVersion,
      BOOST_VERSION
    );

    const clearRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: null } }
    );
    assert.equal(clearRes.status, 200);
    assert.equal((await clearRes.json()).item.assetVersion, null);

    const badRes = await request(
      server.baseUrl,
      "PATCH",
      `/admin/powerup-shop/items/${item.id}`,
      { token: admin.token, body: { assetVersion: "xyz" } }
    );
    assert.equal(badRes.status, 400);
  });

  it("carries assetVersion through the peer-mirror field set", async () => {
    // The mirror is a no-op without PEER_DATABASE_URL, so assert the field list
    // itself — the drift that has bitten this codebase is a column added to the
    // schema but forgotten in the mirror/sync field lists.
    const {
      MIRRORED_SHOP_ITEM_FIELDS,
    } = require("../../src/modules/cosmetics/mirrorShopItem");
    assert.ok(
      MIRRORED_SHOP_ITEM_FIELDS.includes("assetVersion"),
      "mirrorShopItem must mirror assetVersion"
    );
    const {
      COMPARED_FIELDS,
    } = require("../../scripts/cosmetics-sync-peer");
    assert.ok(
      COMPARED_FIELDS.includes("assetVersion"),
      "cosmetics:sync-peer must compare assetVersion"
    );
    const {
      CLONED_FIELDS,
    } = require("../../scripts/cosmetics-clone");
    assert.ok(
      CLONED_FIELDS.includes("assetVersion"),
      "cosmetics:clone must clone assetVersion"
    );
  });
});
