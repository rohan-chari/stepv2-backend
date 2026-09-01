const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// One app open fans out across several authenticated surfaces. Keep the user
// row for that complete bounded graph so pool delay cannot make later sibling
// requests miss and amplify the same overload. User mutations and account
// deletion publish targeted cross-worker invalidations; this TTL is only the
// fail-safe when that signal is unavailable.
const TTL_MS = 60_000;
const MAX_ENTRIES = 25_000;
const COLD_BATCH_SIZE = 256;
const entries = new Map();
const inFlight = new Map();
const generations = new Map();
let globalGeneration = 0;
const coldBatches = new Map();
let coldBatchScheduled = false;

function scheduleColdBatch(userId, loadMany) {
  return new Promise((resolve, reject) => {
    let batch = coldBatches.get(loadMany);
    if (!batch) coldBatches.set(loadMany, (batch = new Map()));
    let waiters = batch.get(userId);
    if (!waiters) batch.set(userId, (waiters = []));
    waiters.push({ resolve, reject });
    if (coldBatchScheduled) return;
    coldBatchScheduled = true;
    setImmediate(async () => {
      coldBatchScheduled = false;
      const batches = [...coldBatches.entries()];
      coldBatches.clear();
      for (const [loader, waiters] of batches) {
        const ids = [...waiters.keys()];
        try {
          for (let offset = 0; offset < ids.length; offset += COLD_BATCH_SIZE) {
            const chunk = ids.slice(offset, offset + COLD_BATCH_SIZE);
            const rows = await loader(chunk);
            const byId = new Map((rows || []).map((row) => [row.id, row]));
            for (const id of chunk) {
              const value = byId.get(id) || null;
              for (const waiter of waiters.get(id)) waiter.resolve(value);
            }
          }
        } catch (error) {
          for (const userWaiters of waiters.values()) {
            for (const waiter of userWaiters) waiter.reject(error);
          }
        }
      }
    });
  });
}

// User-model writes already publish one concrete /auth/me key alongside the
// shared invalidation prefix. Evict only that user: clearing all 25k entries on
// every user's once-daily metadata write turns an East Coast launch wave into
// a cache-disabled database stampede. A subscriber reconnect has no concrete
// key and conservatively clears everything because messages may have been lost.
function handleInvalidation(message) {
  const key = message?.key;
  if (typeof key !== "string") {
    clear();
    return;
  }
  const marker = `${cacheKeys.PREFIX.USER_AUTHME}:`;
  const markerIndex = key.indexOf(marker);
  if (markerIndex < 0) {
    clear();
    return;
  }
  const userId = key.slice(markerIndex + marker.length).split(":")[0];
  if (userId) invalidate(userId);
}

derivedCache.onInvalidate(cacheKeys.PREFIX.USER_AUTHME, handleInvalidation);

async function read(userId, load, loadMany = null) {
  const now = Date.now();
  const cached = entries.get(userId);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) entries.delete(userId);

  if (inFlight.has(userId)) return inFlight.get(userId);
  const generation = generations.get(userId) || 0;
  const readGlobalGeneration = globalGeneration;
  let pending;
  pending = Promise.resolve()
    .then(async () => {
      return typeof loadMany === "function"
        ? scheduleColdBatch(userId, loadMany)
        : load();
    })
    .then((value) => {
      if (value && globalGeneration === readGlobalGeneration &&
          (generations.get(userId) || 0) === generation) {
        if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
        entries.set(userId, { value, expiresAt: Date.now() + TTL_MS });
      }
      return value;
    })
    .finally(() => {
      if (inFlight.get(userId) === pending) inFlight.delete(userId);
    });
  inFlight.set(userId, pending);
  return pending;
}

function clear() {
  globalGeneration += 1;
  entries.clear();
  inFlight.clear();
  generations.clear();
}

function invalidate(userId) {
  if (!userId) return;
  generations.set(userId, (generations.get(userId) || 0) + 1);
  entries.delete(userId);
  inFlight.delete(userId);
}

module.exports = {
  COLD_BATCH_SIZE, MAX_ENTRIES, TTL_MS, clear, handleInvalidation, invalidate, read,
};
