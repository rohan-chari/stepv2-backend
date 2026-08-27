const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const {
  getHomeRaceCard: defaultGetHomeRaceCard,
} = require("./getHomeRaceCard");
const {
  GlobalStepEvent: defaultGlobalStepEvent,
} = require("../steps/models/globalStepEvent");
const {
  getStepMilestonesToday: defaultGetStepMilestonesToday,
} = require("../steps/queries/getStepMilestonesToday");
const {
  getAdExtraSpinStatus: defaultGetAdExtraSpinStatus,
} = require("../economy/queries/getAdExtraSpinStatus");
const defaultAdRewardsConfig = require("../economy/adRewards");
const { appSettings } = require("../../shared/config/appSettings");
const { getNextRaceHome } = require("../races/queries/getNextRaceHome");
const { supportsNextRace } = require("../races/services/nextRacePolicy");
const { supportsBuckets: supportsSeededRaceBuckets } = require("../races/services/seededRaceBuckets");
const {
  getSuggestedRaces: defaultGetSuggestedRaces,
} = require("./queries/getSuggestedRaces");
const {
  getHomeShellPresentation: defaultGetHomeShellPresentation,
} = require("./queries/getHomeShellPresentation");
const {
  getFriendsSummary: defaultGetFriendsSummary,
} = require("../social/queries/getFriendsSummary");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");
const { prisma: defaultPrisma } = require("../../db");
const derivedCache = require("../../shared/cache/derivedCache");
const cacheKeys = require("../../shared/cache/cacheKeys");
const { getInboxUnreadCount } = require("../inbox");
const { buildHomeRaceCardResponse } = require("./buildHomeRaceCardResponse");
const {
  getEligibleGlobalEventSummary,
} = require("./queries/getEligibleGlobalEventSummary");
const {
  getCachedGlobalEventSummary,
} = require("./services/globalEventSummaryCache");
const { buildServiceBanner } = require("./services/buildServiceBanner");
const {
  resolveActiveContestBanner: defaultResolveActiveContestBanner,
} = require("../giveaways");

function createHomeRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const getHomeRaceCard =
    dependencies.getHomeRaceCard || defaultGetHomeRaceCard;
  const globalStepEventModel =
    dependencies.GlobalStepEvent || defaultGlobalStepEvent;
  const getStepMilestonesToday =
    dependencies.getStepMilestonesToday || defaultGetStepMilestonesToday;
  const getAdExtraSpinStatus =
    dependencies.getAdExtraSpinStatus || defaultGetAdExtraSpinStatus;
  const adRewardsConfig = dependencies.adRewardsConfig || defaultAdRewardsConfig;
  const getNextRaceHomeFn = dependencies.getNextRaceHome || getNextRaceHome;
  const getSuggestedRaces =
    dependencies.getSuggestedRaces ||
    (dependencies.getFeaturedRaces ||
    dependencies.getPublicRaces ||
    dependencies.getPublicTournaments ||
    dependencies.logger
      ? require("./queries/getSuggestedRaces").buildGetSuggestedRaces(dependencies)
      : defaultGetSuggestedRaces);
  const getHomeShellPresentation =
    dependencies.getHomeShellPresentation || defaultGetHomeShellPresentation;
  const getFriendsSummary =
    dependencies.getFriendsSummary || defaultGetFriendsSummary;
  const settings = dependencies.appSettings || appSettings;
  const prisma = dependencies.prisma || defaultPrisma;
  const nowFn = dependencies.now || (() => new Date());
  const resolveActiveContestBanner =
    dependencies.resolveActiveContestBanner || defaultResolveActiveContestBanner;
  const assembleHomeRaceCard = dependencies.buildHomeRaceCardResponse ||
    buildHomeRaceCardResponse({
      getHomeRaceCard,
      getHomeShellPresentation,
      getFriendsSummary,
      getNextRaceHome: getNextRaceHomeFn,
      GlobalStepEvent: globalStepEventModel,
      getStepMilestonesToday,
      getAdExtraSpinStatus,
      getInboxUnreadCount: dependencies.getInboxUnreadCount || getInboxUnreadCount,
      adRewardsConfig,
      appSettings: settings,
      prisma,
      resolveActiveContestBanner,
      logger: dependencies.logger || console,
    });

  router.use(requireAuth);

  router.get(
    "/suggested-races",
    asyncHandler(async (req, res) => {
      const result = await getSuggestedRaces({
        userId: req.user.id,
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        supportsTournaments:
          req.clientFeatures?.has("tournaments") ?? false,
        supportsBuckets:
          // The stamped window, resolved by the race query, is authoritative;
          // the live flag is only a creation-time input and must not hide an
          // already-selected private stream after a rollback.
          supportsSeededRaceBuckets(req.clientFeatures),
      });
      res.json(result);
    })
  );

  router.get("/race-card", async (req, res) => {
    try {
      const compact =
        req.query.view === "shell-v1" &&
        (await isStrictFlagEnabled(settings, "apiHomeShellV1Enabled"));
      // Opt-in flag set only by new app builds. Without it, response is the
      // legacy single-state shape so older clients are unaffected.
      const homeActiveRaces =
        req.query.homeActiveRaces === "1" || req.query.homeActiveRaces === "true";
      // §6.3 opt-in: only meaningful together with homeActiveRaces. Old clients
      // never send it and keep the live-computation path.
      const homePersistedTotals =
        req.query.homePersistedTotals === "1" ||
        req.query.homePersistedTotals === "true";
      const [leanLiveEnabled, snapshotReuseEnabled] = await Promise.all([
        isStrictFlagEnabled(settings, "homeRaceCardLeanLiveV1Enabled"),
        isStrictFlagEnabled(settings, "homeRaceCardSnapshotReuseV1Enabled"),
      ]);
      const current = nowFn();
      if (
        await isStrictFlagEnabled(
          settings,
          "homeRaceCardParallelOptionalV1Enabled"
        )
      ) {
        const result = await assembleHomeRaceCard({
          user: req.user,
          timeZone: req.timeZone,
          releaseChannel: req.releaseChannel,
          supportsCharacters: req.clientFeatures?.has("characters") ?? false,
          supportsRemoteAssets:
            req.clientFeatures?.has("remote_assets") ?? false,
          supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
          supportsNextRace: supportsNextRace(req.clientFeatures),
          supportsAds: req.clientFeatures?.has("ads") ?? false,
          supportsImpactSummaries:
            req.clientFeatures?.has("impact_summaries") === true &&
            req.clientFeatures?.has("impact_summary_expiry_v1") === true,
          supportsInbox: req.clientFeatures?.has("inbox_v1") ?? false,
          supportsReferralContest:
            req.clientFeatures?.has("referral_contest_v1") ?? false,
          supportsGlobalReferralContest:
            req.clientFeatures?.has("referral_contest_global_v1") ?? false,
          compactShell: compact,
          homeActiveRaces,
          homePersistedTotals,
          localDate: req.query.localDate,
          leanLiveEnabled,
          snapshotReuseEnabled,
          now: current,
        });
        return res.json(result);
      }
      const optionalShellPromises = compact
        ? [
            getHomeShellPresentation({
              userId: req.user.id,
              coins: req.user.coins,
              channel: req.releaseChannel,
              supportsCharacters:
                req.clientFeatures?.has("characters") ?? false,
              supportsRemoteAssets:
                req.clientFeatures?.has("remote_assets") ?? false,
            }),
            getFriendsSummary(req.user.id),
          ]
        : null;
      const result = await getHomeRaceCard({
        userId: req.user.id,
        homeActiveRaces,
        homePersistedTotals,
        // Match getRaceProgress: window race steps in the caller's timezone
        // (set globally by the extractTimezone middleware) so the home card and
        // the race-detail screen compute identical race-relative totals.
        timeZone: req.timeZone,
        supportsCharacters: req.clientFeatures?.has("characters") ?? false,
        supportsRemoteAssets: req.clientFeatures?.has("remote_assets") ?? false,
        // Batch 2026-07-26, item 8: TestFlight viewers see test-only characters.
        releaseChannel: req.releaseChannel,
        // TR-702/809: old clients never get a team race on the Home card.
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        leanLiveEnabled,
        snapshotReuseEnabled,
      });

      // Character powers were removed. The key is still sent (always false) so
      // frozen 2.0.x clients — which render the home character-power chip when
      // it is present and true — keep hiding the chip against this backend.
      result.characterPowersEnabled = false;

      // Capability + flag gate is deliberately outside getHomeRaceCard: a
      // frozen client performs none of the new eligibility/discovery queries.
      if (supportsNextRace(req.clientFeatures)) {
        try {
          const [discoveryEnabled, createEnabled] = await Promise.all([
            settings.getFlag("openUserRaceDiscoveryEnabled"),
            settings.getFlag("quickCreateRaceCtaEnabled"),
          ]);
          result.nextRace =
            discoveryEnabled || createEnabled
              ? await getNextRaceHomeFn({
                  userId: req.user.id,
                  discoveryEnabled,
                  createEnabled,
                })
              : {
                  resolved: true,
                  eligible: false,
                  discoveryEnabled: false,
                  createEnabled: false,
                  openRaces: [],
                };
        } catch (error) {
          console.error("Build Home nextRace error:", error);
          result.nextRace = {
            resolved: false,
            eligible: false,
            discoveryEnabled: false,
            createEnabled: false,
            openRaces: [],
          };
        }
      }

      // Additive: surface the currently-active global step event (if any) as a
      // top-level field of the EXACT same shape getRaceProgress uses, so the new
      // app can render a "2x STEPS — ends in mm:ss" home banner. Old apps ignore
      // the unknown field. Wrapped in try/catch so a DB hiccup never breaks the
      // home card — we just omit the banner.
      try {
        // C1: the cached display variant (falls back to findActiveAt when the
        // flag is off, Redis is down, or an injected test model lacks it).
        // Settlement paths keep calling findActiveInRange/findActiveAt directly.
        const viewerEvent = typeof globalStepEventModel.findViewerActiveHomeCached === "function"
          ? await globalStepEventModel.findViewerActiveHomeCached({
              userId: req.user.id,
              now: current,
            })
          : null;
        const activeEvent = viewerEvent ||
          (typeof globalStepEventModel.findActiveAtCached === "function"
            ? await globalStepEventModel.findActiveAtCached(current)
            : await globalStepEventModel.findActiveAt(current));
        if (activeEvent) {
          result.globalEvent = {
            active: true,
            multiplier: Number(activeEvent.multiplier),
            endsAt: activeEvent.endsAt,
          };
        }
      } catch (eventError) {
        console.error("Home race-card globalEvent lookup error:", eventError);
      }

      // Additive: when the client sends its local date (new app builds only),
      // embed the step-milestones card data — the EXACT shape of
      // GET /users/me/step-milestones/today — so the claim-rewards card loads
      // in the same response as the rest of the home page instead of racing a
      // 7th request on slow connections. Old builds don't send localDate and
      // keep using the standalone endpoint. A failure just omits the field;
      // the app falls back to the standalone fetch.
      const localDate = req.query.localDate;
      if (localDate) {
        try {
          result.stepMilestones = await getStepMilestonesToday({
            userId: req.user.id,
            localDate,
          });
        } catch (milestoneError) {
          console.error("Home race-card stepMilestones lookup error:", milestoneError);
        }
        // Additive: daily-reward CLAIM/CLAIMED button state, derived from the
        // user row requireAuth already loaded (zero extra queries). Same
        // fallback story as stepMilestones: when the field is absent (old
        // backend) the app's StreakChip falls back to its standalone fetch.
        result.dailyReward = {
          claimedToday: req.user.lastDailyClaimDate === localDate,
          localDate,
        };
        // Additive: rewarded-ad extra-spin state for the home button, only
        // for ads-capable clients and only once today's box is claimed (the
        // extra spin can't exist before the free one). Failure omits the
        // field; the chip just shows the plain CLAIMED state.
        if (
          result.dailyReward.claimedToday &&
          adRewardsConfig.ADS_EXTRA_SPIN_ENABLED &&
          req.clientFeatures?.has("ads")
        ) {
          try {
            result.dailyReward.adExtraSpin = await getAdExtraSpinStatus({
              userId: req.user.id,
              localDate,
            });
          } catch (adError) {
            console.error("Home race-card adExtraSpin lookup error:", adError);
          }
        }
      }

      // All additions below are viewer-bound and capability gated. Their
      // absence is the old-backend downgrade path for a carrying app build.
      if (
        req.clientFeatures?.has("impact_summaries") === true &&
        req.clientFeatures?.has("impact_summary_expiry_v1") === true &&
        (await isStrictFlagEnabled(settings, "apiImpactSummariesEnabled"))
      ) {
        try {
          const summary = await getCachedGlobalEventSummary({
            key: cacheKeys.homeImpactSummary(req.user.id),
            enabled: await isStrictFlagEnabled(settings, "redisCacheHomeImpactSummaryEnabled"),
            load: () => getEligibleGlobalEventSummary({ prisma, userId: req.user.id }),
          });
          if (summary) result.globalEventSummary = summary;
        } catch (summaryError) {
          console.error("Home race-card globalEventSummary lookup error:", summaryError);
        }
      }

      if (
        req.clientFeatures?.has("inbox_v1") === true &&
        (await isStrictFlagEnabled(settings, "apiInboxV1Enabled"))
      ) {
        const now = current;
        result.inboxUnreadCount = await derivedCache.cachedRead({
          key: cacheKeys.homeInboxUnread(req.user.id),
          prefix: cacheKeys.PREFIX.HOME_INBOX_UNREAD,
          ttlSeconds: 60,
          enabled: await isStrictFlagEnabled(settings, "redisCacheHomeInboxUnreadEnabled"),
          load: () => getInboxUnreadCount({ userId: req.user.id, now, prisma }),
        });
      }

      const supportsReferralContest =
        req.clientFeatures?.has("referral_contest_v1") ?? false;
      const automaticBanner = supportsReferralContest
        ? await resolveActiveContestBanner({ prisma, now: current, includeEligibilityMode: true })
        : null;
      if (automaticBanner && (automaticBanner.eligibilityMode !== "BARA_ACCOUNT" || req.clientFeatures?.has("referral_contest_global_v1") === true)) {
        delete automaticBanner.eligibilityMode;
        result.homeGiveawayBanner = automaticBanner;
      }
      const serviceBanner = await buildServiceBanner({
        settings,
        prisma,
        supportsReferralContest,
        now: current,
      });
      if (serviceBanner) result.homeServiceBanner = serviceBanner;

      if (optionalShellPromises) {
        const [presentation, friends] = await Promise.allSettled(
          optionalShellPromises
        );
        result.contract = "home-shell-v1";
        result.resolved = {
          presentation: presentation.status === "fulfilled",
          friends: friends.status === "fulfilled",
        };
        result.presentation =
          presentation.status === "fulfilled" ? presentation.value : null;
        result.friends = friends.status === "fulfilled" ? friends.value : null;
      }
      res.json(result);
    } catch (error) {
      console.error("Home race-card error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/global-event-summary-work/:id", asyncHandler(async (req, res) => {
    const capable =
      req.clientFeatures?.has("impact_summaries") === true &&
      req.clientFeatures?.has("impact_summary_expiry_v1") === true;
    if (!capable) {
      return res.status(404).json({ error: "Summary work not found", code: "NOT_FOUND" });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(400).json({ error: "Invalid work id", code: "INVALID_ID" });
    }
    let work;
    if (typeof prisma.$queryRawUnsafe === "function") {
      [work] = await prisma.$queryRawUnsafe(
        `SELECT status, expires_at AS "expiresAt",
                expires_at <= (statement_timestamp() AT TIME ZONE 'UTC') AS expired
           FROM global_event_summary_work
          WHERE id = $1 AND user_id = $2
          LIMIT 1`,
        req.params.id,
        req.user.id,
      );
    } else {
      work = await prisma.globalEventSummaryWork.findFirst({
        where: { id: req.params.id, userId: req.user.id },
        select: { status: true, expiresAt: true },
      });
    }
    if (!work) {
      return res.status(404).json({ error: "Summary work not found", code: "NOT_FOUND" });
    }
    const activeStates = new Set(["WAITING_SYNC", "QUEUED", "PROCESSING", "WAITING_RACES"]);
    const state = work.expired === true && activeStates.has(work.status)
      ? "EXPIRED_UNDELIVERED"
      : work.status;
    return res.json({ state, expiresAt: work.expiresAt });
  }));

  router.post("/global-event-summaries/:id/acknowledge", asyncHandler(async (req, res) => {
    const enabled = req.clientFeatures?.has("impact_summaries") === true &&
      (await isStrictFlagEnabled(settings, "apiImpactSummariesEnabled"));
    if (!enabled) return res.status(404).json({ error: "Global event summaries are unavailable", code: "FEATURE_DISABLED" });
    const existing = await prisma.globalEventUserSummary.findFirst({
      where: { id: req.params.id, userId: req.user.id }, select: { id: true, acknowledgedAt: true },
    });
    if (!existing) return res.status(404).json({ error: "Summary not found", code: "NOT_FOUND" });
    if (existing.acknowledgedAt) return res.status(409).json({ error: "Summary already acknowledged", code: "ALREADY_ACKNOWLEDGED" });
    const updated = await prisma.globalEventUserSummary.updateMany({
      where: { id: existing.id, userId: req.user.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() },
    });
    if (updated.count !== 1) return res.status(409).json({ error: "Summary already acknowledged", code: "ALREADY_ACKNOWLEDGED" });
    await derivedCache.invalidate({ keys: [cacheKeys.homeImpactSummary(req.user.id)], prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY });
    return res.json({ acknowledged: true });
  }));

  return router;
}

module.exports = { createHomeRouter };
