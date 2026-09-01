// Read-through caching + the invalidation failure breaker for the Redis
// derived-data layer (spec §3 "Cache mutation failure rules", §5 Phases B/C).
//
// Three responsibilities, deliberately in one module because they are one
// state machine:
//   1. `cachedRead`  — read-through with a hard rule: ANY doubt => Postgres.
//   2. `invalidate`  — mutations NEVER write caches, they only delete. On a
//      failed delete the process opens a per-prefix READ BYPASS, broadcasts it
//      to peers, and keeps retrying in the background until the delete lands.
//      The bypass stays open until then — not for a fixed window (spec v5).
//   3. `onInvalidate`— lets the legacy in-process TTL caches (`appSettings`,
//      `balanceConfig`) bust themselves on a peer's write, which is the
//      cluster-incoherence bug called out in §2 item 3.
//
// Everything degrades to "just call Postgres". There is no code path here in
// which a Redis problem can make a request fail.

const redisCache = require("./redisCache");

// Sentinel prefixes carried in the pub/sub `prefix` field. The wrapper's
// message shape is fixed (`{key, prefix}`), so the breaker signal is encoded
// INTO the prefix string rather than by adding a field — keeping
// `redisCache.publishInvalidate`'s contract untouched (it is Phase A code with
// its own tests).
const BYPASS_OPEN = "__bypass_open__:";
const BYPASS_CLOSE = "__bypass_close__:";

const RETRY_INTERVAL_MS = Number(process.env.CACHE_INVALIDATE_RETRY_MS || 500);

/** prefix -> { timer: NodeJS.Timeout|null, keys: string[], local: boolean } */
const bypasses = new Map();
/** prefix -> Set<() => void> in-process cache busters */
const localBusters = new Map();

let subscribed = false;
let subscribing = null;

// ── read bypass ─────────────────────────────────────────────────────────────

