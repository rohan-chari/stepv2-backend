// Redis derived-data cache wrapper (Phase A of
// docs/redis-derived-data-layer-requirements.md, §5 Phase A steps 2-3).
//
// Hard contract — every caller depends on these three properties:
//   1. `REDIS_URL` unset  => the wrapper is FULLY INERT. No client is
//      constructed, no socket is opened, reads return null, writes/invalidates
//      return false, `subscribe` is a no-op. This is the default in tests, on
//      staging until the flag flips, and the master kill switch in prod
//      (unset REDIS_URL + `pm2 reload`).
//   2. Any Redis error is SWALLOWED. Reads return null, writes return false,
//      and the error is logged at most once per minute per operation class.
//      A caller must never see an exception because of Redis — it falls
//      through to its Postgres path instead. (The single exception: an error
//      thrown by the caller's own `withLock` critical section propagates, as
//      it must.)
//   3. Every key and the pub/sub channel are namespaced by `CACHE_ENV_PREFIX`
//      (`p:` prod, `s:` staging, `t:` tests). Redis pub/sub is NOT isolated by
//      logical DB, so the subscriber additionally rejects any message whose key
//      prefix does not match this process's env (belt and braces, §3).
//
// Redis is a cache, never a source of truth (decision D-1): every key here is
// rebuildable from Postgres.

const CHANNEL_SUFFIX = "cache:invalidate";
const ERROR_LOG_INTERVAL_MS = 60_000;

// Lua: release a lock only if we still hold it (token compare-and-delete), so a
// slow critical section that outlived its PX cannot delete someone else's lock.
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

let state = null;
const errorLogTimestamps = new Map();

function logOnce(opClass, error) {
  const now = Date.now();
  const last = errorLogTimestamps.get(opClass) || 0;
  if (now - last < ERROR_LOG_INTERVAL_MS) return;
  errorLogTimestamps.set(opClass, now);
  console.error(
    `[redisCache] ${opClass} failed (further ${opClass} errors suppressed for 60s):`,
    error && error.message ? error.message : error
  );
}

function readConfig() {
  const url = (process.env.REDIS_URL || "").trim();
  return {
    url,
    enabled: url.length > 0,
    keyPrefix: process.env.CACHE_ENV_PREFIX || "",
  };
}

function ensureState() {
  if (!state) state = { config: readConfig(), client: null, subscriber: null };
  return state;
}

function isEnabled() {
  return ensureState().config.enabled;
}

function keyPrefix() {
  return ensureState().config.keyPrefix;
}

function prefixed(key) {
  return `${keyPrefix()}${key}`;
}

function channelName() {
  return `${keyPrefix()}${CHANNEL_SUFFIX}`;
}

function buildClient(role) {
  const { url } = ensureState().config;
  // Required by `require`-time inertness: only pulled in when a client is
  // actually constructed.
  const IORedis = require("ioredis");
  const client = new IORedis(url, {
    // Fail commands immediately while the socket is down instead of queueing
    // them — a caller waiting on a queued command is a caller not falling
    // through to Postgres.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    // Keep trying forever with a capped backoff: a transient Redis restart must
    // heal without a process restart.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    lazyConnect: false,
  });
  // Without a listener, ioredis' EventEmitter turns connection errors into
  // uncaught exceptions.
  client.on("error", (err) => logOnce(`${role}-connection`, err));
  return client;
}

// Resolves once the first connection attempt has settled (ready OR failed), so
// the very first command after startup neither races the handshake nor waits on
// an unreachable server.
function attachReadyGate(client) {
  let settle;
  const gate = new Promise((resolve) => {
    settle = resolve;
  });
  const done = () => settle(true);
  client.once("ready", done);
  client.once("error", done);
  client.once("end", done);
  setTimeout(done, 1500).unref?.();
  return gate;
}

function getClient() {
  const s = ensureState();
  if (!s.config.enabled) return null;
  if (!s.client) {
    s.client = buildClient("client");
    s.clientReady = attachReadyGate(s.client);
  }
  return s.client;
}

