const defaultPresentationCache = require("../../social/services/userPresentationCache");

const DEFAULT_BULK_THRESHOLD = 1000;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 4;

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function buildRacePresentationBulkRead({
  presentationCache = defaultPresentationCache,
  bulkThreshold = DEFAULT_BULK_THRESHOLD,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();

  async function getMany(raceId, userIds, enabled) {
    // Roster reads can arrive in placement order while a concurrent response
    // observes a slightly different placement order. Presentation hydration is
    // keyed by user id, so canonicalize the set before comparing cache entries;
    // otherwise identical 10k-person rosters stampede the database.
    const ids = [...new Set((userIds || []).filter(Boolean))].sort();
    if (ids.length < bulkThreshold || !raceId) {
      return presentationCache.getMany(ids, enabled);
    }
    const current = entries.get(raceId);
    const currentTime = now();
    if (current && current.expiresAt > currentTime && sameIds(current.ids, ids)) {
      return current.promise;
    }
    const promise = Promise.resolve().then(() => presentationCache.loadMany(ids));
    const entry = { ids, expiresAt: currentTime + ttlMs, promise };
    entries.delete(raceId);
    entries.set(raceId, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    promise.catch(() => {
      if (entries.get(raceId) === entry) entries.delete(raceId);
    });
    return promise;
  }

  return { getMany };
}

const racePresentationBulkRead = buildRacePresentationBulkRead();

module.exports = {
  DEFAULT_BULK_THRESHOLD,
  DEFAULT_TTL_MS,
  buildRacePresentationBulkRead,
  racePresentationBulkRead,
};