function isBypassed(key) {
  if (bypasses.size === 0) return false;
  for (const prefix of bypasses.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function closeBypass(prefix) {
  const entry = bypasses.get(prefix);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  bypasses.delete(prefix);
}

function openPeerBypass(prefix) {
  // A peer told us its delete failed. We hold no retry loop for someone else's
  // keys — our bypass closes when the owner broadcasts success, on subscriber
  // reconnect, or (backstop) when the key's own TTL expires.
  if (bypasses.has(prefix)) return;
  bypasses.set(prefix, { timer: null, keys: [], local: false });
}

/**
 * Open the local bypass for `prefix` and keep retrying `run` until it succeeds.
 * Best-effort broadcast so peer workers bypass too (§3: the broadcast travels
 * through the same struggling Redis, so each key's physical TTL is the real
 * backstop — which is why chat's TTL is 15min and every C1 key is 60s).
 */
function openBypassWithRetry(prefix, run) {
  const existing = bypasses.get(prefix);
  if (existing && existing.timer) return; // already retrying
  if (existing) closeBypass(prefix);

  const entry = { timer: null, keys: [], local: true };
  bypasses.set(prefix, entry);
  redisCache.publishInvalidate({ prefix: `${BYPASS_OPEN}${prefix}` }).catch(() => {});

  entry.timer = setInterval(async () => {
    // If Redis went away entirely there is nothing left to delete: reads
    // already fall through to Postgres, and a stale key cannot be served.
    if (!redisCache.isEnabled()) {
      closeBypass(prefix);
      return;
    }
    let ok = false;
    try {
      ok = await run();
    } catch {
      ok = false;
    }
    if (!ok) return;
    closeBypass(prefix);
    redisCache
      .publishInvalidate({ prefix: `${BYPASS_CLOSE}${prefix}` })
      .catch(() => {});
    redisCache.publishInvalidate({ prefix }).catch(() => {});
  }, RETRY_INTERVAL_MS);
  entry.timer.unref?.();
}

// ── pub/sub wiring ──────────────────────────────────────────────────────────

function handleMessage(message) {
  const prefix = message.prefix || message.key;
  if (!prefix) return;

  if (prefix.startsWith(BYPASS_OPEN)) {
    openPeerBypass(prefix.slice(BYPASS_OPEN.length));
    return;
  }
  if (prefix.startsWith(BYPASS_CLOSE)) {
    const target = prefix.slice(BYPASS_CLOSE.length);
    const entry = bypasses.get(target);
    // Never let a peer close OUR bypass — ours closes when OUR delete lands.
    if (entry && !entry.local) closeBypass(target);
    return;
  }

  // Ordinary invalidation: bust every in-process cache registered under a
  // matching prefix. Redis-side deletion was already done by the publisher.
  for (const [registered, handlers] of localBusters) {
    if (!prefix.startsWith(registered) && !registered.startsWith(prefix)) continue;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch {}
    }
  }
}

function flushEverything() {
  // Subscriber (re)connected. Messages published while we were disconnected are
  // gone forever (§3 "Pub/sub is lossy"), so assume we missed some.
  for (const handlers of localBusters.values()) {
    for (const handler of handlers) {
      try {
        handler();
      } catch {}
    }
  }
  for (const [prefix, entry] of [...bypasses]) {
    if (!entry.local) closeBypass(prefix);
  }
}

/**
 * Idempotent, lazy subscribe. Lazy because `REDIS_URL` is read lazily by the
 * wrapper (and flipped between cases by tests), so there is no safe eager
 * moment; `redisCache.close()` tears the subscriber down and this re-arms it.
 */
function ensureSubscribed() {
  if (!redisCache.isEnabled()) {
    subscribed = false;
    return;
  }
  if (subscribed && redisCache.diagnostics().subscriberCreated) return;
  if (subscribing) return;
  subscribed = true;
  subscribing = redisCache
    .subscribe(handleMessage, { onReconnect: flushEverything })
    .catch(() => {
      subscribed = false;
    })
    .finally(() => {
      subscribing = null;
    });
}

/**
 * Register an in-process cache buster for `prefix`. Fires when a peer worker
 * (or this one) publishes an invalidation covering that prefix, and on every
 * subscriber reconnect.
 * @returns {() => void} unregister
 */
function onInvalidate(prefix, handler) {
  if (!localBusters.has(prefix)) localBusters.set(prefix, new Set());
  localBusters.get(prefix).add(handler);
  ensureSubscribed();
  return () => localBusters.get(prefix)?.delete(handler);
}

// ── read-through ────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.key logical cache key
 * @param {string} opts.prefix breaker/bypass scope this key belongs to
 * @param {number} opts.ttlSeconds
 * @param {boolean} opts.enabled the surface's app-setting flag
 * @param {() => Promise<any>} opts.load the existing Postgres path
 * @returns {Promise<any>} always `load()`'s value or a byte-identical cached copy
 */
async function cachedRead({ key, prefix, ttlSeconds, enabled, load }) {
  if (!enabled || !redisCache.isEnabled()) return load();
  ensureSubscribed();
  if (isBypassed(prefix || key)) return load();

  // Values are boxed so a legitimately falsy/null payload is still a cache HIT
  // rather than an eternal miss.
  const hit = await redisCache.getJSON(key);
  if (hit && typeof hit === "object" && "v" in hit) return hit.v;

  const fresh = await load();
  await redisCache.setJSON(key, { v: fresh }, ttlSeconds);
  return fresh;
}

// ── invalidation ────────────────────────────────────────────────────────────

/**
 * Delete `keys` and broadcast. Retries ONCE inline; on a second failure opens
 * the per-prefix read bypass + background retry (§3).
 *
 * @param {object} opts
 * @param {string[]} [opts.keys] keys to DEL
 * @param {string} opts.prefix bypass/broadcast scope
 * @param {() => Promise<{ok: boolean, disabled: boolean}>} [opts.run] custom
 *   mutation (Phase C uses the atomic `SET msgver + DEL list` Lua) instead of a
 *   plain DEL.
 * @returns {Promise<boolean>} true when the cache is known-clean.
 */
async function invalidate({ keys = [], prefix, run }) {
  // Redis off => there is no cache to invalidate and nothing stale can be
  // served. Opening a bypass here would be a permanent no-op breaker.
  if (!redisCache.isEnabled()) return true;
  ensureSubscribed();

  const attempt =
    run ||
    (async () => {
      const ok = await redisCache.del(keys);
      return { ok, disabled: false };
    });

  const runOnce = async () => {
    try {
      const result = await attempt();
      return Boolean(result && result.ok);
    } catch {
      return false;
    }
  };

  let ok = await runOnce();
  if (!ok) ok = await runOnce(); // retry once inline

  if (ok) {
    closeBypass(prefix);
    await redisCache.publishInvalidate({ prefix, ...(keys[0] ? { key: keys[0] } : {}) });
    return true;
  }

  openBypassWithRetry(prefix, runOnce);
  return false;
}

/** Test/ops hook: drop all breaker state and in-process registrations. */
function reset() {
  for (const prefix of [...bypasses.keys()]) closeBypass(prefix);
  subscribed = false;
}

module.exports = {
  cachedRead,
  invalidate,
  onInvalidate,
  isBypassed,
  ensureSubscribed,
  reset,
  BYPASS_OPEN,
  BYPASS_CLOSE,
};