async function readyClient() {
  const client = getClient();
  if (!client) return null;
  await ensureState().clientReady;
  return client;
}

/** @returns {Promise<any|null>} parsed JSON, or null on miss/error/disabled. */
async function getJSON(key) {
  try {
    const client = await readyClient();
    if (!client) return null;
    const raw = await client.get(prefixed(key));
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (error) {
    logOnce("getJSON", error);
    return null;
  }
}

/**
 * @param {string} key
 * @param {any} value JSON-serializable
 * @param {number} [ttlSeconds] omit for a persistent key
 * @returns {Promise<boolean>} false on error/disabled — never throws.
 */
async function setJSON(key, value, ttlSeconds) {
  try {
    const client = await readyClient();
    if (!client) return false;
    const payload = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await client.set(prefixed(key), payload, "EX", Math.ceil(ttlSeconds));
    } else {
      await client.set(prefixed(key), payload);
    }
    return true;
  } catch (error) {
    logOnce("setJSON", error);
    return false;
  }
}

async function getManyJSON(keys) {
  if (!Array.isArray(keys)) return { ok: false, disabled: false, values: [] };
  if (keys.length === 0) return { ok: true, disabled: false, values: [] };
  try {
    const client = await readyClient();
    if (!client) return { ok: false, disabled: true, values: [] };
    const raws = await client.mget(...keys.map(prefixed));
    if (!Array.isArray(raws) || raws.length !== keys.length) {
      return { ok: false, disabled: false, values: [] };
    }
    const values = raws.map((raw) => {
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return undefined; }
    });
    if (values.includes(undefined)) return { ok: false, disabled: false, values: [] };
    return { ok: true, disabled: false, values };
  } catch (error) {
    logOnce("getManyJSON", error);
    return { ok: false, disabled: false, values: [] };
  }
}

async function setManyJSON(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, disabled: false, count: 0 };
  }
  try {
    const client = await readyClient();
    if (!client) return { ok: false, disabled: true, count: 0 };
    const pipeline = client.pipeline();
    for (const { key, value, ttlSeconds, ttlMs } of entries) {
      const payload = JSON.stringify(value);
      if (ttlMs > 0) pipeline.set(prefixed(key), payload, "PX", Math.ceil(ttlMs));
      else if (ttlSeconds > 0) pipeline.set(prefixed(key), payload, "EX", Math.ceil(ttlSeconds));
      else pipeline.set(prefixed(key), payload);
    }
    const replies = await pipeline.exec();
    if (!Array.isArray(replies) || replies.length !== entries.length || replies.some(([err]) => err)) {
      return { ok: false, disabled: false, count: 0 };
    }
    return { ok: true, disabled: false, count: replies.length };
  } catch (error) {
    logOnce("setManyJSON", error);
    return { ok: false, disabled: false, count: 0 };
  }
}

/**
 * @param {string|string[]} keys
 * @returns {Promise<boolean>} true when the DEL command succeeded (even if it
 *   deleted nothing — the post-condition "key is absent" holds either way).
 *   false on error/disabled, which is the signal callers use to open their
 *   read-bypass breaker (§3 "Failed invalidation").
 */
async function del(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (list.length === 0) return false;
  try {
    const client = await readyClient();
    if (!client) return false;
    await client.del(...list.map(prefixed));
    return true;
  } catch (error) {
    logOnce("del", error);
    return false;
  }
}

/**
 * Run `fn` under a self-expiring Redis lock. The loser NEVER waits and NEVER
 * runs `fn` — it gets `null` immediately and is expected to serve a stale
 * snapshot or a cheap Postgres read (spec §5 Phase D step 7; this is the
 * anti-recurrence guard for the 2026-07-18 advisory-lock pool drain, where
 * waiters pinned pooled PG connections).
 *
 * Redis disabled or erroring counts as "not acquired" (null) — so with Redis
 * down every caller takes the cheap fallback and the expensive path never runs.
 *
 * @returns {Promise<{status:"acquired"|"contended"|"disabled"|"error", value:any}>}
 *   Detailed status lets latency-sensitive callers poll only genuine healthy
 *   lock contention, while disabled/error Redis falls through immediately.
 */
