const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { spawnSync } = require("node:child_process");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
let server, userId, token;
const slots = (s = {}) => ({
  HEAD: null,
  FACE: null,
  NECK: null,
  BACK: null,
  FEET: null,
  ...s,
});
async function call(method, path, body) {
  const r = await request(server.baseUrl, method, path, {
    token,
    headers: { "X-Client-Features": "characters,remote_assets" },
    body,
  });
  return { status: r.status, body: await r.json() };
}
async function item(slot, extra = {}) {
  const i = await prisma.shopItem.create({
    data: {
      sku: crypto.randomUUID(),
      name: slot,
      slot,
      assetKey: slot,
      priceCoins: 0,
      ...extra,
    },
  });
  await prisma.userShopItem.create({ data: { userId, shopItemId: i.id } });
  return i;
}
async function equip(slot, itemId) {
  return call("PUT", `/shop/equipment/${slot}`, { itemId });
}
async function save(revision, s) {
  return call("PUT", "/shop/characters/default/outfit", {
    expectedOutfitRevision: revision,
    slots: slots(s),
  });
}
async function state() {
  return (await call("GET", "/shop/characters/default/wardrobe")).body;
}
async function fit(i) {
  await prisma.shopItemCharacterFit.create({
    data: { accessoryShopItemId: i.id, characterKey: "default" },
  });
}
describe("wardrobe snapshot, migration and public appearance safety", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const r = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "apple-wardrobe-safety" },
    });
    const b = await r.json();
    userId = b.user.id;
    token = b.sessionToken;
  });
  it("accepts deployed text IDs and prevents reintroducing a removed grandfathered item", async () => {
    const h = await item("HEAD", { id: "shop-baseball-cap" });
    await equip("HEAD", h.id);
    let w = await state();
    assert.equal(w.accessories[0].fit, "legacy-preserved");
    assert.equal((await save(w.outfit.revision, {})).status, 200);
    w = await state();
    assert.equal(w.accessories[0].fit, "preservation-only");
    assert.equal(w.accessories[0].canSelect, false);
    assert.equal(
      (await save(w.outfit.revision, { HEAD: h.id })).body.code,
      "CHARACTER_FIT_CONFLICT",
    );
  });
  it("detects pre-A projection drift and repairs only saved active state through the bounded CLI", async () => {
    const h = await item("HEAD");
    await equip("HEAD", h.id);
    const before = await state();
    await prisma.userEquippedAccessory.deleteMany({
      where: { userId, slot: "HEAD" },
    });
    const opts = {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: "utf8",
    };
    let p = spawnSync(
      process.execPath,
      ["scripts/repair-character-wardrobes.js"],
      opts,
    );
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).mismatches, 1);
    p = spawnSync(
      process.execPath,
      ["scripts/repair-character-wardrobes.js", "--apply"],
      opts,
    );
    assert.equal(p.status, 0, p.stderr);
    assert.equal(JSON.parse(p.stdout).repaired, 1);
    const after = await state();
    assert.equal(after.outfit.revision, before.outfit.revision + 1);
    assert.equal(after.appearanceRevision, before.appearanceRevision + 1);
    assert.deepEqual(after.outfit.slots, slots());
    p = spawnSync(
      process.execPath,
      ["scripts/repair-character-wardrobes.js", "--apply"],
      opts,
    );
    assert.equal(JSON.parse(p.stdout).repaired, 0);
  });
  it("GET remains one coherent read-only snapshot when a legacy write commits between its page and projection reads", async () => {
    const h = await item("HEAD");
    let release;
    const gate = new Promise((r) => (release = r));
    let reached;
    const pageRead = new Promise((r) => (reached = r));
    const original = prisma.$transaction.bind(prisma);
    let intercept = true;
    const shared = server;
    const db = new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (callback, options) =>
          original(async (tx) => {
            if (!intercept || options?.isolationLevel !== "RepeatableRead")
              return callback(tx);
            intercept = false;
            const raw = tx.$queryRaw.bind(tx);
            const proxy = new Proxy(tx, {
              get(target, key) {
                if (key === "$queryRaw")
                  return async (...args) => {
                    const result = await raw(...args);
                    reached();
                    await gate;
                    return result;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return callback(proxy);
          }, options);
      },
    });
    server = await startServer({ wardrobePrisma: db });
    try {
      const reading = call("GET", "/shop/characters");
      await pageRead;
      assert.equal((await equip("HEAD", h.id)).status, 200);
      release();
      const old = await reading;
      assert.equal(old.body.appearanceRevision, 0);
      assert.equal(old.body.characters[0].outfit.slots.HEAD, null);
      const fresh = await state();
      assert.equal(fresh.appearanceRevision, 1);
      assert.equal(fresh.outfit.slots.HEAD, h.id);
    } finally {
      release();
      await server.close();
      server = shared;
    }
  });
  it("active save updates real Home appearance while an inactive save leaves it identical", async () => {
    const shared = server;
    server = await startServer({
      appSettings: {
        async getFlag(k) {
          return k === "apiHomeShellV1Enabled";
        },
      },
    });
    try {
      const h = await item("HEAD"),
        c = await item("CHARACTER");
      await fit(h);
      await prisma.shopItemCharacterFit.create({
        data: {
          accessoryShopItemId: h.id,
          characterKey: c.id,
          characterShopItemId: c.id,
        },
      });
      const before = await call("GET", "/home/race-card?view=shell-v1");
      assert.equal(before.status, 200);
      assert.ok(before.body.presentation);
      const r = await call("PUT", `/shop/characters/${c.id}/outfit`, {
        expectedOutfitRevision: 0,
        slots: slots({ HEAD: h.id }),
      });
      assert.equal(r.status, 200);
      const inactive = await call("GET", "/home/race-card?view=shell-v1");
      assert.deepEqual(
        inactive.body.presentation.equipped,
        before.body.presentation.equipped,
      );
      assert.equal((await save(0, { HEAD: h.id })).status, 200);
      const active = await call("GET", "/home/race-card?view=shell-v1");
      assert.equal(active.body.presentation.equipped.HEAD.id, h.id);
    } finally {
      await server.close();
      server = shared;
    }
  });
  it("stale save racing legacy null equip never silently loses a committed update", async () => {
    const h = await item("HEAD"),
      f = await item("FACE");
    await fit(h);
    await fit(f);
    await equip("HEAD", h.id);
    const results = await Promise.all([
      equip("HEAD", null),
      save(1, { HEAD: h.id, FACE: f.id }),
    ]);
    assert.equal(results[0].status, 200);
    assert.ok([200, 409].includes(results[1].status));
    const w = await state();
    assert.equal(w.outfit.slots.HEAD, null);
    assert.equal(w.outfit.revision, w.appearanceRevision);
  });
  it("rejects hidden active characters without leaking identity and preserves saved inactive unavailable characters", async () => {
    const c = await item("CHARACTER");
    await equip("CHARACTER", c.id);
    await prisma.shopItem.update({
      where: { id: c.id },
      data: { testOnly: true },
    });
    let r = await call("GET", "/shop/characters");
    assert.equal(r.body.activeCharacterKey, null);
    assert.equal(r.body.activeCharacterVisible, false);
    assert.equal(JSON.stringify(r.body).includes(c.id), false);
    assert.equal(
      (await call("GET", `/shop/characters/${c.id}/wardrobe`)).status,
      404,
    );
    await prisma.shopItem.update({
      where: { id: c.id },
      data: { testOnly: false, active: false },
    });
    r = await call("GET", `/shop/characters/${c.id}/wardrobe`);
    assert.equal(r.body.canActivate, false);
    assert.equal(r.body.outfit.editable, false);
  });
  it("deleting an account cascades wardrobes without deleting fits/catalog/other owners", async () => {
    const h = await item("HEAD");
    await fit(h);
    await equip("HEAD", h.id);
    await prisma.user.delete({ where: { id: userId } });
    assert.equal(await prisma.characterWardrobe.count(), 0);
    assert.equal(await prisma.characterWardrobeItem.count(), 0);
    assert.equal(await prisma.shopItemCharacterFit.count(), 1);
    assert.equal(await prisma.shopItem.count(), 1);
  });
  it("compatibility repair can remove a character and reuse an already saved default wardrobe", async () => {
    const h = await item("HEAD", {
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const c = await item("CHARACTER");
    await equip("HEAD", h.id);
    await equip("CHARACTER", c.id);
    await prisma.shopItem.update({
      where: { id: c.id },
      data: { compatibility: { tags: ["eyewear"] } },
    });
    await prisma.userEquippedAccessory.update({
      where: { userId_slot: { userId, slot: "HEAD" } },
      data: { updatedAt: new Date("2030-01-01") },
    });
    const p = spawnSync(
      process.execPath,
      [
        "-e",
        "require('./scripts/accessory-compatibility-cleanup').main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})",
        "--",
        "--apply",
      ],
      {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        encoding: "utf8",
      },
    );
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /removed 1/);
    const w = await state();
    assert.equal(w.activeCharacterKey, "default");
    assert.equal(w.outfit.slots.HEAD, h.id);
    const old = (await call("GET", `/shop/characters/${c.id}/wardrobe`)).body;
    assert.equal(old.outfit.slots.HEAD, h.id);
    const invalid = await call("PUT", "/shop/active-character", {
      characterKey: c.id,
      expectedAppearanceRevision: w.appearanceRevision,
      expectedOutfitRevision: old.outfit.revision,
    });
    assert.equal(invalid.body.code, "ACCESSORY_CONFLICT");
  });
});
