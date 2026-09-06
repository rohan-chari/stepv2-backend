// Key builders for the Redis derived-data layer (spec §3 "Internal contract:
// Redis key schema (v1)"). The env prefix (`p:`/`s:`/`t:`) is added by
// `redisCache`, so everything here is the LOGICAL key.
//
// Why several C1 keys carry a variant suffix the spec's table doesn't show:
// the underlying payloads are not actually global. `/shop/catalog`'s item list
// is filtered by release channel and by client capability tokens; the assets
// manifest is filtered by release channel; the powerup copy catalog is shaped
// by capability tokens. Caching them under a single key would serve a
// staging-only item to a prod client (or a `characters` payload to a build that
// cannot render it) — a correctness bug, not a freshness one. Each surface
// therefore caches per variant, and invalidation DELETES EVERY VARIANT
// (`variantsFor*` below) rather than relying on SCAN, which is O(keyspace) and
// unsafe to run on the request path.

const { createHash } = require("node:crypto");

const PREFIX = {
  SHOP_CATALOG: "v1:catalog:shop",
  POWERUP_CATALOG: "powerup-copy-catalog:v3",
  APP_SETTINGS: "v1:settings:app",
  // v2 invalidates any pre-migration raw active-config row after Decoy moves
  // from store-only to the RARE pool. A rolling old worker may keep using v1;
  // new workers never ingest that stale snapshot.
  BALANCE: "v2:balance",
  GLOBAL_EVENTS: "v1:events:global",
  ASSETS_MANIFEST: "v1:assets:manifest",
  USER_COSMETICS: "v1:user:cosmetics",
  RACE_MESSAGES: "v1:race:msgs",
  RACE_PROGRESS: "v1:race:progress",
  RACE_PROGRESS_INDEX: "v1:race:progress:index",
  RACE_PROGRESS_PAGE: "v1:race:progress:page",
  RACE_PROGRESS_PARTICIPANT: "v1:race:progress:participant",
  RACE_RESOLUTION_ARTIFACT: "v1:race:resolution-artifact",
  // C4 (spec §3): per-user derived bits.
  USER_DAILY: "v1:user:daily",
  USER_INVENTORY: "v1:user:inventory",
  USER_RECENT_MINTS: "v1:user:recentmints",
  // Batch 2026-08-10b item 2: the viewer's remaining daily discard-coin cap.
  USER_DISCARD_CAP: "v1:user:discardcap",
  // C5 (spec §3): the assembled `/auth/me` response.
  USER_AUTHME: "v1:user:authme",
  USER_FRIENDS: "v1:user:friends",
  USER_FRIENDS_VERSION: "v1:user:friendsver",
  USER_COSMETICS_VERSION: "v1:user:cosmeticsver",
  LEADERBOARD_STEPS_GLOBAL: "v1:leaderboard:steps:global",
  LEADERBOARD_STEPS_FRIENDS: "v1:leaderboard:steps:friends",
  LEADERBOARD_LOCK: "v1:lock:leaderboard",
  FRIEND_SEARCH_RATE: "v1:user:friendsearchrate",
  HOME_IMPACT_SUMMARY: "v3:home:impact-summary",
  HOME_INBOX_UNREAD: "v1:home:inbox-unread",
  HOME_GIVEAWAY_BANNER: "v1:home:giveaway-banner",
  HOME_ACTIVE_GLOBAL_EVENT: "v1:user",
  RACE_LIST: "v1:user:races",
  COMPLETED_RACE_SUMMARY: "v1:race:completed-summary",
  DATABASE_POOL_TELEMETRY: "v1:ops:db-pool",
  STEP_INGESTION_HOUR: "v1:ops:step-ingestion-hour",
  STEP_INGESTION_HISTORY_START: "v1:ops:step-ingestion-history-start",
  EVENT_SURGE: "v1:ops:event-surge",
};

// The only two values `resolveReleaseChannel` can ever produce
// (src/shared/middleware/releaseChannel.js) — anything unrecognised resolves to
// "prod". Enumerating them is what lets invalidation delete every variant
// without SCAN.
const CHANNELS = ["prod", "testflight"];
const BOOLS = [false, true];