async function withLockStatus(key, ttlMs, fn) {
  let client;
  let token;
  try {
    client = await readyClient();
    if (!client) return { status: "disabled", value: null };
    token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await client.set(
      prefixed(key),
      token,
      "PX",
      Math.max(1, Math.ceil(ttlMs)),
      "NX"
    );
    if (acquired !== "OK") return { status: "contended", value: null };
  } catch (error) {
    logOnce("withLock-acquire", error);
    return { status: "error", value: null };
  }

  try {
    return { status: "acquired", value: await fn() };
  } finally {
    try {
      await client.eval(RELEASE_LOCK_LUA, 1, prefixed(key), token);
    } catch (error) {
      logOnce("withLock-release", error);
    }
  }
}

/** Backward-compatible lock helper for existing callers. */
async function withLock(key, ttlMs, fn) {
  const result = await withLockStatus(key, ttlMs, fn);
  return result.status === "acquired" ? result.value : null;
}

/**
 * Broadcast a cache invalidation to peer workers.
 * @param {string|{key?: string, prefix?: string}} target
 * @returns {Promise<boolean>}
 */
async function publishInvalidate(target) {
  const payload =
    typeof target === "string" ? { key: target } : { ...(target || {}) };
  if (!payload.key && !payload.prefix) return false;
  try {
    const client = await readyClient();
    if (!client) return false;
    const message = { at: Date.now() };
    if (payload.key) message.key = prefixed(payload.key);
    if (payload.prefix) message.prefix = prefixed(payload.prefix);
    await client.publish(channelName(), JSON.stringify(message));
    return true;
  } catch (error) {
    logOnce("publishInvalidate", error);
    return false;
  }
}

function getSubscriber() {
  const s = ensureState();
  if (!s.config.enabled) return null;
  if (!s.subscriber) {
    s.subscriber = buildClient("subscriber");
    s.subscriberHandlers = new Set();
    s.reconnectHandlers = new Set();
    s.subscriberReady = attachReadyGate(s.subscriber);

    s.subscriber.on("message", (channel, raw) => {
      if (channel !== channelName()) return;
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        logOnce("subscribe-parse", error);
        return;
      }
      const prefix = keyPrefix();
      // Env guard: pub/sub is not isolated by logical DB, so a staging worker
      // could otherwise act on a prod key (and vice versa).
      const fields = ["key", "prefix"];
      const stripped = {};
      for (const field of fields) {
        const value = message[field];
        if (value == null) continue;
        if (typeof value !== "string" || !value.startsWith(prefix)) return;
        stripped[field] = value.slice(prefix.length);
      }
      if (stripped.key == null && stripped.prefix == null) return;
      for (const handler of s.subscriberHandlers) {
        try {
          handler({ ...stripped, at: message.at });
        } catch (error) {
          logOnce("subscribe-handler", error);
        }
      }
    });

    // Pub/sub is lossy across disconnects (§3): on every (re)connect we
    // re-subscribe and tell listeners to flush their in-process caches.
    s.subscriber.on("ready", () => {
      s.subscriber.subscribe(channelName()).catch((error) => {
        logOnce("subscribe", error);
      });
      for (const onReconnect of s.reconnectHandlers) {
        try {
          onReconnect();
        } catch (error) {
          logOnce("subscribe-onReconnect", error);
        }
      }
    });
  }
  return s.subscriber;
}

/**
 * Listen for invalidation broadcasts. No-op (returns a no-op unsubscribe) when
 * Redis is disabled.
 * @param {(msg: {key?: string, prefix?: string, at?: number}) => void} handler
 *   receives keys with the env prefix already stripped.
 * @param {{onReconnect?: () => void}} [options] `onReconnect` fires on every
 *   subscriber (re)connect — the hook for flushing in-process caches, since
 *   messages published while disconnected are lost.
 * @returns {Promise<() => Promise<void>>} unsubscribe
 */
