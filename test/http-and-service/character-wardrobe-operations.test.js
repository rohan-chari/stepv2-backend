const assert = require("node:assert/strict");
const { it, beforeEach } = require("node:test");
const { spawnSync } = require("node:child_process");
const { prisma, cleanDatabase } = require("./setup");
const manifest = require("../../data/character-wardrobe-fits.json");
function run(script, args = []) {
  const p = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
  return {
    status: p.status,
    body: p.status === 0 ? JSON.parse(p.stdout) : null,
    error: p.stderr,
  };
}
beforeEach(async () => cleanDatabase());
it("fit manifest validates real opaque identities and applies 56 pairs idempotently without ownership grants", async () => {
  await prisma.shopItem.createMany({
    data: [
      ...manifest.items.map((i) => ({
        id: i.id,
        sku: i.sku,
        slot: i.slot,
        assetKey: i.assetKey,
        name: i.sku,
        priceCoins: 0,
      })),
      ...manifest.characters.map((i) => ({
        id: i.id,
        sku: i.sku,
        slot: "CHARACTER",
        assetKey: i.assetKey,
        name: i.sku,
        priceCoins: 0,
      })),
    ],
  });
  let r = run("scripts/apply-character-wardrobe-fits.js");
  assert.equal(r.status, 0, r.error);
  assert.equal(r.body.approvedPairs, 56);
  assert.equal(await prisma.shopItemCharacterFit.count(), 0);
  r = run("scripts/apply-character-wardrobe-fits.js", ["--apply"]);
  assert.equal(r.status, 0, r.error);
  assert.equal(await prisma.shopItemCharacterFit.count(), 56);
  assert.equal(await prisma.userShopItem.count(), 0);
  r = run("scripts/apply-character-wardrobe-fits.js", ["--apply"]);
  assert.equal(r.status, 0, r.error);
  assert.equal(await prisma.shopItemCharacterFit.count(), 56);
  const crown = manifest.items.find((i) => i.sku === "ranked_legend_crown");
  assert.deepEqual(crown.approvedCharacterKeys, []);
  const shoes = manifest.items.find((i) => i.sku === "shoes");
  assert.equal(shoes.approvedCharacterKeys.length, 2);
});
it("audit protects dynamic reward members and treats unproven test-only designs as investigation", async () => {
  const a = await prisma.shopItem.create({
    data: {
      sku: "audit-released",
      name: "Released",
      slot: "HEAD",
      assetKey: "birthday_hat",
      priceCoins: 1,
    },
  });
  const b = await prisma.shopItem.create({
    data: {
      sku: "audit-unknown",
      name: "Unknown",
      slot: "FACE",
      assetKey: "unknown",
      priceCoins: 1,
      testOnly: true,
    },
  });
  const before = await prisma.shopItem.findMany({ orderBy: { id: "asc" } });
  const r = run("scripts/audit-character-wardrobes.js");
  assert.equal(r.status, 0, r.error);
  assert.equal(
    r.body.items.find((i) => i.id === a.id).rewardPoolEligible,
    true,
  );
  assert.equal(
    r.body.items.find((i) => i.id === a.id).classification,
    "Preserve released",
  );
  assert.equal(
    r.body.items.find((i) => i.id === b.id).classification,
    "Needs investigation",
  );
  assert.deepEqual(
    await prisma.shopItem.findMany({ orderBy: { id: "asc" } }),
    before,
  );
  const dry = run("scripts/retire-character-wardrobe-items.js");
  assert.equal(dry.status, 0, dry.error);
  assert.equal(dry.body.retired, 0);
  assert.deepEqual(
    await prisma.shopItem.findMany({ orderBy: { id: "asc" } }),
    before,
  );
});
it("fit apply aborts missing/changed identity with no partial fit rows", async () => {
  const i = manifest.items[0];
  await prisma.shopItem.create({
    data: {
      id: i.id,
      sku: "wrong-sku",
      name: "Wrong",
      slot: i.slot,
      assetKey: i.assetKey,
      priceCoins: 0,
    },
  });
  const r = run("scripts/apply-character-wardrobe-fits.js", ["--apply"]);
  assert.equal(r.status, 1);
  assert.match(r.error, /identity\/slot mismatch/);
  assert.equal(await prisma.shopItemCharacterFit.count(), 0);
});

it("audit preserves pending ad grants bound by legacy SKU instead of item ID", async () => {
  const i = await prisma.shopItem.create({
    data: {
      sku: "pending-ad-hat",
      name: "Hat",
      slot: "HEAD",
      assetKey: "hat",
      priceCoins: 1,
      testOnly: true,
    },
  });
  const u = await prisma.user.create({
    data: { appleId: "audit-pending-ad-user" },
  });
  await prisma.adRewardGrant.create({
    data: {
      userId: u.id,
      transactionId: "pending-ad-reference",
      grantedDate: "2026-09-09",
      rewardKind: "shop_unlock",
      shopItemId: i.sku,
    },
  });
  const r = run("scripts/audit-character-wardrobes.js");
  assert.equal(r.status, 0, r.error);
  const row = r.body.items.find((x) => x.id === i.id);
  assert.equal(row.refs.ads, 1);
  assert.equal(row.classification, "Preserve owned-or-referenced");
});