function flag(value) {
  return value ? "1" : "0";
}

// ── C1: shop cosmetics catalog (the GLOBAL item-list portion only) ──────────
// The per-user parts of `getShopCatalog` (coins, ownedItemIds, equipped) are
// NEVER cached under this key — they are read per request.
function shopCatalog({ channel, supportsCharacters, supportsRemoteAssets }) {
  return `${PREFIX.SHOP_CATALOG}:${channel}:${flag(supportsCharacters)}:${flag(
    supportsRemoteAssets
  )}`;
}

function shopCatalogVariants() {
  const out = [];
  for (const channel of CHANNELS)
    for (const supportsCharacters of BOOLS)
      for (const supportsRemoteAssets of BOOLS)
        out.push(shopCatalog({ channel, supportsCharacters, supportsRemoteAssets }));
  return out;
}

// ── C1: powerup COPY catalog (GET /powerups/catalog — unauthenticated) ──────
function powerupCatalog({
  channel,
  signalJammer,
  powerups2,
  powerups3,
  powerups4,
  powerups5,
  hitchhikeEffectiveSteps,
  stackingGuide,
}) {
  return `${PREFIX.POWERUP_CATALOG}:${CHANNELS.includes(channel) ? channel : "prod"}:${[
    signalJammer, powerups2, powerups3, powerups4, powerups5,
    hitchhikeEffectiveSteps, stackingGuide,
  ].map(flag).join("")}`;
}

function powerupCatalogVariants() {
  const out = [];
  for (const channel of CHANNELS)
    for (const signalJammer of BOOLS)
      for (const powerups2 of BOOLS)
        for (const powerups3 of BOOLS)
          for (const powerups4 of BOOLS)
            for (const powerups5 of BOOLS)
              for (const hitchhikeEffectiveSteps of BOOLS)
                for (const stackingGuide of BOOLS)
                  out.push(powerupCatalog({
                    channel, signalJammer, powerups2, powerups3, powerups4,
                    powerups5, hitchhikeEffectiveSteps, stackingGuide,
                  }));
  return out;
}

// ── C1: /assets/manifest ────────────────────────────────────────────────────
function assetsManifest({ channel }) {
  return `${PREFIX.ASSETS_MANIFEST}:${channel}`;
}

function assetsManifestVariants() {
  return CHANNELS.map((channel) => assetsManifest({ channel }));
}

// ── C1: single-variant keys ─────────────────────────────────────────────────
const appSettingsKey = PREFIX.APP_SETTINGS;
const balanceKey = PREFIX.BALANCE;
const globalEventsKey = PREFIX.GLOBAL_EVENTS;

// ── C2: per-user cosmetics / sender presentation ────────────────────────────
// Spec §3 names this `v1:user:{id}:cosmetics`. It holds the whole per-user
// *presentation* bundle (display name, photo, equipped accessories, character)
// because chat's sender fields are exactly as per-user-mutable as the
// cosmetics are, and one key with one invalidation set is safer than two.
function userCosmetics(userId) {
  return `${PREFIX.USER_COSMETICS}:${userId}`;
}

function userCosmeticsVersion(userId) {
  return `${PREFIX.USER_COSMETICS_VERSION}:${userId}`;
}

function homeActiveGlobalEvent(userId) {
  return `${PREFIX.HOME_ACTIVE_GLOBAL_EVENT}:${userId}:active-global-event`;
}

function userFriends(userId) {
  return `${PREFIX.USER_FRIENDS}:${userId}`;
}

function userFriendsVersion(userId) {
  return `${PREFIX.USER_FRIENDS_VERSION}:${userId}`;
}

const LEADERBOARD_PERIODS = new Set(["today", "week", "month", "allTime"]);
function normalizedLeaderboardBoundary(period, boundary) {
  if (!LEADERBOARD_PERIODS.has(period)) throw new TypeError("invalid leaderboard period");
  if (period === "allTime") {
    if (boundary !== "all") throw new TypeError("allTime boundary must be all");
    return "all";
  }
  if (typeof boundary !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(boundary)) {
    throw new TypeError("leaderboard boundary must be YYYY-MM-DD");
  }
  return boundary;
}

