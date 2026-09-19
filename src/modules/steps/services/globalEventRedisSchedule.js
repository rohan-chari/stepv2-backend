const {
  withCommandClient,
  streamName,
  STREAMS,
} = require("../../../shared/queues/redisStreams");

const SCHEDULE_KEY_SUFFIX = "schedule:global-event-boundaries:v1";

function scheduleKey() {
  return `${process.env.CACHE_ENV_PREFIX || ""}${SCHEDULE_KEY_SUFFIX}`;
}

function boundaryMember(boundaryType, entitlement) {
  if (!["START", "END"].includes(boundaryType)) {
    throw new TypeError("boundaryType must be START or END");
  }
  if (!entitlement?.id) throw new TypeError("entitlement id is required");
  return `${boundaryType}:${entitlement.id}:${Number(entitlement.scheduleRevision || 0)}`;
}

async function scheduleEntitlement(entitlement) {
  if (!entitlement?.startsAt || !entitlement?.endsAt) {
    throw new TypeError("entitlement boundaries are required");
  }
  const start = new Date(entitlement.startsAt).getTime();
  const end = new Date(entitlement.endsAt).getTime();
  return withCommandClient((redis) => redis.zadd(
    scheduleKey(),
    start, boundaryMember("START", entitlement),
    end, boundaryMember("END", entitlement),
  ));
}

async function scheduleEntitlements(entitlements, { start = true, end = true } = {}) {
  const rows = (entitlements || []).filter(Boolean);
  if (!rows.length) return 0;
  return withCommandClient(async (redis) => {
    const args = [];
    for (const entitlement of rows) {
      if (start) args.push(new Date(entitlement.startsAt).getTime(), boundaryMember("START", entitlement));
      if (end) args.push(new Date(entitlement.endsAt).getTime(), boundaryMember("END", entitlement));
    }
    return args.length ? redis.zadd(scheduleKey(), ...args) : 0;
  });
}

function parseBoundaryMember(member) {
  const [boundaryType, entitlementId, revision] = String(member || "").split(":");
  if (!["START", "END"].includes(boundaryType) || !entitlementId) return null;
  const scheduleRevision = Number(revision || 0);
  if (!Number.isInteger(scheduleRevision) || scheduleRevision < 0) return null;
  return { boundaryType, entitlementId, scheduleRevision };
}

async function nextBoundaryAt() {
  return withCommandClient(async (redis) => {
    const row = await redis.zrange(scheduleKey(), 0, 0, "WITHSCORES");
    if (!row.length) return null;
    return new Date(Number(row[1]));
  });
}

async function publishDueBoundaries({ now = new Date(), limit = 100 } = {}) {
  const current = new Date(now);
  const max = Math.min(500, Math.max(1, Number(limit) || 100));
  const scheduledAt = current.toISOString();

  const result = await withCommandClient(async (redis) => {
    // The sorted-set removal and stream append must be one Redis-side atomic
    // operation. For each valid member, XADD runs before ZREM. If XADD fails
    // (for example WRONGTYPE or an infrastructure error), Redis aborts the
    // script at that command and that member remains scheduled for retry.
    //
    // Malformed members preserve the old behavior: they are removed so one bad
    // value cannot poison every scheduler tick forever.
    const script = `
local rows = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
local published = 0

for _, member in ipairs(rows) do
  local boundaryType, entitlementId, revision = string.match(member, "^([^:]+):([^:]+):(%d+)$")

  if (boundaryType == "START" or boundaryType == "END") and entitlementId and revision then
    redis.call(
      "XADD",
      KEYS[2],
      "*",
      "schemaVersion", "1",
      "boundaryType", boundaryType,
      "entitlementId", entitlementId,
      "scheduleRevision", revision,
      "scheduledAt", ARGV[3],
      "enqueuedAt", ARGV[3]
    )
    redis.call("ZREM", KEYS[1], member)
    published = published + 1
  else
    redis.call("ZREM", KEYS[1], member)
  end
end

return {published, #rows}
`;

    return redis.eval(
      script,
      2,
      scheduleKey(),
      streamName(STREAMS.GLOBAL_EVENT_BOUNDARY),
      String(current.getTime()),
      String(max),
      scheduledAt,
    );
  });

  return {
    published: Number(result?.[0] || 0),
    examined: Number(result?.[1] || 0),
  };
}

module.exports = {
  SCHEDULE_KEY_SUFFIX,
  scheduleKey,
  boundaryMember,
  parseBoundaryMember,
  scheduleEntitlement,
  scheduleEntitlements,
  nextBoundaryAt,
  publishDueBoundaries,
};
