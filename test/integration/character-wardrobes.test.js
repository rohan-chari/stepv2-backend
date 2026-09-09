const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const slots = (values = {}) => ({
  HEAD: null,
  FACE: null,
  NECK: null,
  BACK: null,
  FEET: null,
  ...values,
});
let server, token, userId;
async function call(method, path, body, headers = {}) {
  const r = await request(server.baseUrl, method, path, {
    token,
    body,
    headers: { "X-Client-Features": "characters,remote_assets", ...headers },
  });
  return { status: r.status, body: await r.json() };
}
async function item(slot, owned = true, extras = {}) {
  const i = await prisma.shopItem.create({
    data: {
      sku: crypto.randomUUID(),
      name: slot,
      slot,
      assetKey: slot,
      priceCoins: 10,
      ...extras,
    },
  });
  if (owned)
    await prisma.userShopItem.create({ data: { userId, shopItemId: i.id } });
  return i;
}
async function fit(i, key = "default") {
  await prisma.shopItemCharacterFit.create({
    data: {
      accessoryShopItemId: i.id,
      characterKey: key,
      characterShopItemId: key === "default" ? null : key,
    },
  });
}
async function wardrobe(key = "default") {
  return call("GET", `/shop/characters/${key}/wardrobe`);
}
async function save(key, revision, values) {
  return call("PUT", `/shop/characters/${key}/outfit`, {
    expectedOutfitRevision: revision,
    slots: slots(values),
  });
}
async function activate(key, appearance, revision) {
  return call("PUT", "/shop/active-character", {
    characterKey: key,
    expectedAppearanceRevision: appearance,
    expectedOutfitRevision: revision,
  });
}
async function equip(slot, id) {
  return call("PUT", `/shop/equipment/${slot}`, { itemId: id });
}
describe("character wardrobe public contract", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    const r = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: "apple-wardrobe" },
    });
    const b = await r.json();
    token = b.sessionToken;
    userId = b.user.id;
  });
  it("returns exact default contract with no GET writes", async () => {
    const r = await call("GET", "/shop/characters");
    assert.equal(r.status, 200);
    assert.equal(r.body.contract, "character-wardrobes-v1");
    assert.equal(r.body.appearanceRevision, 0);
    assert.equal(r.body.activeCharacterKey, "default");
    assert.deepEqual(r.body.characters, [
      {
        characterKey: "default",
        name: "Capybara",
        item: null,
        owned: true,
        active: true,
        canPurchase: false,
        canActivate: true,
        canEdit: true,
        availability: "available",
        outfit: {
          revision: 0,
          editable: true,
          hasHiddenItems: false,
          slots: slots(),
          items: [],
          unavailableItemIds: [],
        },
      },
    ]);
    assert.equal(await prisma.characterWardrobe.count(), 0);
    assert.equal((await wardrobe()).status, 200);
    assert.equal(await prisma.characterWardrobe.count(), 0);
  });
  it("rejects malformed syntax and unowned resources", async () => {
    for (const q of ["limit=0", "limit=49", "limit=1.5", "cursor=garbage"])
      assert.equal((await call("GET", `/shop/characters?${q}`)).status, 400);
    assert.equal((await save("default", -1, {})).status, 400);
    const c = await item("CHARACTER", false);
    assert.equal((await wardrobe(c.id)).body.code, "CHARACTER_NOT_OWNED");
    assert.equal((await wardrobe("bad!")).status, 400);
    const h = await item("HEAD", false);
    await fit(h);
    assert.equal(
      (await save("default", 0, { HEAD: h.id })).body.code,
      "ITEM_NOT_OWNED",
    );
  });
  it("saves inactive independently, activates only saved outfit, and no-ops without economic mutations", async () => {
    const c = await item("CHARACTER");
    const h = await item("HEAD");
    await fit(h, c.id);
    const before = await prisma.user.findUnique({ where: { id: userId } });
    let r = await save(c.id, 0, { HEAD: h.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outfit.revision, 1);
    assert.equal(r.body.appearanceChanged, false);
    assert.deepEqual(r.body.equipped, {});
    r = await activate(c.id, 0, 1);
    assert.equal(r.status, 200);
    assert.equal(r.body.equipped.HEAD.id, h.id);
    assert.equal(r.body.equipped.CHARACTER.id, c.id);
    assert.equal(r.body.appearanceRevision, 1);
    r = await activate(c.id, 1, 1);
    assert.equal(r.body.appearanceChanged, false);
    assert.equal(r.body.appearanceRevision, 1);
    assert.equal(
      (await prisma.user.findUnique({ where: { id: userId } })).coins,
      before.coins,
    );
    assert.equal(await prisma.userShopItem.count(), 2);
    assert.equal(await prisma.shopPurchaseRequest.count(), 0);
    assert.equal((await wardrobe(c.id)).body.outfit.slots.HEAD, h.id);
  });
  it("legacy switches carry accessories, null CHARACTER checkpoints default, and unrelated row timestamps survive", async () => {
    const c = await item("CHARACTER");
    const h = await item("HEAD");
    const f = await item("FACE");
    await equip("HEAD", h.id);
    const original = await prisma.userEquippedAccessory.findFirst({
      where: { userId, slot: "HEAD" },
    });
    await equip("CHARACTER", c.id);
    assert.equal((await wardrobe(c.id)).body.outfit.slots.HEAD, h.id);
    await equip("FACE", f.id);
    const after = await prisma.userEquippedAccessory.findUnique({
      where: { id: original.id },
    });
    assert.deepEqual(after, original);
    await equip("CHARACTER", null);
    assert.equal((await wardrobe()).body.outfit.slots.FACE, f.id);
    const old = await call("GET", "/shop/catalog", undefined, {
      "X-Client-Features": "",
    });
    assert.equal(old.body.equipped.CHARACTER, undefined);
    const r = await save("default", (await wardrobe()).body.outfit.revision, {
      HEAD: h.id,
      FACE: f.id,
    });
    assert.equal(r.status, 200);
  });
  it("preserves hidden and earned ownership, and forbids hidden replacement", async () => {
    const h = await item("HEAD", true, { testOnly: true });
    await call(
      "PUT",
      "/shop/equipment/HEAD",
      { itemId: h.id },
      { "X-Release-Channel": "testflight" },
    );
    const r = await wardrobe();
    assert.equal(r.body.outfit.hasHiddenItems, true);
    assert.equal(r.body.outfit.slots.HEAD, null);
    assert.equal(JSON.stringify(r.body).includes(h.id), false);
    assert.equal(
      (await save("default", r.body.outfit.revision, {})).body.code,
      "WARDROBE_NOT_EDITABLE",
    );
    const e = await item("FACE", true, { earnOnly: true });
    await fit(e);
    const w = await wardrobe();
    const row = w.body.accessories.find((x) => x.item.id === e.id);
    assert.equal(row.owned, true);
    assert.equal(row.canPurchase, false);
    assert.equal(row.canSelect, true);
  });
  it("rejects stale revisions, wrong slots, unapproved fit and conflicting complete outfits atomically", async () => {
    const h = await item("HEAD", true, {
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    });
    const f = await item("FACE", true, {
      compatibility: { tags: ["eyewear"] },
    });
    assert.equal(
      (await save("default", 0, { HEAD: h.id })).body.code,
      "CHARACTER_FIT_CONFLICT",
    );
    await fit(h);
    await fit(f);
    assert.equal(
      (await save("default", 0, { FACE: h.id })).body.code,
      "ITEM_UNAVAILABLE",
    );
    assert.equal(
      (await save("default", 0, { HEAD: h.id, FACE: f.id })).body.code,
      "ACCESSORY_CONFLICT",
    );
    assert.equal((await save("default", 0, { HEAD: h.id })).status, 200);
    const r = await save("default", 0, {});
    assert.equal(r.body.code, "OUTFIT_CHANGED");
    assert.equal(r.body.current.outfitRevision, 1);
    assert.equal(
      (await activate("default", 0, 1)).body.code,
      "APPEARANCE_CHANGED",
    );
  });
  it("keyset pages deduplicate, bind channel and preserve selected items outside item page", async () => {
    for (let i = 0; i < 3; i++)
      await item("CHARACTER", i !== 1, { sortOrder: i });
    let r = await call("GET", "/shop/characters?limit=1");
    const keys = [];
    while (true) {
      assert.equal(r.status, 200);
      keys.push(...r.body.characters.map((x) => x.characterKey));
      if (!r.body.nextCursor) break;
      r = await call(
        "GET",
        `/shop/characters?limit=1&cursor=${r.body.nextCursor}`,
      );
    }
    assert.equal(keys.length, 4);
    assert.equal(new Set(keys).size, 4);
    const h = await item("HEAD", true, { sortOrder: 100 });
    await equip("HEAD", h.id);
    await item("FACE", true, { sortOrder: 0 });
    r = await call("GET", "/shop/characters/default/wardrobe?limit=1");
    assert.equal(r.body.outfit.items[0].id, h.id);
  });
  it("serializes concurrent saves and activations under a shared user lock", async () => {
    const h = await item("HEAD");
    const f = await item("FACE");
    await fit(h);
    await fit(f);
    let results = await Promise.all([
      save("default", 0, { HEAD: h.id }),
      save("default", 0, { FACE: f.id }),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    const a = await item("CHARACTER");
    const b = await item("CHARACTER");
    results = await Promise.all([activate(a.id, 1, 0), activate(b.id, 1, 0)]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  });
  it("wardrobe changes preserve daily reward pool and every economic ledger", async () => {
    const c = await item("CHARACTER");
    const h = await item("HEAD");
    await fit(h, c.id);
    const reward = await item("FACE", false);
    const statusPath = `/daily-reward/status?localDate=${new Date().toISOString().slice(0, 10)}`;
    const before = (await call("GET", statusPath)).body;
    const economic = async () => {
      const [row] =
        await prisma.$queryRaw`SELECT (SELECT coins FROM users WHERE id=${userId}) AS coins,(SELECT count(*) FROM coin_transactions WHERE user_id=${userId})::int AS ledger,(SELECT count(*) FROM user_shop_items WHERE user_id=${userId})::int AS owned,(SELECT count(*) FROM ad_reward_grants WHERE user_id=${userId})::int AS ads,(SELECT count(*) FROM daily_reward_claims WHERE user_id=${userId})::int AS claims,(SELECT count(*) FROM shop_purchase_requests WHERE user_id=${userId})::int AS purchases`;
      return row;
    };
    const counts = await economic();
    assert.equal((await save(c.id, 0, { HEAD: h.id })).status, 200);
    assert.equal((await activate(c.id, 0, 1)).status, 200);
    assert.deepEqual(await economic(), counts);
    const after = (await call("GET", statusPath)).body;
    assert.deepEqual(after.box, before.box);
    assert.ok(JSON.stringify(after.box).includes(reward.id));
  });
  it("allows try-on of an approved sale item without allowing unowned save", async () => {
    const h = await item("HEAD", false);
    await fit(h);
    const row = (await wardrobe()).body.accessories.find(
      (r) => r.item.id === h.id,
    );
    assert.equal(row.canPreview, true);
    assert.equal(row.canSelect, false);
    assert.equal(row.canPurchase, true);
    assert.equal(
      (await save("default", 0, { HEAD: h.id })).body.code,
      "ITEM_NOT_OWNED",
    );
  });
  it("rejects cross-channel cursors and disables preview of preservation-only/inactive items", async () => {
    await item("CHARACTER");
    const first = await call("GET", "/shop/characters?limit=1");
    assert.ok(first.body.nextCursor);
    assert.equal(
      (
        await call(
          "GET",
          `/shop/characters?limit=1&cursor=${first.body.nextCursor}`,
          undefined,
          { "X-Release-Channel": "testflight" },
        )
      ).status,
      400,
    );
    const old = await item("FACE");
    const inactive = await item("HEAD", true, { active: false });
    await fit(inactive);
    const hidden = await item("NECK", true, { testOnly: true });
    await fit(hidden);
    const rows = (await wardrobe()).body.accessories;
    assert.equal(rows.find((r) => r.item.id === old.id).canPreview, false);
    assert.equal(rows.find((r) => r.item.id === inactive.id).canPreview, false);
    assert.equal(
      rows.some((r) => r.item.id === hidden.id),
      false,
    );
  });
});
