const assert = require('node:assert/strict');
const { describe, it, before, beforeEach } = require('node:test');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
const { cleanDatabase, createTestUser, prisma, request, getSharedServer } = require('./setup');
let server, viewer;
const headers = { 'X-Client-Features': 'characters,remote_assets' };
async function call(path, customHeaders = headers, user = viewer) {
  const r = await request(server.baseUrl, 'GET', path, { token: user?.token, headers: customHeaders });
  return { status: r.status, body: await r.json() };
}
const preview = (i, h = headers, u = viewer) => call(`/shop/items/${i.id}/preview`, h, u);
async function item(slot, owned = false, extras = {}) {
  const i = await prisma.shopItem.create({ data: { sku: crypto.randomUUID(), name: slot, slot,
    assetKey: slot.toLowerCase(), priceCoins: 10, ...extras } });
  if (owned) await prisma.userShopItem.create({ data: { userId: viewer.user.id, shopItemId: i.id } });
  return i;
}
async function fit(i, c = null) {
  await prisma.shopItemCharacterFit.create({ data: { accessoryShopItemId: i.id,
    characterKey: c?.id || 'default', characterShopItemId: c?.id || null } });
}
async function equip(i) {
  await prisma.userEquippedAccessory.create({ data: { userId: viewer.user.id, slot: i.slot, shopItemId: i.id } });
}
async function snapshot() {
  return { user: await prisma.user.findUnique({ where: { id: viewer.user.id } }),
    equipment: await prisma.userEquippedAccessory.findMany({ orderBy: { id: 'asc' } }),
    wardrobes: await prisma.characterWardrobe.findMany({ include: { items: true }, orderBy: { id: 'asc' } }),
    owned: await prisma.userShopItem.findMany({ orderBy: { id: 'asc' } }),
    transactions: await prisma.coinTransaction.count() };
}
describe('accessory preview public read-only contract', () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); viewer = await createTestUser({ displayName: 'Preview owner', clientFeatures: ['characters', 'remote_assets'], clientFeaturesAt: new Date() }); });
  it('composes active outfit, replaces its slot, removes fit and tag conflicts without any writes', async () => {
    const c = await item('CHARACTER', true); await equip(c);
    const candidate = await item('HEAD', false, { compatibility: { blocksTags: ['eyewear'] } });
    const old = await item('HEAD', true), blocked = await item('FACE', true, { compatibility: { tags: ['eyewear'] } });
    const kept = await item('BACK', true), badFit = await item('FEET', true), inactive = await item('NECK', true, { active: false });
    for (const i of [candidate, old, blocked, kept, inactive]) await fit(i, c);
    for (const i of [old, blocked, kept, badFit, inactive]) await equip(i);
    const beforeState = await snapshot();
    for (let pass = 0; pass < 2; pass++) {
      const r = await preview(candidate); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.canPreview, true); assert.equal(r.body.usedFallbackCharacter, false);
      assert.equal(r.body.character.characterKey, c.id);
      assert.deepEqual(r.body.accessories.map(i => i.id).sort(), [candidate.id, kept.id].sort());
      assert.ok(!('priceCoins' in r.body.character.item));
      assert.ok(r.body.accessories.every(i => !('priceCoins' in i)));
    }
    assert.deepEqual(await snapshot(), beforeState);
  });
  it('uses approved default saved outfit when active character does not fit', async () => {
    const c = await item('CHARACTER', true); await equip(c);
    const candidate = await item('HEAD'); await fit(candidate);
    const saved = await item('BACK', true); await fit(saved);
    await prisma.characterWardrobe.create({ data: { userId: viewer.user.id, characterKey: 'default',
      items: { create: { slot: saved.slot, shopItemId: saved.id } } } });
    const beforeState = await snapshot();
    const r = await preview(candidate); assert.equal(r.status, 200);
    assert.deepEqual(r.body.character, { characterKey: 'default', name: 'Capybara', item: null });
    assert.equal(r.body.usedFallbackCharacter, true);
    assert.deepEqual(r.body.accessories.map(i => i.id).sort(), [candidate.id, saved.id].sort());
    assert.deepEqual(await snapshot(), beforeState);
  });
  it('chooses a visible unowned fallback mannequin with remote render metadata, without granting wardrobe access', async () => {
    const candidate = await item('HEAD');
    const hidden = await item('CHARACTER', false, { sortOrder: -2, testOnly: true }); await fit(candidate, hidden);
    const c = await item('CHARACTER', false, { sortOrder: -1, remoteOnly: true, assetVersion: '123456abcdef',
      assetKey: 'preview_remote', renderMetadata: { animationFrames: 4 } }); await fit(candidate, c);
    const second = await item('CHARACTER'); await fit(candidate, second);
    const beforeState = await snapshot();
    const r = await preview(candidate); assert.equal(r.status, 200);
    assert.equal(r.body.character.characterKey, c.id); assert.equal(r.body.usedFallbackCharacter, true);
    assert.equal(r.body.character.item.assetVersion, '123456abcdef');
    assert.ok(r.body.character.item.assetUrl.includes('preview_remote'));
    assert.deepEqual(r.body.accessories.map(i => i.id), [candidate.id]);
    assert.equal((await call(`/shop/characters/${c.id}/wardrobe`)).status, 403);
    assert.equal((await preview(candidate, { 'X-Client-Features': 'characters' })).body.character.characterKey, second.id);
    assert.equal((await preview(candidate, { ...headers, 'X-Release-Channel': 'testflight' })).body.character.characterKey, hidden.id);
    assert.deepEqual(await snapshot(), beforeState);
  });
  it('returns safe empty unavailable context, honors inactive/hidden/earned policy and legacy capabilities', async () => {
    const candidate = await item('HEAD');
    const checkUnavailable = (r, reason) => {
      assert.equal(r.status, 200); assert.deepEqual(r.body, { itemId: candidate.id, canPreview: false,
        unavailableReason: reason, usedFallbackCharacter: false, character: null, accessories: [] });
    };
    checkUnavailable(await preview(candidate), 'no_compatible_character');
    const c = await item('CHARACTER'); await fit(candidate, c);
    checkUnavailable(await preview(candidate, {}), 'no_compatible_character');
    await fit(candidate); assert.equal((await preview(candidate, {})).body.canPreview, true);
    await prisma.shopItem.update({ where: { id: candidate.id }, data: { active: false } });
    checkUnavailable(await preview(candidate), 'inactive');
    for (const data of [{ active: true, testOnly: true }, { testOnly: false, remoteOnly: true }, { remoteOnly: false, earnOnly: true }]) {
      await prisma.shopItem.update({ where: { id: candidate.id }, data });
      assert.equal((await preview(candidate, {})).status, 404);
    }
    assert.equal((await preview(c)).status, 404);
    assert.equal((await preview({ id: 'missing' })).status, 404);
    assert.equal((await preview(candidate, headers, null)).status, 401);
  });
  it('never uses an unowned earn-only fallback, but supports owned earn-only previews', async () => {
    const candidate = await item('HEAD');
    const c = await item('CHARACTER', false, { earnOnly: true }); await fit(candidate, c);
    assert.equal((await preview(candidate)).body.canPreview, false);
    await prisma.userShopItem.create({ data: { userId: viewer.user.id, shopItemId: c.id } });
    assert.equal((await preview(candidate)).body.character.characterKey, c.id);
    await prisma.shopItem.update({ where: { id: candidate.id }, data: { earnOnly: true } });
    assert.equal((await preview(candidate)).status, 404);
    await prisma.userShopItem.create({ data: { userId: viewer.user.id, shopItemId: candidate.id } });
    assert.equal((await preview(candidate)).body.canPreview, true);
  });
  it('responds to changed server fits and keeps each viewer outfit private', async () => {
    const candidate = await item('HEAD'); await fit(candidate);
    const saved = await item('BACK', true); await fit(saved); await equip(saved);
    const rival = await createTestUser({ displayName: 'Preview rival' });
    assert.deepEqual((await preview(candidate)).body.accessories.map(i => i.id).sort(), [candidate.id, saved.id].sort());
    assert.deepEqual((await preview(candidate, headers, rival)).body.accessories.map(i => i.id), [candidate.id]);
    await prisma.shopItemCharacterFit.deleteMany({ where: { accessoryShopItemId: candidate.id } });
    assert.equal((await preview(candidate)).body.canPreview, false);
    assert.equal((await preview(candidate, headers, rival)).body.canPreview, false);
  });
});
