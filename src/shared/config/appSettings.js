const { prisma: defaultPrisma } = require("../../db");
const derivedCache = require("../cache/derivedCache");
const cacheKeys = require("../cache/cacheKeys");

// Every C1 key is a 60s safety net; invalidation is the primary mechanism
// (spec §3 key table).
const CATALOG_TTL_SECONDS = 60;

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
  // Capacity Milestone 5.0: sampled aggregate-only phase/query telemetry.
  // Default OFF; it changes no response or business behavior. Reads use the
  // existing 30-second settings cache and instrumentation issues no SQL itself.
  capacityPhaseMetricsV1Enabled: false,
  // Accessory visual-region compatibility is additive at the API/schema level,
  // but enforcement stays dark until the app build that explains 409 conflicts
  // has rolled out. Frozen clients still receive the longstanding `{error}`.
  accessoryCompatibilityEnforcement: false,
  // New-user Daily-race activation flow. Default OFF so deploying this backend
  // cannot change behavior for either the current binary or a phased rollout.
  onboardingV2Enabled: false,
  // Onboarding revamp (v3): health-gate rework + degraded "steps not connected"
  // state, notification ask relocated to first box open, referral-first landing,
  // rename affordance, and the 5-step tutorial. Read ONLY by builds carrying the
  // revamp; frozen binaries read named keys off `featureFlags` and ignore
  // unknown ones, so serving this is inert for every shipped client and needs no
  // X-App-Version gate. Default OFF so the backend deploy changes nothing —
  // flip it from the admin screen once the App Store build has rolled out, and
  // flip it back to roll the whole flow back with no submission.
  onboardingV3Enabled: false,
  // Invite-code onboarding step (a KILL SWITCH, not an opt-in — note the
  // default differs from onboardingV3Enabled above on purpose). The step asks a
  // new v3 user whether a friend invited them, catching the referrals the
  // clipboard handoff and IP fallback miss; it can only ever ADD attributions,
  // so the safe posture is ON and the switch exists to yank it without an App
  // Store submission. The client mirrors that: absent or non-boolean ⇒ ON, only
  // a literal `false` disables. Inert for every frozen binary, which reads named
  // keys off `featureFlags` and ignores unknown ones.
  onboardingInviteCodeEnabled: true,
  // Next-race CTA rollout switches. Default OFF: deploying the backend alone
  // performs no new discovery work and exposes no new creation behavior.
  openUserRaceDiscoveryEnabled: false,
  quickCreateRaceCtaEnabled: false,
  setupInviteCodePromptEnabled: false,
  // Custom race windows (docs/race-timeline-options-requirements.md §5.2a): the
  // CUSTOM timeline chip and the scheduledStartAt/scheduledEndAt fields on
  // create/edit. Default OFF so deploying this backend changes nothing for
  // anyone; while off, a scheduledEndAt on create or PATCH is REJECTED with
  // 403 FEATURE_DISABLED rather than silently dropped — silently dropping it
  // would create a race that ends at a time the creator did not choose, which
  // is worse than a clean error. Clients default it false when absent, so an
  // older backend simply hides the chip. The flip is NOT instant: it clears
  // only after the in-process settings TTL and the userAuthMe Redis TTL both
  // expire.
  customRaceWindowEnabled: false,
  // Discoverable identity rollout controls. Contract support and additive
  // response fields ship independently; this switch only enrolls capable NEW
  // creates into mandatory onboarding.
  discoverableIdentityOnboardingEnrollmentEnabled: false,
  // Client-transported capability flag for the blocking Races invite gate.
  // Only literal true activates it; false is the safe inline-invite fallback.
  racesInviteDecisionGateEnabled: false,
  // Capability-scoped Home invite preflight serializer. Default OFF: deploys
  // preserve the legacy preflight buckets until the carrying mobile build is
  // ready, and a fast flag rollback simply returns the old serializer.
  homeInviteModalEnabled: false,
  // Private daily/weekly bucket stream stays dark until the carrying app build
  // is available. Non-capable users remain on the existing global stream.
  seededRaceBucketsEnabled: false,
  // Server-only switch for transactional quick-share automatic friendship.
  quickRaceShareAutoFriendEnabled: false,
  // Race/tournament preview-before-joining (docs/race-preview-before-join-spec.md).
  // Lets a NON-participant read a PUBLIC, non-tournament-matchup race on the
  // three access-gated endpoints (GET /races/:id, /bootstrap, /progress).
  //
  // This is a KILL SWITCH layered on top of the client `race_preview` capability
  // token, not a redundant second gate. The token is a COMPAT gate — it proves
  // the caller's build can render a preview — but once that build is on the App
  // Store it is frozen, so the token can never be withdrawn without a new
  // submission. Two concrete risks make an instant off switch necessary: preview
  // /progress reads deliberately fall through to the read-only persisted path on
  // a cross-timezone snapshot miss (a full participants + active-effects read on
  // the system's most expensive endpoint), and if the participants[] financial
  // redaction is ever found incomplete, this flag is the only remediation that
  // isn't a week-long phased rollout.
  //
  // Default FALSE: deploying this backend changes nothing for anyone. Flip it on
  // only after the carrying app build has substantially rolled out.
  racePreviewEnabled: false,
  // Rewarded-ad race payout double cohort percentage. Numeric 0..100; zero is
  // the deployment-safe default. Preparation rechecks the row uncached inside
  // its transaction, while GET /races may use this short-lived advisory cache.
  racePayoutDoubleRolloutPercent: 0,
  // Mandatory onboarding tutorial (batch 2026-08-09 item 9). When TRUE, a
  // build that carries the mandatory-capable onboarding removes every escape
  // hatch from the tutorial (intro skip, in-tutorial skip chip/pill, back
  // gesture, and mark-seen-on-bail).
  //
  // This flag exists because "cannot be skipped" is a HARD BLOCK: a crash or a
  // broken spotlight anchor in the tutorial would wedge a user out of the app
  // entirely, and an App Store fix is a ~1-week phased rollout. Flipping this
  // off from the admin flags card defuses that in seconds for every app
  // version at once. It is the remote half of the safety story; the client
  // also carries a LOCAL 3-abandon circuit breaker that re-shows the skip
  // control regardless of this flag.
  //
  // Default FALSE, and the client must read it defensively: absent or false ==
  // today's skippable behavior. Only an explicit `true` activates mandatory
  // mode, so this backend deploying ahead of the carrying build changes
  // nothing for anyone. The Settings "VIEW TUTORIAL" replay is NOT governed by
  // this flag — a voluntary replay always keeps its exits.
  tutorialMandatoryEnabled: false,
  // iOS banner ads (AdBannerSlot / AdInlineCard). The app also needs the
  // ADMOB_BANNER_AD_UNIT_ID dart-define baked into the build; this flag is the
  // remote kill switch layered on top. Default OFF (product decision 2026-07-12:
  // banners removed at 70 DAU; rewarded placements are unaffected).
  bannerAdsEnabled: false,
  // Adds a dedicated top banner to box-opening routes. Kept separate from the
  // master banner switch so it can be rolled back independently.
  dualBoxBannersEnabled: false,
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
  // App-funded prize pools (buy-ins removed). While FALSE the backend behaves
  // exactly as today: races/brackets charge and hold buy-ins. Flipping it on
  // affects NEW competitions only — it decides `fundedPrize` at create time, and
  // settlement reads that column, never this flag, so a mid-race flip can neither
  // strand a promised prize nor let a competition pay under both models.
  //
  // Default ON (owner decision 2026-07-24): this ships live rather than dark.
  // Safe for frozen binaries because the funded read path reports the pool as
  // `projectedPotCoins` and `buyInAmount: 0` (racePrizePool.js) — an un-updated
  // build renders the correct prize as POT and charges nothing. In-flight
  // buy-in races are unaffected; they settle under the old model off their own
  // `fundedPrize: false` column.
  //
  // KILL SWITCH: this is only the fallback. Storing `false` in the AppSetting
  // row overrides it at runtime with no deploy — new competitions revert to
  // buy-ins immediately, and any funded race already created still pays its
  // minted pool. The buy-in code path is therefore still live code, not dead
  // code: the suites that cover it pin this flag off explicitly rather than
  // relying on the default.
  fundedPrizePoolsEnabled: true,
  // §4.15 payout rounding is a creation-time kill switch. Default ON by owner
  // decision: it stamps only newly created eligible competitions, while every
  // existing row retains its immutable version 0 settlement/display behavior.
  payoutRoundingV1Enabled: true,
  // Ordinary-race leave/forfeit protocol. This controls STAMPING ON NEW races
  // only; a race reads its own exitActionsEnabled column for its whole life, so
  // flipping this off is a safe creation rollback and cannot strand a client
  // that was already offered an exit action.
  raceExitActionsEnabled: false,
  // Step-sample upload granularity in minutes (Five-Minute Step Samples §3.2).
  // NUMERIC flag, allowed set {5,10,15,30,60}. Default 60 = hourly (today's
  // behavior). Served on /auth/me via a defensive safeNumber that OMITS the key
  // unless a valid value is stored, so old backends / absent rows / invalid
  // values all make the client fall back to 60. Registered here so the admin
  // settings surface can set it (setFlag rejects unknown keys).
  stepSampleBucketMinutes: 60,
  // Top-heavy seeded challenge payouts. Read ONLY by createSeededRace, which
  // stamps races.payout_curve at creation; settlement and every read path go off
  // that column, never this flag. Flipping it off therefore stops stamping NEW
  // races while already-stamped ones honour the curve they advertised — correct,
  // not a bug. Default OFF so the deploy changes nothing.
  seededGeometricPayoutsEnabled: false,
  // Inactive-participant pruning for the seeded challenges: one kill switch over
  // all three hooks (enrollment filter, promotion prune, weekly mid-race sweep).
  // OFF restores today's behavior exactly and immediately. Default OFF.
  seededInactivityPruneEnabled: false,
  // Sub-switch of the prune (batch 2026-08-10 item 1): when a pruned user is
  // ALSO boxless in the same window, turn their auto_join_featured_races off so
  // the renewal cron stops re-enrolling a dead account into every new seeded
  // race. Only ever consulted from inside the prune hooks, so the parent switch
  // above gates it too. Default OFF = zero behavior change at deploy time.
  // Rollback is the toggle; already-flipped users stay off (they can re-enable
  // from the settings screen at any time).
  seededInactivityAutoEnrollOffEnabled: false,
  // C0 rollback lever (i) — Redis derived-data spec §5a item 1 "reverse
  // handoff". While TRUE the race-keyed v2 worker takes no new claims, so the
  // v2 table drains to zero unexpired RUNNING leases within the 30s lease
  // window and the OLD binary can be deployed without two bulk writers ever
  // overlapping. Read PER TICK and UNCACHED (getUncachedFlag) — this flag exists
  // precisely because an env kill switch can't change on a running process, so
  // a 30s cache would blunt exactly the emergency it was built for.
  raceQueueV2ClaimingDisabled: false,
  // C0 rollback lever (ii). While TRUE the legacy `/steps` and `/steps/samples`
  // paths call resolveRaceState INLINE as they always did, instead of only
  // enqueueing. Lever (i) alone would leave persisted totals frozen; this one
  // keeps them converging while staying on the new binary. Default FALSE (the
  // new enqueue-only behavior).
  inlineRaceResolutionFallback: false,
  // Phase B / C1 (Redis derived-data spec §5 Phase B): read-through Redis
  // caching for the near-static catalog/config surfaces (shop catalog, powerup
  // copy catalog, app settings, balance config, global step events, assets
  // manifest) plus pub/sub busting of the legacy per-worker in-process caches.
  // Default OFF: with it off, every one of those surfaces runs its existing
  // Postgres query exactly as before, so the deploy changes nothing.
  redisCacheCatalogsEnabled: false,
  // Phase C / C2 (spec §5 Phase C): read-through cache for the default
  // `GET /races/:id/messages` query shape plus the per-user cosmetics/presentation
  // cache it hydrates from. Any non-default query shape (a cursor, a non-50
  // limit, the merged no-`kind` feed) bypasses the cache entirely. Default OFF.
  redisCacheMessagesEnabled: false,
  // Phase D / C3 (spec §5 Phase D) — the incident fix. Turns `GET
  // /races/:id/progress` into a shared per-race snapshot read (soft 15s /
  // physical 60s) and REMOVES the endpoint's per-poll `race_participants`
  // write-back plus its effect-expiry / high-multiplier / powerup-state side
  // effects (those move to the race-keyed v2 worker). Default OFF: with it off
  // the endpoint runs its existing replay AND its write-back, byte-for-byte as
  // before, and the worker publishes nothing.
  redisStandingsEnabled: false,
  // Phase E / C4 (spec §5 Phase E): read-through caches for the two per-user
  // read surfaces — `GET /friends/steps` (one `v1:user:daily:{id}:{date}` key
  // per friend, 60s) and `GET /powerups/inventory` (`v1:user:inventory:{id}`,
  // 60s). Both invalidate at their write seams (step sync; powerup
  // grant/use/open/discard/purchase), so the TTL is only the backstop. Default
  // OFF: with it off both endpoints run their existing Postgres queries.
  redisCacheUserBitsEnabled: false,
  // Phase E2 / C5 (spec §5 Phase E2): 10s cache of the ASSEMBLED `GET /auth/me`
  // response (`v1:user:authme:{id}:{variant}`). Every field the client re-reads
  // immediately after mutating it is invalidated at its write site — see the
  // classification table at the top of
  // `src/modules/users/services/authMeCache.js`, which per spec §5 step 11 must
  // be reviewed before this flag flips. Default OFF.
  redisCacheAuthMeEnabled: false,
  // Batch 2026-08-10b item 2 (C4): 60s read-through cache for
  // `powerupData.discardCapRemaining` (`v1:user:discardcap:{id}`), invalidated
  // at the discard write seam. Default OFF: with it off the value is computed
  // from Postgres on every progress poll that has a discardable row, which is
  // correct but costs a query. Turning it off can only cost latency, never
  // correctness — the field itself is NEVER gated on Redis being available.
  redisCacheDiscardCapEnabled: false,
  // Social-read optimizations. All default OFF, preserving every existing
  // client path on deploy. Friends/leaderboard additionally require the
  // generation guard so an old DEL-only worker cannot race a guarded fill.
  redisPresentationGenerationGuardEnabled: false,
  redisCacheLeaderboardEnabled: false,
  redisCacheFriendsEnabled: false,
  redisFriendSearchRateLimitEnabled: false,
  // API page-payload cleanup. Every compact/new surface is independently
  // dark by default: absent/failed reads must preserve the byte-compatible
  // legacy path, while disabled additive endpoints return 404 so capable
  // clients can cache their legacy fallback for the process lifetime.
  apiRaceBootstrapV1Enabled: false,
  apiRaceProgressCompactV1Enabled: false,
  apiRaceMessageStreamsV1Enabled: false,
  apiFriendsSummaryV1Enabled: false,
  apiAuthShellV1Enabled: false,
  apiHomeShellV1Enabled: false,
  apiGetCoinsV1Enabled: false,
  apiPublicRaceBrowserV1Enabled: false,
  apiRankedV2CompactV1Enabled: false,
  apiProfileStatsV1Enabled: false,
  // Feature batch 2026-08-17. Capability-gated, default-off contracts; a
  // deployed backend is inert until both the mobile build and operator flag are
  // ready, while old clients simply ignore the additive fields/endpoints.
  apiImpactNoticesEnabled: false,
  apiImpactSummariesEnabled: false,
  apiReviewPromptEnabled: false,
  apiInboxV1Enabled: false,
  redisCacheHomeImpactSummaryEnabled: false,
  redisCacheHomeInboxUnreadEnabled: false,
  homeServiceBannerEnabled: false,
  homeServiceBannerMessage: "",
  apiShopBootstrapV1Enabled: false,
  apiStaticEtagsV1Enabled: false,
  apiTournamentDetailV1Enabled: false,
  // Independent body-free USER watermark cache. This never gates the public
  // message-stream contract; cache failure/unavailability falls back to the
  // bounded Postgres id/createdAt projection.
  apiRaceChatWatermarkCacheV1Enabled: false,
  // Backend-only race-resolution optimizations. These remain independently
  // reversible and default to the deployed full-resolution behavior.
  raceResolutionDisplayArtifactReuseV1Enabled: false,
  raceResolutionReasonAwareV1Enabled: false,
  raceResolutionBurstCoalescingV1Enabled: false,
  // While a race job is still QUEUED and unclaimed, atomically merge another
  // enqueue into that row while retaining its current generation number.
  // Default OFF preserves the deployed one-bump-per-enqueue semantics.
  raceResolutionQueuedGenerationMergeV1Enabled: false,
  raceResolutionBulkWriteV1Enabled: false,
  raceResolutionPostTasksV1Enabled: false,
  // Dependency-closure planner, PHASE 2b SHADOW ONLY. When true the worker
  // computes the closure plan for a closure-candidate envelope and logs it as
  // aggregate `shadow*` fields on the existing race_resolution_v2 line. It
  // selects no plan, writes nothing, and changes no post-commit work — a
  // planner failure is logged and dropped.
  //
  // Deliberately a SEPARATE key from `raceResolutionDependencyClosureV1Enabled`
  // (Phase 3), which will mean "closure WRITES". Reusing one key would silently
  // change its meaning at the Phase 3 deploy: every environment already running
  // the measurement would start writing subset results the moment the new
  // binary rolled, with no separate go/no-go. Shadow code must never read the
  // Phase 3 key, and the Phase 3 key stays undeclared until it exists.
  raceResolutionDependencyClosureShadowV1Enabled: false,
  // Dependency-closure PHASE 3 — closure WRITES. A subset resolution is
  // committed only when BOTH this flag is on AND the planner returns
  // DEPENDENCY_CLOSURE; either alone leaves the job on the existing full path.
  //
  // Independent of the shadow key above, in both directions (spec rollout item
  // 4: "do not flip all resolver flags together"). Turning this on with the
  // shadow off is the normal Phase 3 state — the planner then runs ONCE and
  // serves both the plan decision and the log line. Turning it off mid-queue is
  // the rollback: the next claim takes FULL and nothing is stranded, because a
  // closure generation is only ever committed whole inside the existing fence.
  raceResolutionDependencyClosureV1Enabled: false,
};

