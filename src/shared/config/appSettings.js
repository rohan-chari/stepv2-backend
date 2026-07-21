const { prisma: defaultPrisma } = require("../../db");

// DB-backed runtime feature flags, toggleable from the admin screen without a
// deploy (unlike the hardcoded constants in src/constants/*). Every readable
// flag must be declared in KNOWN_FLAGS with its default so a missing row (or a
// DB hiccup) always resolves to a safe value — flags degrade to their default,
// never to undefined.
//
// Reads are cached briefly so hot paths (/auth/me on every launch/resume) don't
// add a query per request; an admin PATCH busts the cache immediately in the
// process that served it, and other processes converge within CACHE_TTL_MS.
const KNOWN_FLAGS = {
  // New-user Daily-race activation flow. Default OFF so deploying this backend
  // cannot change behavior for either the current binary or a phased rollout.
  onboardingV2Enabled: false,
  // iOS banner ads (AdBannerSlot / AdInlineCard). The app also needs the
  // ADMOB_BANNER_AD_UNIT_ID dart-define baked into the build; this flag is the
  // remote kill switch layered on top. Default OFF (product decision 2026-07-12:
  // banners removed at 70 DAU; rewarded placements are unaffected).
  bannerAdsEnabled: false,
  // Team Race Mode creation kill switch (TR-107). When false the server rejects
  // NEW team-race creation (403 FEATURE_DISABLED) and clients hide the create
  // toggle via remote config; existing team races are unaffected (they run,
  // complete, and pay out normally). Default ON.
  teamRacesEnabled: true,
  // Buy-in edit unlock (Issue 4). When true, the race owner may raise/lower or
  // toggle paid<->free the buy-in on a PENDING race even after participants have
  // paid, and editRace reconciles the coin holds. When false, editRace keeps the
  // old hard block (cannot edit buy-in after a participant has paid). Default ON;
  // a remote kill switch to disable the reconcile without a redeploy.
  buyInEditEnabled: true,
  // Tournament (bracket) mode kill switch. Checked at create and every
  // join/accept path (403 FEATURE_DISABLED) and in the featured seed reconciler
  // (mints no new lobbies while off). Start and round advancement are NOT gated,
  // so flipping this off stops new entries while already-filled brackets finish
  // and pay their champion. Default ON.
  tournamentsEnabled: true,
};

function buildAppSettings(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const cacheTtlMs = dependencies.cacheTtlMs ?? 30_000;

  let cache = null;
  let cacheAt = 0;

  async function loadAll() {
    const now = Date.now();
    if (cache && now - cacheAt < cacheTtlMs) return cache;
    const rows = await prisma.appSetting.findMany();
    const byKey = {};
    for (const row of rows) byKey[row.key] = row.value;
    cache = byKey;
    cacheAt = now;
    return cache;
  }

  // Resolved value of one known flag. Unknown keys and any read failure fall
  // back to the declared default — callers never need their own try/catch.
  async function getFlag(key) {
    const fallback = KNOWN_FLAGS[key];
    try {
      const all = await loadAll();
      const value = all[key];
      if (typeof fallback === "boolean") {
        return typeof value === "boolean" ? value : fallback;
      }
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  // All known flags resolved (defaults filled in) — the admin settings screen
  // shape. Throws on DB failure so admin sees the error rather than silently
  // editing defaults.
  async function getAllFlags() {
    const rows = await prisma.appSetting.findMany();
    const byKey = {};
    for (const row of rows) byKey[row.key] = row.value;
    const out = {};
    for (const [key, fallback] of Object.entries(KNOWN_FLAGS)) {
      const value = byKey[key];
      out[key] =
        typeof fallback === "boolean" && typeof value !== "boolean"
          ? fallback
          : (value ?? fallback);
    }
    return out;
  }

  async function setFlag(key, value) {
    if (!(key in KNOWN_FLAGS)) {
      const err = new Error(`Unknown setting: ${key}`);
      err.statusCode = 400;
      throw err;
    }
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    cache = null; // bust so this process serves the new value immediately
  }

  return { getFlag, getAllFlags, setFlag, KNOWN_FLAGS };
}

const appSettings = buildAppSettings();

module.exports = { buildAppSettings, appSettings, KNOWN_FLAGS };