async function subscribe(handler, options = {}) {
  const s = ensureState();
  if (!s.config.enabled) return async () => {};

  const subscriber = getSubscriber();
  if (typeof handler === "function") s.subscriberHandlers.add(handler);
  const { onReconnect } = options;
  if (typeof onReconnect === "function") s.reconnectHandlers.add(onReconnect);

  try {
    await s.subscriberReady;
    await subscriber.subscribe(channelName());
  } catch (error) {
    logOnce("subscribe", error);
  }

  return async () => {
    if (typeof handler === "function") s.subscriberHandlers.delete(handler);
    if (typeof onReconnect === "function") s.reconnectHandlers.delete(onReconnect);
  };
}

/**
 * Run a Lua script server-side (atomic). Added for Phase C: the chat
 * invalidation must do `SET msgver <durableId>` + `DEL list` as ONE step — a
 * non-atomic pair can half-apply and let a concurrent cold rebuild reinstall a
 * stale list (§3 key table).
 *
 * KEYS are env-prefixed for you; ARGV are passed through verbatim.
 *
 * @param {string} script
 * @param {string[]} keys logical (unprefixed) keys
 * @param {(string|number)[]} [args]
 * @returns {Promise<{ok: boolean, disabled: boolean, result: any}>}
 *   `ok:false, disabled:true`  => Redis is off; there is nothing to invalidate,
 *                                 so callers must NOT open a read-bypass.
 *   `ok:false, disabled:false` => a real Redis failure; callers open the
 *                                 per-prefix bypass breaker (§3).
 *   Never throws.
 */
async function evalLua(script, keys = [], args = []) {
  try {
    const client = await readyClient();
    if (!client) return { ok: false, disabled: true, result: null };
    const result = await client.eval(
      script,
      keys.length,
      ...keys.map(prefixed),
      ...args.map((a) => String(a))
    );
    return { ok: true, disabled: false, result };
  } catch (error) {
    logOnce("evalLua", error);
    return { ok: false, disabled: false, result: null };
  }
}

/**
 * Optimistic-concurrency install on a DEDICATED connection:
 * `WATCH keys` -> `fn(ctx)` -> `MULTI (sets) EXEC`.
 *
 * WATCH is connection-scoped, which is why this checks out its own connection
 * rather than borrowing the shared client (a concurrent command on the shared
 * client would otherwise be covered by — or clobber — the transaction).
 *
 * Why WATCH and not a value-comparison CAS (spec §3 / revision v7): under
 * `allkeys-lru` a key can go nil -> set -> evicted-back-to-nil between the read
 * and the install. A compare-against-nil would wrongly succeed and reinstall a
 * stale value. WATCH invalidates the EXEC on ANY modification or eviction of
 * the key, even when its value returns to the value we read.
 *
 * @param {string[]} watchKeys logical keys to WATCH
 * @param {(ctx: {get: (key: string) => Promise<any|null>}) => Promise<
 *     {sets: {key: string, value: any, ttlSeconds?: number}[]} | null>} fn
 *   Returns the writes to install atomically, or null/empty to cancel (UNWATCH,
 *   no write). `ctx.get` reads through the SAME watched connection and parses
 *   JSON, matching `getJSON`.
 * @returns {Promise<{installed: boolean, aborted: boolean, disabled: boolean,
 *                    cancelled: boolean, value: any}>}
 *   `aborted:true` means a concurrent writer/eviction touched a watched key —
 *   the caller must serve its freshly-computed value WITHOUT installing, and
 *   the next read retries the install. `value` is whatever `fn` resolved to.
 *   Never throws (except an error raised by `fn` itself, which propagates after
 *   the connection is released).
 */