function buildAppSettings(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const cacheTtlMs = dependencies.cacheTtlMs ?? 30_000;

  let cache = null;
  let cacheAt = 0;

  async function readRows() {
    const rows = await prisma.appSetting.findMany();
    const byKey = {};
    for (const row of rows) byKey[row.key] = row.value;
    return byKey;
  }

  // C1 (spec §5 Phase B): the in-process TTL cache above is per-worker and
  // therefore cluster-INCOHERENT — a flag flipped on worker A stayed stale on
  // worker B for up to 30s. Two things fix that here:
  //   * the Redis read-through below (shared across workers), and
  //   * `subscribeToInvalidation()`, which busts this process's copy the moment
  //     any worker writes a setting.
  //
  // Bootstrapping note: the flag that enables this cache LIVES in this table, so
  // the very first load of a process (and any load after a bust) must read
  // Postgres — otherwise deciding whether to use the cache would require the
  // cache. That first read is what tells us whether to use Redis from then on.
  async function loadAll() {
    // Registered on EVERY load (idempotent), not only when the flag is on: the
    // pub/sub buster is what makes a peer worker's flip visible here in
    // milliseconds instead of up to `cacheTtlMs`, and a process that has only
    // ever served cache hits must still be listening.
    subscribeToInvalidation();

    const now = Date.now();
    if (cache && now - cacheAt < cacheTtlMs) return cache;

    const lastKnownEnabled = cache
      ? cache.redisCacheCatalogsEnabled === true
      : false;

    let byKey;
    if (lastKnownEnabled) {
      byKey = await derivedCache.cachedRead({
        key: cacheKeys.appSettingsKey,
        prefix: cacheKeys.PREFIX.APP_SETTINGS,
        ttlSeconds: CATALOG_TTL_SECONDS,
        enabled: true,
        load: readRows,
      });
    } else {
      byKey = await readRows();
      // The rows we just read may be the ones that TURN the cache on (first
      // load of a process, or the load right after a bust). Populate the shared
      // copy now so peers and our own next read are served from Redis rather
      // than each re-discovering the flag from Postgres.
      if (byKey.redisCacheCatalogsEnabled === true) {
        const populated = byKey;
        await derivedCache.cachedRead({
          key: cacheKeys.appSettingsKey,
          prefix: cacheKeys.PREFIX.APP_SETTINGS,
          ttlSeconds: CATALOG_TTL_SECONDS,
          enabled: true,
          load: async () => populated,
        });
      }
    }

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

  // Raw stored value of a setting, or undefined if no row exists (NO default
  // substitution). Used by numeric flags (stepSampleBucketMinutes) whose served
  // shape must distinguish "explicitly stored" from "absent" so the client can
  // apply its own fallback. Degrades to undefined on any read failure.
  async function getRawFlag(key) {
    try {
      const all = await loadAll();
      return all[key];
    } catch {
      return undefined;
    }
  }

  // Resolved value of one known flag, read STRAIGHT FROM THE ROW — the 30s
  // process cache is bypassed entirely (and left untouched, so this can never
  // poison it). For emergency levers whose whole purpose is to take effect on a
  // running process within one tick: `raceQueueV2ClaimingDisabled` (C0 reverse
  // handoff) is read this way by the v2 worker on EVERY tick. Any read failure
  // degrades to the declared default, never to undefined.
  async function getUncachedFlag(key) {
    const fallback = KNOWN_FLAGS[key];
    try {
      const row = await prisma.appSetting.findUnique({ where: { key } });
      const value = row?.value;
      if (typeof fallback === "boolean") {
        return typeof value === "boolean" ? value : fallback;
      }
      return value === undefined || value === null ? fallback : value;
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
    if (key === "racePayoutDoubleRolloutPercent") {
      if (!Number.isInteger(value) || value < 0 || value > 100) {
        const err = new Error("racePayoutDoubleRolloutPercent must be an integer from 0 to 100");
        err.statusCode = 400;
        throw err;
      }
      if (value > 0) {
        const healthy = await prisma.jobRun.findUnique({
          where: { jobName: "race-payout-double-reconcile-healthy" },
        });
        if (!healthy) {
          const err = new Error(
            "Race payout double rollout requires one healthy reconciliation run",
          );
          err.statusCode = 409;
          throw err;
        }
      }
    }
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    cache = null; // bust so this process serves the new value immediately
    // C1 invalidation site (spec §5 Phase B): delete the shared copy and tell
    // every peer worker to bust its own in-process copy. Invalidate-only — we
    // never write the new value into Redis from a mutation path (§3).
    await derivedCache.invalidate({
      keys: [cacheKeys.appSettingsKey],
      prefix: cacheKeys.PREFIX.APP_SETTINGS,
    });
  }

  // Settings that form one user-visible contract must never be observed half
  // written. Home's banner is such a pair: an enabled row without a valid
  // message would force every client to guess. Kept separate from setFlag so
  // the legacy boolean-only admin PATCH cannot mutate either key.
  async function setFlagsAtomically(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      const err = new Error("No settings supplied");
      err.statusCode = 400;
      throw err;
    }
    for (const [key] of entries) {
      if (!(key in KNOWN_FLAGS)) {
        const err = new Error(`Unknown setting: ${key}`);
        err.statusCode = 400;
        throw err;
      }
    }
    await prisma.$transaction(
      entries.map(([key, value]) =>
        prisma.appSetting.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        })
      )
    );
    cache = null;
    await derivedCache.invalidate({
      keys: [cacheKeys.appSettingsKey],
      prefix: cacheKeys.PREFIX.APP_SETTINGS,
    });
  }

  // Peer-worker coherence: any worker's `setFlag` busts this one's copy.
  // Registered lazily on first use so merely requiring this module never opens
  // a socket (the wrapper's inertness contract).
  let unsubscribe = null;
  function subscribeToInvalidation() {
    if (unsubscribe) return unsubscribe;
    unsubscribe = derivedCache.onInvalidate(cacheKeys.PREFIX.APP_SETTINGS, () => {
      cache = null;
    });
    return unsubscribe;
  }

  // Force the next read to hit the DB. setFlag already busts on write; this is
  // for out-of-band mutations (a peer process, or a test writing app_settings
  // directly) that need immediate read-through in THIS process.
  function bustCache() {
    cache = null;
  }

  return {
    getFlag,
    getRawFlag,
    getUncachedFlag,
    getAllFlags,
    setFlag,
    setFlagsAtomically,
    bustCache,
    subscribeToInvalidation,
    KNOWN_FLAGS,
  };
}

const appSettings = buildAppSettings();

module.exports = { buildAppSettings, appSettings, KNOWN_FLAGS };
