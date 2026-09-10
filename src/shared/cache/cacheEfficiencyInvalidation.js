// Release A writer protocol. PostgreSQL owns all state; these opaque markers
// fence reconstructible release B fragments, including fills already in flight.
const { randomUUID } = require("node:crypto");
const redis = require("./redisCache");
const derived = require("./derivedCache");
const metrics = require("../observability/cacheEfficiencyMetrics");
const PREFIX = "ce:v1:";
const BATCH_SIZE = 256;
// At least twice every release B payload lifetime, including positive summaries.
const MARKER_TTL_SECONDS = 172800;
const DOMAINS = new Set([
  "list", "race-meta", "race-members", "race-effects", "invites", "summary", "milestones",
  "slots", "entitlement", "event", "presentation",
]);
const ADVANCE_LUA = `
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[i + 1], 'EX', ARGV[1])
end
return #KEYS
`;
function markerKey(domain, identity) {
  if (!DOMAINS.has(domain) || typeof identity !== "string" || !identity || identity.length > 512) {
    throw new TypeError("Invalid cache efficiency marker identity");
  }
  return `${PREFIX}g:${domain}:${identity}`;
}
const pending = new Map();
let drainTail = Promise.resolve();
function drain() {
  const work = drainTail.then(async () => {
    while (pending.size) {
      const batch = [...pending.entries()].slice(0, BATCH_SIZE);
      metrics.count("writer", "redis");
      const result = await redis.evalLua(ADVANCE_LUA, batch.map(([key]) => key), [
        MARKER_TTL_SECONDS, ...batch.map(() => randomUUID()),
      ]);
      if (!result.ok) { metrics.read("writer", "error"); return result; }
      metrics.count("writer", "invalidations", batch.length);
      for (const [key, revision] of batch) {
        if (pending.get(key) === revision) pending.delete(key);
      }
    }
    return { ok: true, disabled: false };
  });
  drainTail = work.catch(() => {});
  return work;
}
async function advance(entries) {
  if (!redis.isEnabled()) return true;
  for (const { domain, identity } of entries) pending.set(markerKey(domain, identity), randomUUID());
  // All calls sharing the bypass also share its retry work. A later successful
  // mutation cannot close the breaker while an earlier failed batch is pending.
  return derived.invalidate({ prefix: PREFIX, run: drain });
}
async function afterCommit(entries) {
  if (!entries.length || !redis.isEnabled()) return;
  const { deferUntilAfterCommitBatch } = require("../../db");
  return deferUntilAfterCommitBatch("cache-efficiency", entries, advance);
}
module.exports = { PREFIX, BATCH_SIZE, MARKER_TTL_SECONDS, markerKey, advance, afterCommit };
