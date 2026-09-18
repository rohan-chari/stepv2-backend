const os = require("node:os");

const STREAMS = Object.freeze({
  STEP_SYNC: "queue:step-sync:v1",
  POWERUP_RECALC: "queue:powerup-recalc:v1",
  RACE_DIRTY: "queue:race-dirty:v1",
  GLOBAL_EVENT_BOUNDARY: "queue:global-event-boundary:v1",
  NOTIFICATION_DELIVERY: "queue:notification-delivery:v1",
});

const GROUPS = Object.freeze({
  STEP_SYNC: "step-workers-v1",
  POWERUP_RECALC: "powerup-workers-v1",
  RACE_DIRTY: "race-workers-v1",
  GLOBAL_EVENT_BOUNDARY: "global-event-boundary-workers-v1",
  NOTIFICATION_DELIVERY: "notification-workers-v1",
});

let commandState = null;
const readerStates = new Map();

function prefix() {
  return process.env.CACHE_ENV_PREFIX || "";
}

function streamName(name) {
  const suffix = STREAMS[name] || name;
  if (!suffix) throw new TypeError("stream name is required");
  return `${prefix()}${suffix}`;
}

function consumerName(role = "worker") {
  const instance = process.env.NODE_APP_INSTANCE == null
    ? "0"
    : String(process.env.NODE_APP_INSTANCE);
  return `${os.hostname()}:${instance}:${process.pid}:${role}`;
}

function createClient(role) {
  const url = String(process.env.QUEUE_REDIS_URL || "").trim();
  if (!url) {
    const error = new Error("QUEUE_REDIS_URL is required for queue-first work");
    error.code = "QUEUE_REDIS_UNAVAILABLE";
    throw error;
  }
  const IORedis = require("ioredis");
  const redis = new IORedis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    lazyConnect: false,
  });
  redis.on("error", (error) => {
    console.error(`[redisStreams] ${role} connection error:`, error?.message || error);
  });
  let settle;
  const ready = new Promise((resolve) => { settle = resolve; });
  const done = () => settle(true);
  redis.once("ready", done);
  redis.once("error", done);
  redis.once("end", done);
  setTimeout(done, 2000).unref?.();
  return { redis, ready };
}

async function commandClient() {
  commandState ||= createClient("command");
  await commandState.ready;
  return commandState.redis;
}

async function readerClient(consumer) {
  if (!readerStates.has(consumer)) {
    readerStates.set(consumer, createClient(`reader:${consumer}`));
  }
  const state = readerStates.get(consumer);
  await state.ready;
  return state.redis;
}

function encodeFields(fields) {
  const args = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    args.push(String(key), value === null ? "" : String(value));
  }
  if (!args.length) throw new TypeError("stream message fields are required");
  return args;
}

function decodeEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [id, raw] = entry;
  const fields = {};
  for (let i = 0; i < raw.length; i += 2) fields[raw[i]] = raw[i + 1];
  return { id, fields };
}

async function withCommandClient(work) {
  if (typeof work !== "function") throw new TypeError("work callback is required");
  const redis = await commandClient();
  return work(redis);
}

async function publish(stream, fields) {
  try {
    const redis = await commandClient();
    return await redis.xadd(streamName(stream), "*", ...encodeFields(fields));
  } catch (error) {
    if (!error.code) error.code = "QUEUE_REDIS_UNAVAILABLE";
    throw error;
  }
}

async function ensureGroup(stream, group) {
  try {
    const redis = await commandClient();
    await redis.xgroup("CREATE", streamName(stream), group, "0", "MKSTREAM");
    return true;
  } catch (error) {
    if (String(error?.message || "").includes("BUSYGROUP")) return true;
    if (!error.code) error.code = "QUEUE_REDIS_UNAVAILABLE";
    throw error;
  }
}

async function readGroup({ stream, group, consumer, count = 10, blockMs = 5000 }) {
  const redis = await readerClient(consumer);
  const result = await redis.xreadgroup(
    "GROUP", group, consumer,
    "COUNT", Math.max(1, Number(count) || 1),
    "BLOCK", Math.max(1, Number(blockMs) || 1),
    "STREAMS", streamName(stream), ">"
  );
  if (!Array.isArray(result) || !result.length) return [];
  return (result[0]?.[1] || []).map(decodeEntry).filter(Boolean);
}

async function ack(stream, group, messageId) {
  const redis = await commandClient();
  return Number(await redis.xack(streamName(stream), group, messageId)) > 0;
}

async function reclaimIdle({
  stream,
  group,
  consumer,
  minIdleMs = 30000,
  count = 25,
}) {
  const redis = await commandClient();
  const result = await redis.xautoclaim(
    streamName(stream),
    group,
    consumer,
    Math.max(1, Number(minIdleMs) || 1),
    "0-0",
    "COUNT",
    Math.max(1, Number(count) || 1),
  );
  const entries = Array.isArray(result) ? result[1] : [];
  return (entries || []).map(decodeEntry).filter(Boolean);
}


