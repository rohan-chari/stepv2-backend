// C3 (spec §5 Phase D, §3 key table `v1:race:{id}:progress`): the shared
// live-standings snapshot — its PINNED FIELD ALLOWLIST, its lifecycle, and the
// instrumentation the anti-recurrence tests assert on.
//
// ── Why an allowlist and not a scrub list ──────────────────────────────────
// The `/progress` payload mixes race-wide facts with REQUESTER-derived ones
// (`myPlacement`, the requester's box countdown, `dropOdds`, the per-viewer
// effect filter, the per-viewer Stealth/Detour/Imposter illusions). Caching the
// whole response and deleting the known viewer fields would leak viewer A's
// answers to viewer B the day someone adds a new viewer-specific field. So
// fields are copied IN by name: anything new is ABSENT from the cache by
// default, which fails loudly (a missing field) instead of silently (a wrong
// one). `assertAllowlisted` + the two-viewer isolation test are the guard.
//
// ── Lifecycle (§3 key table) ───────────────────────────────────────────────
// SOFT 15s / PHYSICAL 60s. The key lives 60s; a reader treats `asOf` older than
// 15s as STALE — serve it AND trigger a rebuild. A physical 15s TTL would
// delete the value the moment it went stale, and "losers serve the stale
// snapshot" would have nothing to serve.
//
// ── Who writes it ──────────────────────────────────────────────────────────
//   * the `/progress` request that WINS `v1:lock:progress:{raceId}` (SET), and
//   * the race-keyed v2 worker, from its post-commit hook (SET, never DEL —
//     the worker's value is the freshest there is; a DEL after it would throw
//     away the authoritative publish).
// Losers NEVER run the replay. They serve the stale snapshot if there is one,
// else wait ≤1s on REDIS ONLY (zero pooled PG connections held — the
// 2026-07-18 advisory-lock pool drain is exactly what that rule prevents), else
// the cheap persisted-columns read.
//
// ── Redis down / flag off ──────────────────────────────────────────────────
// `withLock` returns null when Redis is unavailable, so EVERY request takes the
// loser path and ends at the persisted read. The expensive replay never runs in
// the request path under any Redis state (§5 Phase D step 7, test 5e).

const redisCache = require("../../../shared/cache/redisCache");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// v2 adds a remote-assets capability variant to each presentation. Rejecting
// v1 snapshots is a compatibility requirement: a v1 tokenless variant could
// contain a `remoteOnly` accessory from before server-side filtering existed.
const SCHEMA_VERSION = 2;
// v3 removes participant presentation from the inner snapshot. It is written
// only by the default-off lean projection. A mixed-version v2 process rejects
// it instead of accepting a presentation-free roster it cannot hydrate.
const LEAN_SCHEMA_VERSION = 3;
const SOFT_TTL_MS = 15_000;
const PHYSICAL_TTL_SECONDS = 60;
const LOCK_TTL_MS = 10_000;
// Deliberately shorter than the measured recompute p99 (1.76s): some losers are
// SUPPOSED to fall through to the persisted read rather than hold a request
// open. Test 5 asserts exactly that ("snapshot OR valid fallback", not "all 20
// get the snapshot").
const LOSER_WAIT_MS = 1_000;
const LOSER_POLL_MS = 40;

// ── THE PINNED ALLOWLIST ────────────────────────────────────────────────────
// Top-level envelope.
const SNAPSHOT_FIELDS = [
  "v", // schema version
  "asOf", // ISO instant the shared state was computed
  "scoringTimeZone", // the tz the totals were bucketed in (see cacheKeys note)
  "source", // "replay" | "worker" | "persisted" — diagnostics only
  "race",
  "participants",
  "teams",
  "activeEffects",
];

// Race-wide facts. Every one of these is identical for every viewer.
const SNAPSHOT_RACE_FIELDS = [
  "raceId",
  "status",
  "endsAt",
  "maxDurationDays",
  "targetSteps",
  "isTeamRace",
  "teamSize",
  "winnerTeam",
  "powerupsEnabled",
  "powerupStepInterval",
  "tournamentId",
  "tournamentRound",
  "tournamentRoundLabel",
  "tournamentName",
];

// Per-participant HONEST state — before any per-viewer illusion is applied.
// `presentation` holds `characterPresentation`'s output for all eight
// (releaseChannel × supportsCharacters × supportsRemoteAssets) combinations, because that function is
// keyed by CLIENT CAPABILITY, not by viewer identity: precomputing the closed
// set keeps the raw `equippedAccessories` rows (and their Date columns) out of
// the cache while staying byte-identical to what the response would have held.
// `baseAdjusted` is the RAW walked total the box countdown needs; it is
// race-wide data (one number per participant), not a requester field.
const SNAPSHOT_PARTICIPANT_FIELDS = [
  "participantId",
  "userId",
  "displayName",
  "profilePhotoUrl",
  "presentation",
  "totalSteps",
  "finishedAt",
  "forfeitedAt",
  "team",
  "placement",
  "currentMultiplier",
  "baseAdjusted",
];

