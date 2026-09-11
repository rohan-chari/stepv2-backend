const assert = require('node:assert/strict');
const { before, beforeEach, after, it } = require('node:test');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prisma, cleanDatabase, request, getSharedServer } = require('./setup');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backpack-retirement-test-'));
let server, item, userId, token, plan;
function run(args) {
  return spawnSync(process.execPath, ['scripts/retire-backpack.js', ...args], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DOTENV_CONFIG_QUIET: 'true' },
  });
}
async function call(method, route, body, key) {
  const response = await request(server.baseUrl, method, route, {
    token, body, headers: { 'X-Client-Features': 'characters,remote_assets', ...(key ? { 'Idempotency-Key': key } : {}) },
  });
  return { status: response.status, body: await response.json() };
}
before(async () => { server = await getSharedServer(); });
beforeEach(async () => {
  await cleanDatabase();
  const auth = await request(server.baseUrl, 'POST', '/auth/apple', { body: { identityToken: 'backpack-retirement-test' } });
  const identity = await auth.json();
  userId = identity.user.id;
  token = identity.sessionToken;
  await prisma.user.update({ where: { id: userId }, data: { coins: 2000 } });
  item = await prisma.shopItem.create({ data: {
    sku: 'backpack', name: 'Backpack', slot: 'BACK', assetKey: 'backpack', priceCoins: 700, assetVersion: '12345678abcd',
  } });
  assert.equal((await call('POST', `/shop/items/${item.id}/purchase`, {}, 'original-backpack-purchase')).status, 200);
  await prisma.shopItem.update({ where: { id: item.id }, data: { priceCoins: 1000 } });
  plan = path.join(directory, `${crypto.randomUUID()}.json`);
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

it('dry-run preserves state; apply refunds actual debit, removes ownership and retains history/art; replay is exactly once', async () => {
  const purchaseBefore = await prisma.shopPurchaseRequest.findMany();
  let result = run(['--snapshot', plan]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(plan).mode & 0o777, 0o600);
  assert.equal((await prisma.user.findUnique({ where: { id: userId } })).coins, 1300);
  assert.equal(await prisma.userShopItem.count(), 1);
  assert.equal((await prisma.shopItem.findUnique({ where: { id: item.id } })).active, true);
  result = run(['--apply', '--plan', plan]);
  assert.equal(result.status, 0, result.stderr);
  let catalog = await call('GET', '/shop/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.coins, 2000);
  assert.deepEqual(catalog.body.ownedItemIds, []);
  assert.deepEqual(catalog.body.items, []);
  const savedItem = await prisma.shopItem.findUnique({ where: { id: item.id } });
  assert.equal(savedItem.active, false);
  assert.equal(savedItem.assetVersion, item.assetVersion);
  assert.deepEqual(await prisma.shopPurchaseRequest.findMany(), purchaseBefore);
  const refund = await prisma.coinTransaction.findMany({ where: { reason: 'shop_refund' } });
  assert.equal(refund.length, 1);
  assert.equal(refund[0].amount, 700);
  assert.equal(refund[0].refId, item.id);
  result = run(['--apply', '--plan', plan]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await call('GET', '/shop/catalog')).body.coins, 2000);
  assert.equal(await prisma.coinTransaction.count({ where: { reason: 'shop_refund' } }), 1);
  // The historical response remains replayable, but cannot re-grant ownership.
  assert.equal((await call('POST', `/shop/items/${item.id}/purchase`, {}, 'original-backpack-purchase')).status, 200);
  assert.equal(await prisma.userShopItem.count(), 0);
  assert.equal((await call('POST', `/shop/items/${item.id}/purchase`, {}, 'new-backpack-purchase')).status, 404);
});

it('new equipment after snapshot aborts atomically', async () => {
  assert.equal(run(['--snapshot', plan]).status, 0);
  await prisma.userEquippedAccessory.create({ data: { userId, shopItemId: item.id, slot: 'BACK' } });
  const result = run(['--apply', '--plan', plan]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retained references/i);
  assert.equal((await prisma.user.findUnique({ where: { id: userId } })).coins, 1300);
  assert.equal(await prisma.userShopItem.count(), 1);
  assert.equal((await prisma.shopItem.findUnique({ where: { id: item.id } })).active, true);
});

it('receipt/debit mismatch rejects even a fresh snapshot', async () => {
  await prisma.coinTransaction.updateMany({ where: { reason: 'shop_purchase' }, data: { amount: -1000 } });
  const result = run(['--snapshot', plan]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /purchase.*debit|debit.*purchase/i);
  assert.equal(await prisma.coinTransaction.count({ where: { reason: 'shop_refund' } }), 0);
  assert.equal(await prisma.userShopItem.count(), 1);
});

it('new ownership after snapshot and preexisting ambiguous refund both abort', async () => {
  assert.equal(run(['--snapshot', plan]).status, 0);
  const extra = await prisma.user.create({ data: { appleId: crypto.randomUUID() } });
  await prisma.userShopItem.create({ data: { userId: extra.id, shopItemId: item.id } });
  let result = run(['--apply', '--plan', plan]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership|owner/i);
  await prisma.userShopItem.deleteMany({ where: { userId: extra.id } });
  await prisma.coinTransaction.create({ data: { userId, amount: 10, reason: 'shop_refund', refId: item.id } });
  result = run(['--apply', '--plan', plan]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refund/i);
  assert.equal((await prisma.user.findUnique({ where: { id: userId } })).coins, 1300);
  assert.equal(await prisma.userShopItem.count(), 1);
});