async function claimIdempotentWindow(key, token, ttlMs) {
  const redis = await commandClient();
  const physicalKey = `${prefix()}${key}`;
  const lifetime = Math.max(1, Math.ceil(Number(ttlMs) || 1));
  const script = `
local existing = redis.call("GET", KEYS[1])
if not existing then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return {1, ARGV[2]}
end
if existing == ARGV[1] then
  local ttl = redis.call("PTTL", KEYS[1])
  return {1, ttl}
end
return {0, redis.call("PTTL", KEYS[1])}
`;
  const result = await redis.eval(script, 1, physicalKey, String(token), String(lifetime));
  return {
    acquired: Number(result?.[0]) === 1,
    retryAfterMs: Math.max(0, Number(result?.[1]) || 0),
  };
}

function pairsToObject(raw) {
  const out = {};
  if (!Array.isArray(raw)) return out;
  for (let index = 0; index < raw.length; index += 2) {
    out[String(raw[index])] = raw[index + 1];
  }
  return out;
}

function streamIdTimestamp(id) {
  if (typeof id !== "string") return null;
  const milliseconds = Number(id.split("-", 1)[0]);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0
    ? milliseconds
    : null;
}

async function queueHealth(stream, group, { nowMs = Date.now() } = {}) {
  const redis = await commandClient();
  const physicalStream = streamName(stream);
  const [pending, groups] = await Promise.all([
    redis.xpending(physicalStream, group),
    redis.xinfo("GROUPS", physicalStream),
  ]);
  const groupRow = (groups || [])
    .map(pairsToObject)
    .find((row) => row.name === group) || {};
  const pendingCount = Number(pending?.[0] || 0);
  const oldestPendingAtMs = streamIdTimestamp(pending?.[1] || null);
  return {
    pendingCount,
    waitingCount: Math.max(0, Number(groupRow.lag || 0)),
    consumerCount: Math.max(0, Number(groupRow.consumers || 0)),
    oldestPendingAgeMs: oldestPendingAtMs == null
      ? 0
      : Math.max(0, Number(nowMs) - oldestPendingAtMs),
  };
}

function compareStreamIds(left, right) {
  const [leftMs = "0", leftSeq = "0"] = String(left).split("-", 2);
  const [rightMs = "0", rightSeq = "0"] = String(right).split("-", 2);
  const leftTime = BigInt(leftMs);
  const rightTime = BigInt(rightMs);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  const leftSequence = BigInt(leftSeq);
  const rightSequence = BigInt(rightSeq);
  return leftSequence === rightSequence ? 0 : leftSequence < rightSequence ? -1 : 1;
}

async function trimSafeHistory(stream, group, { keepRecent = 1000 } = {}) {
  const redis = await commandClient();
  const physicalStream = streamName(stream);
  const retainCount = Math.max(0, Math.floor(Number(keepRecent) || 0));

  const [pending, groups] = await Promise.all([
    redis.xpending(physicalStream, group),
    redis.xinfo("GROUPS", physicalStream),
  ]);
  const oldestPendingId = pending?.[1] || null;
  const groupRow = (groups || [])
    .map(pairsToObject)
    .find((row) => row.name === group) || {};
  const lastDeliveredId = groupRow["last-delivered-id"] || "0-0";

  // Pending entries are not the only live queue work. Entries newer than the
  // consumer group's last-delivered-id have never been delivered at all and
  // must also form a hard trim boundary.
  const unread = await redis.xrange(
    physicalStream,
    `(${lastDeliveredId}`,
    "+",
    "COUNT",
    1,
  );
  const firstUnreadId = unread?.[0]?.[0] || null;

  let recentCutoffId = null;
  if (retainCount > 0) {
    const recent = await redis.xrevrange(
      physicalStream,
      "+",
      "-",
      "COUNT",
      retainCount,
    );
    recentCutoffId = recent?.at(-1)?.[0] || null;
  }

  const candidates = [
    oldestPendingId,
    firstUnreadId,
    recentCutoffId,
  ].filter(Boolean);
  const cutoffId = candidates.reduce((oldest, candidate) => (
    oldest == null || compareStreamIds(candidate, oldest) < 0
      ? candidate
      : oldest
  ), null);

  if (cutoffId) {
    const trimmed = await redis.xtrim(physicalStream, "MINID", cutoffId);
    return {
      trimmed: Number(trimmed || 0),
      cutoffId,
      oldestPendingId,
      firstUnreadId,
    };
  }

  if (retainCount === 0) {
    const trimmed = await redis.xtrim(physicalStream, "MAXLEN", 0);
    return {
      trimmed: Number(trimmed || 0),
      cutoffId: null,
      oldestPendingId: null,
      firstUnreadId: null,
    };
  }

  return {
    trimmed: 0,
    cutoffId: null,
    oldestPendingId: null,
    firstUnreadId: null,
  };
}

async function pendingSummary(stream, group) {
  const redis = await commandClient();
  const result = await redis.xpending(streamName(stream), group);
  return {
    count: Number(result?.[0] || 0),
    minId: result?.[1] || null,
    maxId: result?.[2] || null,
  };
}

async function close() {
  const states = [
    ...(commandState ? [commandState] : []),
    ...readerStates.values(),
  ];
  commandState = null;
  readerStates.clear();
  await Promise.all(states.map(async ({ redis }) => {
    await redis.quit().catch(() => redis.disconnect());
  }));
}

module.exports = {
  STREAMS,
  GROUPS,
  streamName,
  consumerName,
  publish,
  withCommandClient,
  ensureGroup,
  readGroup,
  ack,
  reclaimIdle,
  claimIdempotentWindow,
  pendingSummary,
  queueHealth,
  trimSafeHistory,
  close,
};
