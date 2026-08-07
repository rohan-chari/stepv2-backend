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

const PREFIX = {
  SHOP_CATALOG: "v1:catalog:shop",
  POWERUP_CATALOG: "v1:catalog:powerups",
  APP_SETTINGS: "v1:settings:app",
  BALANCE: "v1:balance",
  GLOBAL_EVENTS: "v1:events:global",
  ASSETS_MANIFEST: "v1:assets:manifest",
  USER_COSMETICS: "v1:user:cosmetics",
  RACE_MESSAGES: "v1:race:msgs",
  RACE_PROGRESS: "v1:race:progress",
  // C4 (spec §3): per-user derived bits.
  USER_DAILY: "v1:user:daily",
  USER_INVENTORY: "v1:user:inventory",
  USER_RECENT_MINTS: "v1:user:recentmints",
  // C5 (spec §3): the assembled `/auth/me` response.
  USER_AUTHME: "v1:user:authme",
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
function powerupCatalog({ powerups4, hitchhikeEffectiveSteps }) {
  return `${PREFIX.POWERUP_CATALOG}:${flag(powerups4)}:${flag(
    hitchhikeEffectiveSteps
  )}`;
}

function powerupCatalogVariants() {
  const out = [];
  for (const powerups4 of BOOLS)
    for (const hitchhikeEffectiveSteps of BOOLS)
      out.push(powerupCatalog({ powerups4, hitchhikeEffectiveSteps }));
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

// ── C2: race chat lists + their durable version marker ──────────────────────
function raceMessages(raceId, kind) {
  return `${PREFIX.RACE_MESSAGES}:${raceId}:${kind}`;
}

function raceMessagesVersion(raceId, kind) {
  return `v1:race:msgver:${raceId}:${kind}`;
}

const MESSAGE_KINDS = ["USER", "SYSTEM"];

/** Both list keys + both version keys for a race — the full invalidation set. */
function raceMessagesAllKeys(raceId) {
  return [
    ...MESSAGE_KINDS.map((k) => raceMessages(raceId, k)),
    ...MESSAGE_KINDS.map((k) => raceMessagesVersion(raceId, k)),
  ];
}

// ── C3: shared live-standings snapshot + its stampede lock ──────────────────
// ONE key per race (spec §3 `v1:race:{id}:progress`), deliberately NOT keyed by
// viewer, client capability, or timezone:
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
function raceProgress(raceId) {
  return `${PREFIX.RACE_PROGRESS}:${raceId}`;
}

function raceProgressLock(raceId) {
  return `v1:lock:progress:${raceId}`;
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

function userAuthMe(userId, variant) {
  return `${PREFIX.USER_AUTHME}:${userId}:${variant ? "1" : "0"}`;
}

function userAuthMeVariants(userId) {
  return AUTHME_VARIANTS.map((v) => `${PREFIX.USER_AUTHME}:${userId}:${v}`);
}

module.exports = {
  PREFIX,
  CHANNELS,
  normalizeDate,
  userDaily,
  userInventory,
  userRecentMints,
  userAuthMe,
  userAuthMeVariants,
  raceProgress,
  raceProgressLock,
  shopCatalog,
  shopCatalogVariants,
  powerupCatalog,
  powerupCatalogVariants,
  assetsManifest,
  assetsManifestVariants,
  appSettingsKey,
  balanceKey,
  globalEventsKey,
  userCosmetics,
  raceMessages,
  raceMessagesVersion,
  raceMessagesAllKeys,
  MESSAGE_KINDS,
};