async function withWatch(watchKeys, fn) {
  const idle = { installed: false, aborted: false, disabled: false, cancelled: false, value: null };
  let conn = null;
  try {
    const client = await readyClient();
    if (!client) return { ...idle, disabled: true };
    conn = client.duplicate();
    conn.on("error", (err) => logOnce("withWatch-connection", err));
    // `enableOfflineQueue: false` is inherited from the shared client (it is
    // what keeps callers from blocking on a dead Redis), so a command issued
    // before the duplicate's own handshake completes fails outright with
    // "Stream isn't writeable". Wait for this connection to settle first.
    if (conn.status !== "ready") await attachReadyGate(conn);
    if (conn.status !== "ready") throw new Error("watch connection not ready");
    await conn.watch(...watchKeys.map(prefixed));

    // An error raised by the caller's own critical section is THEIRS and
    // propagates (same rule as `withLock`) — only Redis errors are swallowed.
    // Tagged so the catch below can tell the two apart.
    let commit;
    try {
      commit = await fn({
        async get(key) {
          const raw = await conn.get(prefixed(key));
          if (raw == null) return null;
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        },
      });
    } catch (callerError) {
      if (callerError && typeof callerError === "object") {
        callerError.__fromWatchCallback = true;
      }
      throw callerError;
    }

    const sets = commit && Array.isArray(commit.sets) ? commit.sets : [];
    if (sets.length === 0) {
      await conn.unwatch().catch(() => {});
      return { ...idle, cancelled: true, value: commit };
    }

    const multi = conn.multi();
    for (const { key, value, ttlSeconds, ttlMs } of sets) {
      const payload = JSON.stringify(value);
      if (ttlMs && ttlMs > 0) {
        multi.set(prefixed(key), payload, "PX", Math.ceil(ttlMs));
      } else if (ttlSeconds && ttlSeconds > 0) {
        multi.set(prefixed(key), payload, "EX", Math.ceil(ttlSeconds));
      } else {
        multi.set(prefixed(key), payload);
      }
    }
    // ioredis resolves EXEC to null when a WATCHed key changed.
    const replies = await multi.exec();
    if (replies === null) return { ...idle, aborted: true, value: commit };
    return { ...idle, installed: true, value: commit };
  } catch (error) {
    if (error && error.__fromWatchCallback) throw error;
    logOnce("withWatch", error);
    return { ...idle };
  } finally {
    if (conn) {
      try {
        conn.removeAllListeners();
        conn.on("error", () => {});
        await conn.quit();
      } catch {
        try {
          conn.disconnect();
        } catch {}
      }
    }
  }
}

/**
 * @returns {Promise<"ok"|"down"|"disabled">} for the additive `/health` field.
 */
async function healthStatus() {
  if (!isEnabled()) return "disabled";
  try {
    const client = await readyClient();
    if (!client) return "disabled";
    const pong = await client.ping();
    return pong === "PONG" ? "ok" : "down";
  } catch (error) {
    logOnce("ping", error);
    return "down";
  }
}

/** Diagnostics for tests/ops: proves inertness (no client constructed). */
function diagnostics() {
  const s = ensureState();
  return {
    enabled: s.config.enabled,
    keyPrefix: s.config.keyPrefix,
    channel: channelName(),
    clientCreated: Boolean(s.client),
    subscriberCreated: Boolean(s.subscriber),
  };
}

/**
 * Disconnect and forget cached config. Used by graceful shutdown and by tests
 * that change `REDIS_URL` between cases (config is read lazily, once).
 */
async function close() {
  const s = state;
  state = null;
  errorLogTimestamps.clear();
  if (!s) return;
  for (const client of [s.client, s.subscriber]) {
    if (!client) continue;
    try {
      client.removeAllListeners();
      client.on("error", () => {});
      await client.quit();
    } catch {
      try {
        client.disconnect();
      } catch {}
    }
  }
}

module.exports = {
  isEnabled,
  getJSON,
  getManyJSON,
  setJSON,
  setManyJSON,
  del,
  withLock,
  withLockStatus,
  evalLua,
  withWatch,
  publishInvalidate,
  subscribe,
  healthStatus,
  diagnostics,
  close,
};
