// C2 (spec §5 Phase C, §3 key table `msgs`/`msgver`): the cached raw message
// lists for `GET /races/:id/messages` and the version protocol that keeps them
// honest.
//
// ── What is cached ─────────────────────────────────────────────────────────
// ONLY the raw rows, and ONLY for the default query shape (no cursor,
// limit === 50, kind explicitly USER or SYSTEM). Everything viewer-specific —
// the participant/spectator auth check, the stealth redaction of SYSTEM
// descriptions, and the sender presentation — is computed per request. Two
// viewers of the same race share the row cache and still get their own view.
//
// ── The version marker (`msgver`) ──────────────────────────────────────────
// `msgver` holds the newest DURABLE message identity, never a Redis counter: an
// `INCR` counter is ABA-prone under `allkeys-lru` (eviction resets it to 0 and
// a stale rebuild reinstalls).
//
// MONOTONICITY FINDING — this is why the encoding below is not just the row id:
// `RaceMessage.id` and `RacePowerupEvent.id` are `String @id @default(uuid())`,
// i.e. RANDOM UUIDv4. They are NOT monotonically comparable, so the spec's
// "use the PG row id" cannot be taken literally here. The spec's own fallback
// applies: the marker is the sortable pair `(createdAt epoch ms, id)`, encoded
// as a zero-padded 15-digit millisecond timestamp, a colon, then the id. That
// is lexicographically ordered by time, with the id as a deterministic (if
// arbitrary) tiebreak for same-millisecond rows — which matches how the feed's
// own cursor already breaks ties.
//
// ── The protocol ───────────────────────────────────────────────────────────
//  * Post/delete/membership change (AFTER the Postgres commit): ONE Lua script
//    does `SET msgver <marker>` + `DEL list` atomically. A non-atomic pair could
//    half-apply and let an in-flight rebuild reinstall a list that predates the
//    new message.
//  * Cold rebuild: `WATCH msgver` on a DEDICATED connection (WATCH is
//    connection-scoped) -> read Postgres -> `MULTI (SET list, SET msgver) EXEC`.
//    An aborted EXEC means someone touched msgver while we were querying: we
//    serve our freshly-read Postgres rows to THIS request and install nothing;
//    the next read retries. WATCH is required over a value-comparison CAS
//    because nil -> set -> evicted-back-to-nil would wrongly pass a compare
//    (spec revision v7 / test 5g case b).
const { prisma } = require("../../../db");
const redisCache = require("../../../shared/cache/redisCache");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// 15 minutes (spec §3): the hard backstop for the accepted degradation where
// BOTH a post's invalidation and the failure-coordination broadcast fail.
const TTL_SECONDS = 15 * 60;

// Rows kept per list. The endpoint's default page is 50; caching 100 leaves the
// `merged.length > pageLimit` next-cursor test behaving exactly as it does
// against the live `take: 51` query (both are "more than a page exists").
const CACHE_ROW_CAP = 100;
const WATERMARK_ROW_CAP = 50;

// Atomic invalidation. KEYS[1]=msgver, KEYS[2]=list. Deleting the list and
// advancing the version must be indivisible.
const INVALIDATE_LUA = `
redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
for i = 2, #KEYS do
  redis.call("del", KEYS[i])
end
return 1
`;

// Test-only interleaving seam for spec §8 test 5g, which has to commit a write
// inside the WATCH window. The assertions still run through the real HTTP
// endpoint; this only makes the race deterministic instead of timing-dependent.
let testHooks = {};
function __setTestHooks(hooks) {
  testHooks = hooks || {};
}

/** Sortable `(createdAt, id)` marker — see the monotonicity note above. */
function encodeMarker(row) {
  if (!row) return "0".repeat(15) + ":";
  const ms = new Date(row.createdAt).getTime();
  const safe = Number.isFinite(ms) ? ms : 0;
  return `${String(safe).padStart(15, "0")}:${row.id}`;
}

/** True only for the one query shape the spec allows caching. */
function isCacheableShape({ cursor, limit, kind }) {
  return (
    !cursor &&
    Number(limit) === 50 &&
    (kind === "USER" || kind === "SYSTEM")
  );
}