function leaderboardGlobal({ eligibilityEpoch, period, boundary }) {
  if (!Number.isSafeInteger(eligibilityEpoch) || eligibilityEpoch < 0) {
    throw new TypeError("invalid eligibility epoch");
  }
  return `${PREFIX.LEADERBOARD_STEPS_GLOBAL}:${eligibilityEpoch}:${period}:${normalizedLeaderboardBoundary(period, boundary)}`;
}

function leaderboardFriends({ viewerId, eligibilityEpoch, acceptedSetHash, period, boundary }) {
  if (!viewerId || !/^[a-f0-9]{64}$/.test(acceptedSetHash || "")) {
    throw new TypeError("invalid friends leaderboard identity");
  }
  if (!Number.isSafeInteger(eligibilityEpoch) || eligibilityEpoch < 0) {
    throw new TypeError("invalid eligibility epoch");
  }
  return `${PREFIX.LEADERBOARD_STEPS_FRIENDS}:${viewerId}:${eligibilityEpoch}:${acceptedSetHash}:${period}:${normalizedLeaderboardBoundary(period, boundary)}`;
}

function leaderboardLock(logicalRankingKey) {
  const digest = createHash("sha256").update(logicalRankingKey).digest("hex");
  return `${PREFIX.LEADERBOARD_LOCK}:${digest}`;
}

function acceptedFriendSetHash(friendIds) {
  return createHash("sha256").update([...new Set(friendIds)].sort().join("\n")).digest("hex");
}

function friendSearchRate(userId, utcMinuteEpoch) {
  if (!userId || !Number.isSafeInteger(utcMinuteEpoch) || utcMinuteEpoch < 0) {
    throw new TypeError("invalid friend-search rate key input");
  }
  return `${PREFIX.FRIEND_SEARCH_RATE}:${userId}:${utcMinuteEpoch}`;
}

function homeImpactSummary(userId) { return `${PREFIX.HOME_IMPACT_SUMMARY}:${userId}`; }
function homeInboxUnread(userId) { return `${PREFIX.HOME_INBOX_UNREAD}:${userId}`; }
function homeGiveawayBanner() { return `${PREFIX.HOME_GIVEAWAY_BANNER}:active`; }

const DATABASE_POOL_IDENTITIES = new Set([
  "http:0",
  "http:1",
  "resolution:0",
  "cron:0",
]);

function databasePoolTelemetry(role, instance) {
  const identity = `${role}:${instance}`;
  if (!DATABASE_POOL_IDENTITIES.has(identity)) {
    throw new TypeError("invalid database pool telemetry identity");
  }
  return `${PREFIX.DATABASE_POOL_TELEMETRY}:${identity}`;
}

function stepIngestionHour(atMs) {
  const numeric = Number(atMs);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new TypeError("invalid step ingestion hour timestamp");
  }
  return `${PREFIX.STEP_INGESTION_HOUR}:${new Date(numeric).toISOString().slice(0, 13)}`;
}

function stepIngestionHistoryStart() {
  return PREFIX.STEP_INGESTION_HISTORY_START;
}

function eventSurge(role, instance) {
  const identity = `${role}:${instance}`;
  if (!DATABASE_POOL_IDENTITIES.has(identity)) throw new TypeError("invalid event surge telemetry identity");
  return `${PREFIX.EVENT_SURGE}:${identity}`;
}

// `/races` is split into a user-scoped membership snapshot and two bounded
// status fragments. The generation is deliberately separate from the variant
// key: invalidation advances one small marker instead of enumerating every
// capability combination a user may have requested.
function raceListGeneration(userId) {
  return `${PREFIX.RACE_LIST}:generation:${userId}`;
}

function raceListMembership(userId) {
  return `${PREFIX.RACE_LIST}:membership:${userId}`;
}