// Raw ACTIVE effect rows. The per-viewer filter (HIDDEN_FROM_OPPONENTS, the
// capability gates, the Piggy Bank owner-only counter) and the illusion
// collection both run at overlay time off these.
const SNAPSHOT_EFFECT_FIELDS = [
  "id",
  "type",
  "startsAt",
  "expiresAt",
  "status",
  "targetUserId",
  "sourceUserId",
  "targetParticipantId",
  "metadata",
];

// Fields that must NEVER appear in the snapshot. Enumerated so the regression
// guard reads as an assertion about intent rather than "whatever isn't listed".
const FORBIDDEN_SNAPSHOT_FIELDS = [
  "myPlacement",
  "myPlacementHidden",
  "powerupData",
  "dropOdds",
  "inventory",
  "queuedBoxCount",
  "stepsUntilNextPowerup",
  "newMysteryBoxes",
  "newQueuedBoxes",
  "powerupSlots",
  "viewerUserId",
  "userId", // top level only; participants[].userId is race-wide data
];

function pick(source, fields) {
  const out = {};
  for (const field of fields) out[field] = source ? source[field] : undefined;
  return out;
}

/**
 * Structural guard: every key of the snapshot (and of its nested race /
 * participant / effect objects) must be on the pinned list, and none of the
 * requester-specific names may appear anywhere. Thrown errors are the point —
 * a snapshot that fails this must never be published.
 */
