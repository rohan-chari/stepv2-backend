const { createHmac, timingSafeEqual } = require('node:crypto');
const { prisma: defaultPrisma } = require('../../../db');
const { AppError } = require('../../../shared/errors/AppError');
const { PRODUCTS } = require('../../billing/catalog');

const KINDS = new Set(['all', 'coin_pack', 'subscription', 'in_game']);
const SOURCES = new Set(['billing', 'shop', 'powerup', 'ledger']);
const WINDOW_MS = 30 * 86400000;
const STAMP = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const coinProducts = PRODUCTS.filter(p => p.kind === 'coins').map(p => p.id);
const memberProducts = PRODUCTS.filter(p => ['subscription', 'non_consumable'].includes(p.kind)).map(p => p.id);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' && value.trim() ? value : null;
const invalid = () => new AppError('Invalid purchase history request', 'INVALID_ADMIN_PURCHASES_REQUEST', 400);

function sign(payload, secret) {
  return createHmac('sha256', secret).update('admin-purchases-v1\0').update(payload).digest('base64url');
}

function decodeCursor(raw, secret, kind, environment, now) {
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid();
  const parts = raw.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw invalid();
  const expected = Buffer.from(sign(parts[0], secret));
  const supplied = Buffer.from(parts[1]);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid();
  let cursor;
  try { cursor = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!object(cursor) || cursor.v !== 1 || cursor.kind !== kind || cursor.environment !== environment ||
      !SOURCES.has(cursor.source) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 200 ||
      typeof cursor.end !== 'string' || typeof cursor.at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at)) throw invalid();
  const end = Date.parse(cursor.end), at = Date.parse(cursor.at);
  if (!Number.isFinite(end) || !Number.isFinite(at) || end > now.getTime() ||
      now.getTime() - end > WINDOW_MS || at > end || at < end - WINDOW_MS) throw invalid();
  return cursor;
}

// These clauses are generated only from fixed source names. All external data
// is bound as SQL parameters. Preserve microseconds in cursors instead of
// round-tripping PostgreSQL timestamps through JavaScript Date milliseconds.
function bounds(source, time) {
  return `${time} >= $1::timestamp AND ${time} <= $2::timestamp
    AND ($3::timestamp IS NULL OR ${time} < $3::timestamp OR
      (${time} = $3::timestamp AND ('${source}' COLLATE "C" < $4::text COLLATE "C" OR
        ('${source}' = $4::text AND p.id COLLATE "C" < $5::text COLLATE "C"))))`;
}

function purchaseRow(row) {
  const deleted = row.deleted === true;
  const result = object(row.result);
  const normal = object(result?.purchase);
  const ads = typeof result?.adsWatched === 'number' && result.adsWatched > 0;
  const recordedCoins = nonnegative(row.coins);
  // An empty historical result object does not establish purchase provenance.
  const normalProven = normal && (
    (nonnegative(normal.coinsSpent) !== null && normal.coinsSpent === recordedCoins) ||
    (normal.coinsSpent == null && normal.alreadyOwned === false)
  );
  const base = {
    id: `${row.source}:${row.id}`,
    kind: row.kind,
    username: deleted ? null : text(row.username),
    userStatus: deleted ? 'deleted' : row.user_present ? 'active' : 'unknown',
    productId: row.product_id,
    productName: text(row.product_name),
    occurredAt: row.occurred_at,
    status: 'unknown', funding: 'unknown', coinsSpent: null,
    cashAmount: null, currency: null,
    environment: row.environment ?? null,
    store: row.store ?? null,
    benefitKind: row.benefit_kind ?? null,
    refundedAt: row.refunded_at ?? null,
  };
  if (row.source === 'billing') {
    const benefit = row.benefit_kind;
    base.funding = benefit === 'trial' ? 'trial' : ['paid', 'permanent'].includes(benefit) ? 'cash' : 'unknown';
    base.status = row.refunded_at || row.fulfillment === 'reversed' ? 'refunded'
      : benefit === 'trial' ? 'trial' : benefit === 'unpaid' ? 'unpaid'
      : row.fulfillment === 'pending' ? 'pending'
      : row.fulfillment === 'fulfilled' && ['paid', 'permanent'].includes(benefit) ? 'purchased' : 'unknown';
  } else if (row.source === 'ledger') {
    base.coinsSpent = recordedCoins;
    base.status = 'purchased'; base.funding = 'coins';
  } else if (ads && recordedCoins !== null) {
    base.coinsSpent = recordedCoins;
    base.status = 'purchased'; base.funding = recordedCoins > 0 ? 'coins_and_ads' : 'ads';
  } else if (normalProven && recordedCoins !== null) {
    base.coinsSpent = recordedCoins;
    base.status = recordedCoins === 0 ? 'free' : 'purchased';
    base.funding = recordedCoins === 0 ? 'free' : 'coins';
  }
  return base;
}