function raceListFragment(kind, userId, generation, variant) {
  if (!/^(?:completed|pending)$/.test(kind)) {
    throw new TypeError("invalid race list fragment kind");
  }
  return `${PREFIX.RACE_LIST}:${kind}:${userId}:${generation}:${variant}`;
}

function completedRaceSummary(raceId, resultVersion) {
  if (typeof raceId !== "string" || raceId.length === 0) {
    throw new TypeError("invalid completed race summary id");
  }
  if (typeof resultVersion !== "string" || resultVersion.length === 0) {
    throw new TypeError("invalid completed race summary version");
  }
  return `${PREFIX.COMPLETED_RACE_SUMMARY}:${raceId}:${encodeURIComponent(resultVersion)}`;
}

// ── C2: race chat lists + their durable version marker ──────────────────────
function raceMessageIdentity(kind, audience = "ALL", team = null) {
  if (kind !== "USER") return kind;
  return audience === "TEAM" && (team === "TEAM_A" || team === "TEAM_B")
    ? `USER:${team}`
    // Preserve the pre-team-chat key for the public/legacy stream. Besides
    // keeping mixed-version workers on one cache identity, this avoids
    // abandoning still-valid USER entries during a rolling deploy.
    : "USER";
}

function raceMessages(raceId, kind, audience = "ALL", team = null) {
  return `${PREFIX.RACE_MESSAGES}:${raceId}:${raceMessageIdentity(kind, audience, team)}`;
}

function raceMessagesVersion(raceId, kind, audience = "ALL", team = null) {
  return `v1:race:msgver:${raceId}:${raceMessageIdentity(kind, audience, team)}`;
}

function raceMessageWatermark(raceId, audience = "ALL", team = null) {
  return `v1:race:msgwatermark:${raceId}:${raceMessageIdentity("USER", audience, team)}`;
}

const MESSAGE_KINDS = ["USER", "SYSTEM"];

/** Both list keys + both version keys for a race — the full invalidation set. */
function raceMessagesAllKeys(raceId) {
  return [
    raceMessages(raceId, "SYSTEM"),
    raceMessagesVersion(raceId, "SYSTEM"),
    ...[["ALL", null], ["TEAM", "TEAM_A"], ["TEAM", "TEAM_B"]].flatMap(
      ([audience, team]) => [
        raceMessages(raceId, "USER", audience, team),
        raceMessagesVersion(raceId, "USER", audience, team),
        raceMessageWatermark(raceId, audience, team),
      ],
    ),
  ];
}

// ── C3: shared live-standings snapshot + its stampede lock ──────────────────
// One key per race and supported internal snapshot SCHEMA, deliberately NOT
// keyed by viewer, client capability, or timezone. The deployed v2/legacy key
// stays byte-for-byte stable; the presentation-free v3 projection has its own
// additive key so mixed old/current traffic cannot overwrite it and trigger a
// rebuild loop.
//   * viewer/capability variance is handled by the per-request OVERLAY, never by
//     the cached value (that is the whole point of the pinned allowlist);
//   * the SCORING TIMEZONE is embedded in the payload instead of the key. A
//     user-created race carries `timezone = NULL` and therefore scores in the
//     REQUESTER's header tz (raceTimeZone()), so a snapshot built for one tz is
//     not valid for a viewer in another. Encoding that in the key would make the
//     invalidation set unenumerable (any IANA tz), which is exactly the SCAN
//     problem the C1 variant helpers exist to avoid. Instead a tz mismatch is
//     treated as a MISS: the request rebuilds (under the lock) or takes the
//     cheap persisted fallback. One key => one DEL => the §3 hook list stays
//     literally correct.
function raceProgress(raceId, schemaVersion = 2) {
  return Number(schemaVersion) === 3
    ? `${PREFIX.RACE_PROGRESS}:${raceId}:lean-v3`
    : `${PREFIX.RACE_PROGRESS}:${raceId}`;
}

function raceProgressVariants(raceId) {
  return [raceProgress(raceId, 2), raceProgress(raceId, 3)];
}

function raceProgressLock(raceId, schemaVersion = 2) {
  return Number(schemaVersion) === 3
    ? `v1:lock:progress:${raceId}:lean-v3`
    : `v1:lock:progress:${raceId}`;
}

