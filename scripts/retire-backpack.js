#!/usr/bin/env node
// One-off operation for the audited single paid Backpack owner. No artwork,
// purchase history, outfit, or application policy files are removed.
// node scripts/retire-backpack.js --snapshot /private/backpack-plan.json
// node scripts/retire-backpack.js --apply --plan /private/backpack-plan.json
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { prisma, runInPrismaTransaction } = require('../src/db');
const { awardCoins } = require('../src/shared/economy/awardCoins');

const SCHEMA = 'backpack-retirement-v1';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const normalized = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(canonical(normalized(value)))).digest('hex');
function insist(condition, message) { if (!condition) throw new Error(message); }
function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}
async function audit(tx) {
  const item = await tx.shopItem.findUnique({ where: { sku: 'backpack' } });
  insist(item && item.slot === 'BACK' && item.assetKey === 'backpack', 'Backpack identity/slot mismatch');
  const references = [item.id, item.sku];
  // Bounded to the audited one-owner case. A second receipt/owner is a fresh
  // operational decision, never silently included in this refund operation.
  const owners = await tx.userShopItem.findMany({ where: { shopItemId: { in: references } }, orderBy: { id: 'asc' }, take: 2 });
  const purchases = await tx.shopPurchaseRequest.findMany({ where: { shopItemId: { in: references } }, orderBy: { id: 'asc' }, take: 2 });
  const ledger = await tx.coinTransaction.findMany({ where: { refId: { in: [...references, ...purchases.map(p => p.id)] } }, orderBy: { id: 'asc' }, take: 4 });
  const [refs] = await tx.$queryRaw`
    SELECT EXISTS(SELECT 1 FROM user_equipped_accessories WHERE shop_item_id=ANY(${references}::text[])) AS equipped,
      EXISTS(SELECT 1 FROM character_wardrobe_items WHERE shop_item_id=ANY(${references}::text[])) AS saved,
      EXISTS(SELECT 1 FROM ad_reward_grants WHERE shop_item_id=ANY(${references}::text[])) AS ads,
      EXISTS(SELECT 1 FROM daily_reward_claims WHERE shop_item_id=ANY(${references}::text[])) AS daily,
      EXISTS(SELECT 1 FROM billing_cosmetic_releases WHERE shop_item_id=ANY(${references}::text[])) AS billing_releases,
      EXISTS(SELECT 1 FROM billing_cosmetic_grants WHERE shop_item_id=ANY(${references}::text[])) AS billing_grants`;
  const [database] = await tx.$queryRaw`SELECT current_database() AS name`;
  return normalized({ database: database.name, item, owners, purchases, ledger, refs });
}
function validate(current, allowApplied = false) {
  insist(!Object.values(current.refs).some(Boolean), 'Unexpected retained references; outfit/grant retirement needs a new audit');
  insist(current.purchases.length === 1, 'Expected exactly one audited purchase');
  const purchase = current.purchases[0];
  insist(purchase.status === 'SUCCEEDED' && Number.isSafeInteger(purchase.coinsSpent) && purchase.coinsSpent > 0,
    'Expected one succeeded paid purchase');
  insist(purchase.shopItemId === current.item.id && purchase.resultJson?.item?.id === current.item.id &&
    purchase.resultJson?.purchase?.coinsSpent === purchase.coinsSpent && purchase.resultJson?.purchase?.alreadyOwned === false,
    'Ambiguous purchase result');
  const debits = current.ledger.filter(row => row.reason === 'shop_purchase');
  const refunds = current.ledger.filter(row => row.reason === 'shop_refund');
  insist(debits.length === 1 && debits[0].userId === purchase.userId && debits[0].refId === current.item.id &&
    debits[0].amount === -purchase.coinsSpent, 'Purchase and debit do not agree');
  insist(current.ledger.length === debits.length + refunds.length && refunds.length <= 1, 'Ambiguous refund/ledger references');
  if (refunds.length) {
    insist(allowApplied && refunds[0].userId === purchase.userId && refunds[0].refId === current.item.id &&
      refunds[0].amount === purchase.coinsSpent && current.owners.length === 0 && current.item.active === false,
    'Existing refund is ambiguous or retirement is incomplete');
  } else {
    insist(current.owners.length === 1 && current.owners[0].userId === purchase.userId && current.owners[0].shopItemId === current.item.id,
      'Ownership differs from the one paid owner');
  }
  return { purchase, refunded: refunds.length === 1 };
}
async function invalidate(userId) {
  const derived = require('../src/shared/cache/derivedCache');
  const keys = require('../src/shared/cache/cacheKeys');
  const markers = await require('../src/shared/cache/cacheEfficiencyInvalidation').advance([{ domain: 'presentation', identity: 'catalog' }]);
  const catalog = await derived.invalidate({ keys: keys.shopCatalogVariants(), prefix: keys.PREFIX.SHOP_CATALOG });
  const manifest = await derived.invalidate({ keys: keys.assetsManifestVariants(), prefix: keys.PREFIX.ASSETS_MANIFEST });
  const auth = await require('../src/modules/users/services/authMeCache').invalidateSafe(userId);
  const presentation = await require('../src/modules/social/services/userPresentationCache').invalidate(userId);
  insist([markers, catalog, manifest, auth, presentation].every(value => value !== false),
    'DB COMMITTED, but cache invalidation failed; retry the same plan to finish invalidation');
}
async function main() {
  const apply = process.argv.includes('--apply');
  const snapshotPath = argument('--snapshot');
  const planPath = argument('--plan');
  insist(apply ? planPath && !snapshotPath : snapshotPath && !planPath,
    'Usage: --snapshot <private-new-json> OR --apply --plan <reviewed-json>');
  const plan = apply ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : null;
  if (apply) {
    insist(plan.schema === SCHEMA && plan.fingerprint === digest(plan.audit), 'Invalid plan fingerprint');
    validate(plan.audit);
  }
  const result = await runInPrismaTransaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10s'");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    else {
      // An exclusive catalog lock drains transactions that already read active
      // Backpack, preventing stale purchase reads from granting it after commit.
      // Briefly fence reference writers without locking the entire users table.
      await tx.$executeRawUnsafe('LOCK TABLE shop_items IN ACCESS EXCLUSIVE MODE');
      await tx.$executeRawUnsafe('LOCK TABLE user_shop_items, user_equipped_accessories, character_wardrobe_items, shop_purchase_requests, ad_reward_grants, daily_reward_claims, billing_cosmetic_releases, billing_cosmetic_grants IN SHARE ROW EXCLUSIVE MODE');
      await tx.$queryRaw`SELECT id FROM users WHERE id=${plan.audit.purchases[0].userId} FOR UPDATE`;
    }
    const current = await audit(tx);
    const { purchase, refunded } = validate(current, apply);
    if (!apply) return { audit: current, amount: purchase.coinsSpent };
    const comparable = normalized(current);
    if (refunded) {
      comparable.item.active = plan.audit.item.active;
      comparable.owners = plan.audit.owners;
      comparable.ledger = comparable.ledger.filter(row => row.reason !== 'shop_refund');
    }
    insist(digest(comparable) === plan.fingerprint, 'Snapshot changed; abort and re-audit before applying');
    if (!refunded) {
      await tx.shopItem.update({ where: { id: current.item.id }, data: { active: false } });
      const awarded = await awardCoins({ tx, userId: purchase.userId, amount: purchase.coinsSpent,
        reason: 'shop_refund', refId: current.item.id });
      insist(awarded.awarded === true, 'Refund ledger changed concurrently; transaction aborted');
      const removed = await tx.userShopItem.deleteMany({ where: { id: current.owners[0].id, shopItemId: current.item.id, userId: purchase.userId } });
      insist(removed.count === 1, 'Ownership changed concurrently; transaction aborted');
    }
    return { userId: purchase.userId, amount: purchase.coinsSpent, alreadyApplied: refunded };
  }, { timeout: 15000, isolationLevel: apply ? 'ReadCommitted' : 'RepeatableRead' });
  if (!apply) {
    const snapshot = { schema: SCHEMA, createdAt: new Date().toISOString(), fingerprint: digest(result.audit), audit: result.audit };
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ mode: 'dry-run', owners: 1, refundCoins: result.amount, fingerprint: snapshot.fingerprint }));
  } else {
    await invalidate(result.userId);
    console.log(JSON.stringify({ mode: 'apply', refundCoins: result.amount, alreadyApplied: result.alreadyApplied, cacheInvalidation: 'completed' }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  await prisma.$disconnect();
  await require('../src/shared/cache/redisCache').close();
  // This executable has finished all writes and invalidations. The shared DB
  // runtime owns background telemetry handles beyond Prisma's connection pool.
  process.exit(process.exitCode || 0);
});
