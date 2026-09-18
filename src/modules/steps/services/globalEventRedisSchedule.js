const {
  withCommandClient,
  publish,
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

async function scheduleEntitlements(entitlements) {
  const rows = (entitlements || []).filter(Boolean);
  if (!rows.length) return 0;
  return withCommandClient(async (redis) => {
    const args = [];
    for (const entitlement of rows) {
      args.push(
        new Date(entitlement.startsAt).getTime(),
        boundaryMember("START", entitlement),
        new Date(entitlement.endsAt).getTime(),
        boundaryMember("END", entitlement),
      );
    }
    return redis.zadd(scheduleKey(), ...args);
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
  const members = await withCommandClient(async (redis) => {
    const script = `
local rows = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
if #rows > 0 then
  redis.call("ZREM", KEYS[1], unpack(rows))
end
return rows
`;
    return redis.eval(script, 1, scheduleKey(), String(current.getTime()), String(max));
  });

  let published = 0;
  for (const member of members || []) {
    const parsed = parseBoundaryMember(member);
    if (!parsed) continue;
    await publish(STREAMS.GLOBAL_EVENT_BOUNDARY, {
      schemaVersion: 1,
      boundaryType: parsed.boundaryType,
      entitlementId: parsed.entitlementId,
      scheduleRevision: parsed.scheduleRevision,
      scheduledAt: current.toISOString(),
      enqueuedAt: current.toISOString(),
    });
    published += 1;
  }
  return { published, examined: (members || []).length };
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