const WELCOME_MYSTERY_BOX_DESCRIPTIONS = [
  "Welcome gift. A mystery box!",
  "Welcome gift — a mystery box!",
];

async function loadRows(raceId, kind, hiddenSystemEventTypes) {
  if (kind === "USER") {
    return prisma.raceMessage.findMany({
      where: { raceId, deletedAt: null },
      // Sender is NOT included: presentation hydrates at read time from
      // `v1:user:cosmetics:{id}` so a rename/equip never rewrites this list.
      select: { id: true, senderId: true, body: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CACHE_ROW_CAP,
    });
  }
  return prisma.racePowerupEvent.findMany({
    where: {
      raceId,
      ...(hiddenSystemEventTypes && hiddenSystemEventTypes.length > 0
        ? { eventType: { notIn: hiddenSystemEventTypes } }
        : {}),
      NOT: [
        {
          eventType: "POWERUP_EARNED",
          powerupType: "MYSTERY_BOX",
          description: { in: WELCOME_MYSTERY_BOX_DESCRIPTIONS },
        },
        {
          eventType: "POWERUP_USED",
          powerupType: "TRAIL_MINE",
          description: { contains: " planted a " },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CACHE_ROW_CAP,
  });
}

async function loadWatermarkRows(raceId) {
  return prisma.raceMessage.findMany({
    where: { raceId, kind: "USER", deletedAt: null },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: WATERMARK_ROW_CAP,
  });
}

function projectWatermark(rows) {
  return {
    latestId: rows[0]?.id ?? null,
    latestAt: rows[0]?.createdAt ?? null,
    recentIds: rows.map((row) => row.id),
  };
}

async function getWatermark({ raceId, enabled }) {
  const dataKey = cacheKeys.raceMessageWatermark(raceId);
  const versionKey = cacheKeys.raceMessagesVersion(raceId, "USER");
  const load = () => loadWatermarkRows(raceId);
  if (!enabled || !redisCache.isEnabled()) return projectWatermark(await load());
  derivedCache.ensureSubscribed();
  if (derivedCache.isBypassed(cacheKeys.PREFIX.RACE_MESSAGES)) {
    return projectWatermark(await load());
  }
  const cached = await redisCache.getJSON(dataKey);
  if (
    cached &&
    Array.isArray(cached.rows) &&
    cached.rows.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        row.createdAt != null &&
        Object.keys(row).every((key) => key === "id" || key === "createdAt")
    )
  ) {
    return projectWatermark(cached.rows);
  }
  let queried = null;
  await redisCache.withWatch([versionKey], async (ctx) => {
    const observed = await ctx.get(versionKey);
    queried = await load();
    const newestMarker = queried.length > 0 ? encodeMarker(queried[0]) : null;
    const marker =
      observed && newestMarker
        ? observed > newestMarker
          ? observed
          : newestMarker
        : newestMarker || observed || encodeMarker(null);
    return {
      sets: [
        { key: dataKey, value: { rows: queried }, ttlSeconds: TTL_SECONDS },
        { key: versionKey, value: marker, ttlSeconds: TTL_SECONDS },
      ],
    };
  });
  if (queried === null) queried = await load();
  return projectWatermark(queried);
}

/**
 * Cached raw rows for one (race, kind). Returns rows in the same order and
 * shape the live query would produce.
 *
 * @returns {Promise<{rows: any[], fromCache: boolean}>}
 */
async function getRows({ raceId, kind, enabled, hiddenSystemEventTypes }) {
  const listKey = cacheKeys.raceMessages(raceId, kind);
  const versionKey = cacheKeys.raceMessagesVersion(raceId, kind);
  const dataKeys = [listKey];
  if (kind === "USER") dataKeys.push(cacheKeys.raceMessageWatermark(raceId));
  const load = () => loadRows(raceId, kind, hiddenSystemEventTypes);

  if (!enabled || !redisCache.isEnabled()) {
    return { rows: await load(), fromCache: false };
  }
  derivedCache.ensureSubscribed();
  // A failed invalidation elsewhere in this process means a KNOWN-STALE list may
  // still be sitting in Redis; serve Postgres until the retry lands (§3).
  if (derivedCache.isBypassed(cacheKeys.PREFIX.RACE_MESSAGES)) {
    return { rows: await load(), fromCache: false };
  }

  const cached = await redisCache.getJSON(listKey);
  if (cached && Array.isArray(cached.rows)) {
    const containsNewlyHiddenPlant =
      kind === "SYSTEM" &&
      cached.rows.some(
        (row) =>
          row?.metadata?.hiddenFromFeed === true ||
          (row?.eventType === "POWERUP_USED" &&
            row?.powerupType === "TRAIL_MINE" &&
            row?.metadata?.ownerParticipantId != null)
      );
    if (!containsNewlyHiddenPlant) {
      return { rows: cached.rows, fromCache: true };
    }
  }

  // Cold rebuild under WATCH.
  let queried = null;
  const result = await redisCache.withWatch([versionKey], async (ctx) => {
    // Read the version we are rebuilding against. Its VALUE is not what
    // protects us (WATCH is) — it is carried forward so a rebuild never moves
    // the marker backwards relative to a concurrent post.
    const observed = await ctx.get(versionKey);
    queried = await load();

    if (typeof testHooks.beforeInstall === "function") {
      await testHooks.beforeInstall();
    }

    const newestMarker = queried.length > 0 ? encodeMarker(queried[0]) : null;
    const marker =
      observed && newestMarker
        ? observed > newestMarker
          ? observed
          : newestMarker
        : newestMarker || observed || encodeMarker(null);

    return {
      sets: [
        { key: listKey, value: { rows: queried }, ttlSeconds: TTL_SECONDS },
        { key: versionKey, value: marker, ttlSeconds: TTL_SECONDS },
      ],
    };
  });

  if (typeof testHooks.onInstallResult === "function") {
    testHooks.onInstallResult({
      installed: result.installed,
      aborted: result.aborted,
    });
  }

  // Aborted (or errored, or Redis vanished): serve what we read from Postgres
  // this request and install nothing. The next read retries the install.
  if (queried === null) queried = await load();
  return { rows: queried, fromCache: false };
}

/**
 * The single invalidation seam: `SET msgver <marker>` + `DEL list`, atomically,
 * for one kind. Runs AFTER the caller's Postgres commit.
 *
 * @param {string} raceId
 * @param {"USER"|"SYSTEM"} kind
 * @param {{id: string, createdAt: Date|string}} durableRow the row whose
 *   identity advances the marker. Membership changes pass a synthetic row
 *   carrying the acting change's timestamp (any newer durable identity works —
 *   spec §5 Phase C item 6).
 */
async function invalidateKind(raceId, kind, durableRow) {
  if (!raceId) return true;
  const listKey = cacheKeys.raceMessages(raceId, kind);
  const versionKey = cacheKeys.raceMessagesVersion(raceId, kind);
  const dataKeys = [listKey];
  if (kind === "USER") dataKeys.push(cacheKeys.raceMessageWatermark(raceId));
  const marker = JSON.stringify(encodeMarker(durableRow));

  return derivedCache.invalidate({
    prefix: cacheKeys.PREFIX.RACE_MESSAGES,
    run: async () => {
      const { ok, disabled } = await redisCache.evalLua(
        INVALIDATE_LUA,
        [versionKey, ...dataKeys],
        [marker, String(TTL_SECONDS)]
      );
      return { ok, disabled };
    },
  });
}

/** Both kinds — used by membership changes, which alter the whole context. */
async function invalidateRace(raceId, at = new Date()) {
  const synthetic = { id: `membership-${Date.now()}`, createdAt: at };
  const results = await Promise.all(
    cacheKeys.MESSAGE_KINDS.map((kind) =>
      invalidateKind(raceId, kind, synthetic)
    )
  );
  return results.every(Boolean);
}

module.exports = {
  getRows,
  getWatermark,
  invalidateKind,
  invalidateRace,
  isCacheableShape,
  encodeMarker,
  TTL_SECONDS,
  CACHE_ROW_CAP,
  WATERMARK_ROW_CAP,
  __setTestHooks,
};