function raceProgressPagePublishLock(raceId) {
  return `v1:lock:progress-page-publish:${raceId}`;
}

function raceProgressIndex(raceId) {
  return `${PREFIX.RACE_PROGRESS_INDEX}:${raceId}`;
}

function raceProgressPage(raceId, generation, chunk) {
  return `${PREFIX.RACE_PROGRESS_PAGE}:${raceId}:${generation}:${chunk}`;
}

function raceProgressPageSlot(raceId, chunk) {
  return `${PREFIX.RACE_PROGRESS_PAGE}:${raceId}:slot:${chunk}`;
}

function raceProgressPageBankSlot(raceId, bank, chunk) {
  return `${PREFIX.RACE_PROGRESS_PAGE}:${raceId}:bank:${bank}:${chunk}`;
}

function raceProgressParticipant(raceId, generation, userId) {
  return `${PREFIX.RACE_PROGRESS_PARTICIPANT}:${raceId}:${generation}:${userId}`;
}

function raceProgressParticipantBucket(raceId, generation, bucket) {
  return `${PREFIX.RACE_PROGRESS_PARTICIPANT}:${raceId}:${generation}:bucket:${bucket}`;
}

function raceProgressParticipantBucketSlot(raceId, bucket) {
  return `${PREFIX.RACE_PROGRESS_PARTICIPANT}:${raceId}:slot:bucket:${bucket}`;
}

function raceProgressParticipantBucketBankSlot(raceId, bank, bucket) {
  return `${PREFIX.RACE_PROGRESS_PARTICIPANT}:${raceId}:bank:${bank}:bucket:${bucket}`;
}

// ── C4: a user's daily step total, per DATE ─────────────────────────────────
// The date is part of the key because `/friends/steps` is a per-date query
// (`?date=YYYY-MM-DD`, defaulting to today's UTC date). A date-blind key would
// serve one day's total for another the moment a client asked for history, and
// would also break across the UTC midnight boundary for users whose local date
// has not rolled over yet.
//
// `date` is normalised to a bare YYYY-MM-DD so that the READ side (a query
// string) and the WRITE side (a `Date` or a string from the sync command)
// always produce the same key — a mismatch here is a silently-never-invalidated
// cache, which is the worst failure mode this layer can have.
function normalizeDate(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  if (typeof date === "string") return date.slice(0, 10);
  return String(date ?? "").slice(0, 10);
}

function userDaily(userId, date) {
  return `${PREFIX.USER_DAILY}:${userId}:${normalizeDate(date)}`;
}

// ── C4: the user's global powerup inventory ─────────────────────────────────
// ONE key per user, NOT per client-capability variant: the cached value is the
// FULL row set and the capability filters (`powerups4` gating QUICKSAND) are
// applied per request on the way out. Caching the filtered payload would need a
// variant key per capability combination and would risk an old build being
// served a warm modern payload.
function userInventory(userId) {
  return `${PREFIX.USER_INVENTORY}:${userId}`;
}

// ── C3 (spec v9 item 2): a users UNREPORTED in-race box mints ──────────────
// Spec §3 names this `v1:user:{id}:recentmints`; it follows the same
// PREFIX-then-id ordering as every other per-user key in this file.
//
// Why it exists: Phase D moves `syncRacePowerupState` off the request path, so
// the poll that USED to mint a box can no longer report it in
// `powerupData.newMysteryBoxes` — the delta the race-detail "You earned a
// mystery box!" toast reads. The worker now records each mint here and the
// viewer overlay CONSUMES it, so the toast survives with a 2-15s delay and no
// API change (a frozen client reads the same field it always did).
//
// Keyed by USER, not by (user, race): a single poll must not eat another
// races pending toast, so the consume is a Lua filter-and-write-back rather
// than a GETDEL. Short TTL (60s) bounds a toast that is never collected.
function userRecentMints(userId) {
  return `${PREFIX.USER_RECENT_MINTS}:${userId}`;
}