function buildListAdminPurchases(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  return async function listAdminPurchases(options = {}) {
    const kind = options.kind ?? 'all';
    const environment = options.environment ?? 'production';
    const rawLimit = options.limit ?? 20;
    if (!KINDS.has(kind) || !['production', 'sandbox'].includes(environment) ||
        !['string', 'number'].includes(typeof rawLimit) || !/^[1-9]\d?$/.test(String(rawLimit))) throw invalid();
    const limit = Number(rawLimit);
    if (limit > 50) throw invalid();
    const instant = now();
    const secret = dependencies.cursorSecret || process.env.SESSION_TOKEN_SECRET;
    if (typeof secret !== 'string' || !secret) throw new AppError('Purchase history is temporarily unavailable', 'ADMIN_PURCHASES_UNAVAILABLE', 503);
    const cursor = options.cursor == null ? null : decodeCursor(options.cursor, secret, kind, environment, instant);
    const end = cursor?.end ?? instant.toISOString();
    const start = new Date(Date.parse(end) - WINDOW_MS).toISOString();
    const params = [start, end, cursor?.at ?? null, cursor?.source ?? '', cursor?.id ?? '', limit + 1];
    const queries = [];
    if (kind !== 'in_game') {
      const filter = kind === 'coin_pack' ? 'AND p.product_id = ANY($8::text[])'
        : kind === 'subscription' ? 'AND (p.subscription_id IS NOT NULL OR p.product_id = ANY($9::text[]))' : '';
      queries.push({
        sql: `SELECT p.id, 'billing'::text source,
          CASE WHEN p.subscription_id IS NOT NULL OR p.product_id = ANY($9::text[]) THEN 'subscription'
            WHEN p.product_id = ANY($8::text[]) THEN 'coin_pack' ELSE 'other' END kind,
          to_char(p.purchased_at, '${STAMP}') occurred_at,
          u.display_name username, u.id IS NOT NULL user_present,
          (i.deleted_at IS NOT NULL OR u.id IS NULL) deleted,
          p.product_id, NULL::text product_name, NULL::integer coins, NULL::jsonb result,
          p.environment, p.store, p.benefit_kind, p.fulfillment_status fulfillment,
          to_char(p.refunded_at, '${STAMP}') refunded_at
          FROM billing_purchases p LEFT JOIN billing_identities i ON i.id = p.identity_id
          LEFT JOIN users u ON u.id = i.user_id
          WHERE ${bounds('billing', 'p.purchased_at')} AND p.environment = $7::text ${filter}
          ORDER BY p.purchased_at DESC, p.id COLLATE "C" DESC LIMIT $6::int`,
        params: [...params, environment, coinProducts, memberProducts],
      });
    }
    if (kind === 'all' || kind === 'in_game') {
      for (const source of ['shop', 'powerup']) {
        const table = source === 'shop' ? 'shop_purchase_requests' : 'powerup_purchase_requests';
        const catalog = source === 'shop' ? 'shop_items' : 'powerup_shop_items';
        const fk = source === 'shop' ? 'shop_item_id' : 'powerup_shop_item_id';
        queries.push({sql: `SELECT p.id, '${source}'::text source, 'in_game'::text kind,
          to_char(p.created_at, '${STAMP}') occurred_at,
          u.display_name username, u.id IS NOT NULL user_present, (u.id IS NULL) deleted,
          COALESCE(item.sku, p.${fk}) product_id, item.name product_name,
          p.coins_spent coins,
          jsonb_build_object('purchase',p.result_json->'purchase','adsWatched',p.result_json->'adsWatched') result
          FROM ${table} p LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN ${catalog} item ON item.id = p.${fk}
          WHERE ${bounds(source, 'p.created_at')} AND p.status = 'SUCCEEDED'
            AND (p.result_json #> '{purchase,alreadyOwned}') IS DISTINCT FROM 'true'::jsonb
          ORDER BY p.created_at DESC, p.id COLLATE "C" DESC LIMIT $6::int`, params});
      }
      queries.push({sql: `SELECT p.id, 'ledger'::text source, 'in_game'::text kind,
        to_char(p.created_at, '${STAMP}') occurred_at,
        u.display_name username, u.id IS NOT NULL user_present, (u.id IS NULL) deleted,
        p.reason product_id, CASE p.reason WHEN 'powerup_upgrade' THEN 'Powerup upgrade' ELSE 'Mystery box reroll' END product_name,
        (-p.amount)::bigint coins, NULL::jsonb result
        FROM coin_transactions p LEFT JOIN users u ON u.id = p.user_id
        WHERE ${bounds('ledger', 'p.created_at')} AND p.reason IN ('powerup_upgrade','billing_reroll') AND p.amount < 0
        ORDER BY p.created_at DESC, p.id COLLATE "C" DESC LIMIT $6::int`, params});
    }
    // One short read-only snapshot keeps all four source pages consistent;
    // each source reads at most limit+1 rows. No per-buyer lookups/count query.
    const rows = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
      const result = [];
      for (const query of queries) result.push(...await tx.$queryRawUnsafe(query.sql, ...query.params));
      return result;
    }, { isolationLevel: 'RepeatableRead', timeout: 10000 });
    rows.sort((a, b) => {
      for (const field of ['occurred_at', 'source', 'id']) {
        if (a[field] !== b[field]) return a[field] > b[field] ? -1 : 1;
      }
      return 0;
    });
    const selected = rows.slice(0, limit);
    let nextCursor = null;
    if (rows.length > limit) {
      const last = selected[selected.length - 1];
      const payload = Buffer.from(JSON.stringify({v:1,kind,environment,end,at:last.occurred_at,source:last.source,id:last.id})).toString('base64url');
      nextCursor = `${payload}.${sign(payload, secret)}`;
    }
    return {
      generatedAt: instant.toISOString(), window: {days:30,start,end},
      items: selected.map(row => purchaseRow({...row, coins: typeof row.coins === 'bigint' ? Number(row.coins) : row.coins})),
      nextCursor,
    };
  };
}

module.exports = { buildListAdminPurchases };