function assertAllowlisted(snapshot) {
  const problems = [];
  const check = (obj, allowed, label) => {
    for (const key of Object.keys(obj || {})) {
      if (!allowed.includes(key)) problems.push(`${label}.${key}`);
    }
  };
  check(snapshot, SNAPSHOT_FIELDS, "snapshot");
  check(snapshot?.race, SNAPSHOT_RACE_FIELDS, "snapshot.race");
  for (const p of snapshot?.participants || []) {
    check(p, SNAPSHOT_PARTICIPANT_FIELDS, "snapshot.participants[]");
  }
  for (const e of snapshot?.activeEffects || []) {
    check(e, SNAPSHOT_EFFECT_FIELDS, "snapshot.activeEffects[]");
  }
  for (const forbidden of FORBIDDEN_SNAPSHOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot || {}, forbidden)) {
      problems.push(`snapshot.${forbidden} (requester-specific)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `race progress snapshot violates the pinned allowlist: ${problems.join(", ")}`
    );
  }
  return snapshot;
}

/**
 * THE allowlist builder. ONE function, two callers: the `/progress` lock winner
 * and the v2 worker's post-commit publish. Inputs are already API-shaped, so a
 * JSON round-trip through Redis is a no-op relative to what `res.json()` would
 * have emitted — which is what makes the flag-on/flag-off parity exact.
 */
function buildSnapshot({
  race,
  participants,
  teams = null,
  activeEffects = [],
  scoringTimeZone,
  asOf,
  source = "replay",
  schemaVersion = SCHEMA_VERSION,
}) {
  const snapshot = {
    v: schemaVersion,
    asOf: (asOf instanceof Date ? asOf : new Date(asOf)).toISOString(),
    scoringTimeZone,
    source,
    race: pick(race, SNAPSHOT_RACE_FIELDS),
    participants: (participants || []).map((p) =>
      pick(p, SNAPSHOT_PARTICIPANT_FIELDS)
    ),
    teams,
    activeEffects: (activeEffects || []).map((e) =>
      pick(e, SNAPSHOT_EFFECT_FIELDS)
    ),
  };
  return assertAllowlisted(snapshot);
}

// ── instrumentation (tests only; §8 tests 5 and 5e assert on it) ────────────
const counters = {
  // Full shared replays run FROM THE REQUEST PATH. Test 5e asserts this stays 0
  // with Redis down; test 5 asserts exactly 1 across 20 concurrent cold reads.
  requestReplays: 0,
  // Shared replays run by the worker's post-commit publish (off the request
  // path — never counted against the anti-recurrence guarantee).
  workerReplays: 0,
  snapshotHits: 0, // fresh snapshot served
  staleServes: 0, // stale-but-present snapshot served by a lock loser
  persistedFallbacks: 0, // cheap persisted-columns read served
  writeBacks: 0, // participant updateTotalSteps issued BY THE ENDPOINT
  publishes: 0,
  publishFailures: 0,
};

function resetCounters() {
  for (const key of Object.keys(counters)) counters[key] = 0;
}

function bump(key) {
  counters[key] = (counters[key] || 0) + 1;
}

// ── lifecycle ───────────────────────────────────────────────────────────────

function isFresh(snapshot, nowMs = Date.now()) {
  if (
    !snapshot ||
    ![SCHEMA_VERSION, LEAN_SCHEMA_VERSION].includes(snapshot.v) ||
    !snapshot.asOf
  ) return false;
  const asOf = new Date(snapshot.asOf).getTime();
  if (!Number.isFinite(asOf)) return false;
  return nowMs - asOf <= SOFT_TTL_MS;
}

/** A snapshot computed in a different scoring tz is not valid for this viewer. */
function matchesTimeZone(snapshot, scoringTimeZone) {
  return Boolean(snapshot) && snapshot.scoringTimeZone === scoringTimeZone;
}

async function readSnapshot(raceId, schemaVersion = SCHEMA_VERSION) {
  const value = await redisCache.getJSON(cacheKeys.raceProgress(raceId));
  return value && value.v === schemaVersion ? value : null;
}

// Both supported viewer-neutral schemas share one physical key. Consumers
// that accept either can fetch once instead of probing the same key twice.
async function readSupportedSnapshot(raceId) {
  const value = await redisCache.getJSON(cacheKeys.raceProgress(raceId));
  return value && [SCHEMA_VERSION, LEAN_SCHEMA_VERSION].includes(value.v)
    ? value
    : null;
}

/**
 * SET (never DEL). A failed publish is logged and IGNORED: the older snapshot
 * ages out of freshness within 15s and the next reader rebuilds (§5 Phase D
 * step 9 / spec item 4).
 */
async function writeSnapshot(raceId, snapshot) {
  const ok = await redisCache.setJSON(
    cacheKeys.raceProgress(raceId),
    snapshot,
    PHYSICAL_TTL_SECONDS
  );
  bump(ok ? "publishes" : "publishFailures");
  return ok;
}

/**
 * DEL the race's snapshot. Reuses the C2 breaker: a failed delete opens the
 * per-prefix read bypass (so a KNOWN-STALE snapshot is never served) and keeps
 * retrying in the background until it lands.
 *
 * Best-effort by contract — a mutation must never fail because Redis did.
 */
async function invalidateRaceProgress(raceId) {
  if (!raceId) return true;
  try {
    return await derivedCache.invalidate({
      keys: [cacheKeys.raceProgress(raceId)],
      prefix: cacheKeys.PREFIX.RACE_PROGRESS,
    });
  } catch (error) {
    console.error(`[C3] progress snapshot invalidation failed (${raceId}):`, error);
    return false;
  }
}

/** True when a failed DEL means a stale snapshot may still be sitting in Redis. */
function isBypassed() {
  return derivedCache.isBypassed(cacheKeys.PREFIX.RACE_PROGRESS);
}

/**
 * Lock-loser cold-start wait: poll REDIS for at most `LOSER_WAIT_MS`. No
 * Postgres connection is held for the duration — that is the whole point.
 */
async function waitForSnapshot(
  raceId,
  scoringTimeZone,
  deadlineMs = LOSER_WAIT_MS,
  schemaVersion = SCHEMA_VERSION
) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, LOSER_POLL_MS));
    const snapshot = await readSnapshot(raceId, schemaVersion);
    if (snapshot && matchesTimeZone(snapshot, scoringTimeZone)) return snapshot;
  }
  return null;
}

/** Run `fn` as the single rebuild owner, or resolve null immediately. */
async function withRebuildLock(raceId, fn) {
  return redisCache.withLock(cacheKeys.raceProgressLock(raceId), LOCK_TTL_MS, fn);
}

module.exports = {
  SCHEMA_VERSION,
  LEAN_SCHEMA_VERSION,
  SOFT_TTL_MS,
  PHYSICAL_TTL_SECONDS,
  LOCK_TTL_MS,
  LOSER_WAIT_MS,
  SNAPSHOT_FIELDS,
  SNAPSHOT_RACE_FIELDS,
  SNAPSHOT_PARTICIPANT_FIELDS,
  SNAPSHOT_EFFECT_FIELDS,
  FORBIDDEN_SNAPSHOT_FIELDS,
  buildSnapshot,
  assertAllowlisted,
  isFresh,
  matchesTimeZone,
  readSnapshot,
  readSupportedSnapshot,
  writeSnapshot,
  invalidateRaceProgress,
  isBypassed,
  waitForSnapshot,
  withRebuildLock,
  __counters: counters,
  __resetCounters: resetCounters,
  __bump: bump,
};
