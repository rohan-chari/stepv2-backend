// Release B read protocol. A payload is usable only with every live marker;
// missing markers are established with random tokens, preventing eviction ABA.
const { randomUUID } = require("node:crypto");
const redis = require("./redisCache");
const derived = require("./derivedCache");
const { PREFIX, markerKey, MARKER_TTL_SECONDS } = require("./cacheEfficiencyInvalidation");
const metrics = require("../observability/cacheEfficiencyMetrics");
const MAX_BYTES = 512 * 1024;
const ENSURE_LUA = `
local tokens = {}
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[i + 1], 'EX', ARGV[1], 'NX')
  tokens[i] = redis.call('GET', KEYS[i])
end
return tokens
`;
const READ_LUA = `
local result = {redis.call('GET', KEYS[1]) or false, redis.call('PTTL', KEYS[1])}
local markerCount = tonumber(ARGV[1])
for i = 2, markerCount + 1 do result[i + 1] = redis.call('GET', KEYS[i]) or false end
if #KEYS > markerCount + 1 then result[markerCount + 3] = redis.call('EXISTS', KEYS[#KEYS]) end
return result
`;
const INSTALL_LUA = `
local markerCount = tonumber(ARGV[3])
for i = 2, markerCount + 1 do
  if redis.call('GET', KEYS[i]) ~= ARGV[i + 4] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
if #KEYS > markerCount + 1 and ARGV[4] ~= '' then
  redis.call('SET', KEYS[#KEYS], ARGV[4], 'PX', ARGV[5])
end
return 1
`;
const TOKEN = /^[a-f0-9-]{36}$/;
async function capture(markers) {
  const keys = markers.map(({ domain, identity }) => markerKey(domain, identity));
  const response = await redis.evalLua(ENSURE_LUA, keys, [MARKER_TTL_SECONDS, ...keys.map(() => randomUUID())]);
  if (!response.ok || !Array.isArray(response.result) || response.result.length !== keys.length ||
      response.result.some((token) => typeof token !== "string" || !TOKEN.test(token))) return null;
  return { keys, tokens: response.result };
}
async function unchanged(fence) {
  const result = await redis.evalLua("local r = {}; for i = 1, #KEYS do r[i] = redis.call('GET', KEYS[i]) or false end; return r", fence.keys);
  return result.ok && Array.isArray(result.result) && result.result.length === fence.tokens.length &&
    result.result.every((token, index) => token === fence.tokens[index]);
}
async function readFragment({ kind, key, markers, ttlMs, load, validate, maxBytes = MAX_BYTES, companion = null, initialFence = undefined }) {
  const isValid = (value) => { try { return validate(value) === true; } catch { return false; } };
  const fallback = async (reason) => {
    metrics.read(kind, reason);
    metrics.count(kind, "source_loads");
    const started = Date.now();
    const value = await load();
    const lifetime = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
    return { value, source: "postgres", remainingMs: Math.max(0, Number(lifetime) - (Date.now() - started)) };
  };
  if (!redis.isEnabled()) return fallback("bypass");
  derived.ensureSubscribed();
  if (derived.isBypassed(PREFIX)) return fallback("bypass");
  if (initialFence === undefined) metrics.count(kind, "redis");
  const fence = initialFence === undefined ? await capture(markers) : initialFence;
  if (!fence || !Array.isArray(fence.keys) || !Array.isArray(fence.tokens) ||
      fence.keys.length !== markers.length || fence.tokens.length !== markers.length ||
      fence.keys.some((key, i) => key !== markerKey(markers[i].domain, markers[i].identity)) ||
      fence.tokens.some(token => typeof token !== "string" || !TOKEN.test(token))) return fallback("error");
  metrics.count(kind, "redis");
  const cacheKeys = [key, ...fence.keys, ...(companion ? [companion.key] : [])];
  const response = await redis.evalLua(READ_LUA, cacheKeys, [fence.keys.length]);
  if (!response.ok || !Array.isArray(response.result)) return fallback("error");
  const [raw, pttl] = response.result;
  const tokens = response.result.slice(2, 2 + fence.tokens.length);
  const companionPresent = !companion || response.result[2 + fence.tokens.length] === 1;
  let payload;
  if (typeof raw === "string" && Buffer.byteLength(raw) <= maxBytes) {
    try { payload = JSON.parse(raw); } catch {}
  }
  if (payload?.schema === 1 && Array.isArray(payload.tokens) && payload.tokens.length === fence.tokens.length &&
      Number.isFinite(payload.loadedAt) && Number.isFinite(payload.expiresAt) && pttl > 0 &&
      payload.expiresAt > Date.now() && tokens.length === fence.tokens.length &&
      tokens.every((token, index) => token === fence.tokens[index] && token === payload.tokens[index]) &&
      isValid(payload.value) && (companionPresent || !companion?.required(payload.value))) {
    metrics.count(kind, "redis");
    if (await unchanged(fence) && !derived.isBypassed(PREFIX)) {
      metrics.read(kind, "hit");
      metrics.age(kind, Date.now() - payload.loadedAt);
      return { value: payload.value, source: "redis", remainingMs: Math.min(Number(pttl), payload.expiresAt - Date.now()) };
    }
    return fallback("generation");
  }
  const missReason = payload && Array.isArray(payload.tokens) &&
      (tokens.length !== fence.tokens.length || tokens.some((token, index) => token !== fence.tokens[index] || token !== payload.tokens[index]))
    ? "generation" : payload && (pttl <= 0 || payload.expiresAt <= Date.now()) ? "expired" : raw ? "malformed" : "missing";
  metrics.read(kind, missReason);
  metrics.count(kind, "source_loads");
  const started = Date.now();
  const value = await load(); // A loader error is never stored as an empty result.
  const lifetime = Math.floor(Number(typeof ttlMs === "function" ? ttlMs(value) : ttlMs) - (Date.now() - started));
  if (!isValid(value) || !(lifetime > 0) || lifetime > MARKER_TTL_SECONDS * 500 || derived.isBypassed(PREFIX)) {
    return { value, source: "postgres", remainingMs: Math.max(0, lifetime) };
  }
  const envelope = JSON.stringify({ schema: 1, tokens: fence.tokens, value, loadedAt: started, expiresAt: Date.now() + lifetime });
  if (Buffer.byteLength(envelope) > maxBytes) return { value, source: "postgres", remainingMs: lifetime };
  metrics.count(kind, "redis");
  const companionValue = companion?.value(value);
  const installed = await redis.evalLua(INSTALL_LUA, cacheKeys, [envelope, lifetime, fence.keys.length,
    companionValue ? JSON.stringify(companionValue) : "", Math.max(1, Math.floor(lifetime / 1000) * 1000), ...fence.tokens]);
  if (installed.ok && installed.result === 0) return fallback("generation");
  if (installed.ok) { metrics.read(kind, "installed"); metrics.count(kind, "bytes", Buffer.byteLength(envelope)); }
  else metrics.read(kind, "error");
  return { value, source: "postgres", remainingMs: lifetime };
}
module.exports = { readFragment, capture, unchanged };