function raceResolutionArtifact(opaqueArtifactId) {
  if (
    typeof opaqueArtifactId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(opaqueArtifactId)
  ) {
    throw new TypeError("invalid opaque artifact id");
  }
  return `${PREFIX.RACE_RESOLUTION_ARTIFACT}:${opaqueArtifactId}`;
}

// ── C4: the user's remaining daily discard-coin cap ─────────────────────────
// Batch 2026-08-10b item 2. Keyed on `userId` ALONE — deliberately NO localDate
// component (architect S2): at a 60s TTL a date component buys nothing, and it
// would introduce a JS-local-date vs SQL-local-day disagreement right at
// midnight, which is the one moment the value changes. The TTL self-heals the
// rollover. Invalidated at the one write seam that can move it (discardPowerup).
function userDiscardCap(userId) {
  return `${PREFIX.USER_DISCARD_CAP}:${userId}`;
}

// ── C5: the assembled `/auth/me` response ───────────────────────────────────
// One variant axis, and only one: `withRuntimeFlags` OMITS
// `featureFlags.stepSampleBucketMinutes` for builds below
// FINE_BUCKET_MIN_APP_VERSION (the 2026-07-23 step-inflation incident). Serving
// a warm modern payload to a 1.7.0 binary would re-open that incident, so the
// gate result is part of the key. Everything else in the payload is derived
// from the user row (admin flag included), which is per-user, not per-request.
//
// The variant set is EXACTLY two values, so invalidation enumerates them rather
// than SCANning (same rule as the C1 catalog variants).
const AUTHME_VARIANTS = ["0", "1"];
const AUTHME_CONTRACTS = ["legacy", "shell-v1"];

function userAuthMe(userId, variant, contract = "legacy") {
  if (!AUTHME_CONTRACTS.includes(contract)) {
    throw new TypeError("invalid auth-me contract variant");
  }
  const fine = variant ? "1" : "0";
  // Keep the deployed legacy key byte-for-byte stable during rolling deploys;
  // only the additive compact contract receives the new contract axis.
  return contract === "legacy"
    ? `${PREFIX.USER_AUTHME}:${userId}:${fine}`
    : `${PREFIX.USER_AUTHME}:${userId}:${contract}:${fine}`;
}

function userAuthMeVariants(userId) {
  return AUTHME_CONTRACTS.flatMap((contract) =>
    AUTHME_VARIANTS.map((variant) =>
      userAuthMe(userId, variant === "1", contract)
    )
  );
}

module.exports = {
  PREFIX,
  CHANNELS,
  normalizeDate,
  userDaily,
  userInventory,
  userRecentMints,
  userDiscardCap,
  userAuthMe,
  userAuthMeVariants,
  raceProgress,
  raceProgressVariants,
  raceProgressLock,
  raceProgressPagePublishLock,
  raceProgressIndex,
  raceProgressPage,
  raceProgressPageSlot,
  raceProgressPageBankSlot,
  raceProgressParticipant,
  raceProgressParticipantBucket,
  raceProgressParticipantBucketSlot,
  raceProgressParticipantBucketBankSlot,
  shopCatalog,
  shopCatalogVariants,
  powerupCatalog,
  powerupCatalogVariants,
  assetsManifest,
  assetsManifestVariants,
  appSettingsKey,
  balanceKey,
  globalEventsKey,
  homeActiveGlobalEvent,
  userCosmetics,
  userCosmeticsVersion,
  userFriends,
  userFriendsVersion,
  leaderboardGlobal,
  leaderboardFriends,
  leaderboardLock,
  acceptedFriendSetHash,
  friendSearchRate,
  homeImpactSummary,
  homeInboxUnread,
  homeGiveawayBanner,
  databasePoolTelemetry,
  stepIngestionHour,
  stepIngestionHistoryStart,
  eventSurge,
  raceListGeneration,
  raceListMembership,
  raceListFragment,
  completedRaceSummary,
  raceMessages,
  raceMessagesVersion,
  raceMessageWatermark,
  raceMessagesAllKeys,
  raceResolutionArtifact,
  MESSAGE_KINDS,
};
