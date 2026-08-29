const SNAPSHOT_SCHEMA = "database-pool-telemetry-snapshot-v1";
const STEP_MINUTE_SCHEMA = "step-ingestion-minute-v1";
const STEP_HOUR_SCHEMA = "step-ingestion-hour-v1";
const STEP_HISTORY_START_SCHEMA = "step-ingestion-history-start-v1";
const STEP_ENDPOINTS = ["steps", "samples", "sync-v2"];
const SNAPSHOT_SERIALIZED_CAP_BYTES = 512 * 1024;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const SNAPSHOT_WRITE_LUA = `
local incomingRaw = ARGV[1]
local ttl = tonumber(ARGV[2])
local incomingOk, incoming = pcall(cjson.decode, incomingRaw)
if not incomingOk or type(incoming) ~= "table" or
   type(incoming.bootStartedAtMs) ~= "number" or
   type(incoming.capturedAtMs) ~= "number" then
  return "invalid"
end
local existingRaw = redis.call("GET", KEYS[1])
if existingRaw then
  local existingOk, existing = pcall(cjson.decode, existingRaw)
  if existingOk and type(existing) == "table" and
     type(existing.bootStartedAtMs) == "number" and
     type(existing.capturedAtMs) == "number" then
    if existing.bootStartedAtMs > incoming.bootStartedAtMs or
       (existing.bootStartedAtMs == incoming.bootStartedAtMs and
        existing.capturedAtMs >= incoming.capturedAtMs) then
      return "older"
    end
  end
end
redis.call("SETEX", KEYS[1], ttl, incomingRaw)
return "accepted"
`;

const STEP_HISTORY_WRITE_LUA = `
local expectedSchema = ARGV[1]
local emissionField = ARGV[2]
local counterField = ARGV[3]
local overflowField = ARGV[4]
local payload = ARGV[5]
local startPayload = ARGV[6]
local ttl = tonumber(ARGV[7])
local schema = redis.call("HGET", KEYS[1], "schema")
if schema and schema ~= expectedSchema then return "schema_error" end
if redis.call("HEXISTS", KEYS[1], emissionField) == 1 then return "duplicate" end
local count = tonumber(redis.call("HGET", KEYS[1], counterField) or "0")
if count >= 2 then
  redis.call("HSET", KEYS[1], overflowField, "1")
  redis.call("EXPIRE", KEYS[1], ttl)
  return "overflow"
end
redis.call("HSET", KEYS[1], "schema", expectedSchema)
redis.call("HSET", KEYS[1], emissionField, payload)
redis.call("HINCRBY", KEYS[1], counterField, 1)
redis.call("SET", KEYS[2], startPayload, "EX", ttl, "NX")
redis.call("EXPIRE", KEYS[1], ttl)
redis.call("EXPIRE", KEYS[2], ttl)
return "accepted"
`;

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_SAFE_INTEGER) {
    throw new TypeError(`${label} must be a safe nonnegative integer`);
  }
  return number;
}

function normalizeEndpointCounts(value, endpoint) {
  let counts;
  if (Array.isArray(value)) {
    counts = value.map((item, index) => safeInteger(item, `${endpoint}[${index}]`));
  } else {
    const input = value || {};
    counts = [
      input.requests,
      input.successes,
      input.validation4xx,
      input.auth4xx,
      input.poolCheckoutTimeouts,
      input.transactionErrors,
      input.server5xx,
    ].map((item, index) => safeInteger(item, `${endpoint}[${index}]`));
  }
  if (counts.length !== 7) throw new TypeError(`${endpoint} must have seven counters`);
  if (counts.slice(1).reduce((sum, value) => sum + value, 0) !== counts[0]) {
    throw new TypeError(`${endpoint} outcome counts must equal requests`);
  }
  return counts;
}

function buildStepMinuteEmission(input) {
  if (!input || typeof input !== "object") throw new TypeError("step minute emission is required");
  const minuteStartedAtMs = safeInteger(input.minuteStartedAtMs, "minuteStartedAtMs");
  if (minuteStartedAtMs % 60_000 !== 0) throw new TypeError("minuteStartedAtMs must be UTC minute aligned");
  if (input.role !== "http" || !["0", "1"].includes(String(input.instance))) {
    throw new TypeError("invalid HTTP telemetry identity");
  }
  if (typeof input.bootId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.bootId)) {
    throw new TypeError("invalid bootId");
  }
  const source = input.endpoints || {};
  const endpoints = {};
  for (const endpoint of STEP_ENDPOINTS) {
    endpoints[endpoint] = normalizeEndpointCounts(source[endpoint], endpoint);
  }
  return {
    schema: STEP_MINUTE_SCHEMA,
    minuteStartedAtMs,
    role: "http",
    instance: String(input.instance),
    bootId: input.bootId,
    endpoints,
  };
}

function historyFieldNames(emission) {
  const prefix = `${emission.minuteStartedAtMs}:http:${emission.instance}`;
  return {
    emissionField: `m:${prefix}:${emission.bootId}`,
    counterField: `c:${prefix}`,
    overflowField: `o:${prefix}`,
  };
}

module.exports = {
  SNAPSHOT_SCHEMA,
  STEP_MINUTE_SCHEMA,
  STEP_HOUR_SCHEMA,
  STEP_HISTORY_START_SCHEMA,
  STEP_ENDPOINTS,
  SNAPSHOT_SERIALIZED_CAP_BYTES,
  SNAPSHOT_WRITE_LUA,
  STEP_HISTORY_WRITE_LUA,
  buildStepMinuteEmission,
  historyFieldNames,
};
