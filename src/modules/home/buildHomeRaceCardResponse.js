const derivedCache = require("../../shared/cache/derivedCache");
const cacheKeys = require("../../shared/cache/cacheKeys");
const { isStrictFlagEnabled } = require("../../shared/config/isStrictFlagEnabled");
const {
  getEligibleGlobalEventSummary,
} = require("./queries/getEligibleGlobalEventSummary");
const { buildServiceBanner } = require("./services/buildServiceBanner");

async function settle(task, logger, label) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    logger.error?.(`Home race-card ${label} error:`, error);
    return { ok: false, value: null };
  }
}

function buildHomeRaceCardResponse(dependencies) {
  const {
    getHomeRaceCard,
    getHomeShellPresentation,
    getFriendsSummary,
    getNextRaceHome,
    GlobalStepEvent,
    getStepMilestonesToday,
    getAdExtraSpinStatus,
    getInboxUnreadCount,
    adRewardsConfig,
    appSettings,
    prisma,
    logger = console,
  } = dependencies;

  return async function assemble(params) {
    const {
      user,
      timeZone,
      releaseChannel,
      supportsCharacters,
      supportsRemoteAssets,
      supportsTeamRaces,
      supportsNextRace,
      supportsAds,
      supportsImpactSummaries,
      supportsInbox,
      supportsReferralContest,
      compactShell,
      homeActiveRaces,
      homePersistedTotals,
      localDate,
      leanLiveEnabled,
      snapshotReuseEnabled,
    } = params;

    // Wave 1: the core card and the two optional shell branches. At most three
    // DB-backed tasks are in flight; absent branches are resolved no-ops.
    const [core, presentation, friends] = await Promise.all([
      settle(() => getHomeRaceCard({
        userId: user.id,
        homeActiveRaces,
        homePersistedTotals,
        timeZone,
        supportsCharacters,
        supportsRemoteAssets,
        releaseChannel,
        supportsTeamRaces,
        leanLiveEnabled,
        snapshotReuseEnabled,
      }), logger, "core"),
      compactShell
        ? settle(() => getHomeShellPresentation({
            userId: user.id,
            coins: user.coins,
            channel: releaseChannel,
            supportsCharacters,
            supportsRemoteAssets,
          }), logger, "presentation")
        : Promise.resolve({ ok: true, value: null }),
      compactShell
        ? settle(() => getFriendsSummary(user.id), logger, "friends")
        : Promise.resolve({ ok: true, value: null }),
    ]);
    if (!core.ok) throw new Error("Home race-card core unavailable");
    const result = core.value;
    result.characterPowersEnabled = false;

    const dailyReward = localDate
      ? {
          claimedToday: user.lastDailyClaimDate === localDate,
          localDate,
        }
      : null;

    // Wave 2: next-race resolution, global event, and milestones.
    const [nextRace, activeEvent, milestones] = await Promise.all([
      supportsNextRace
        ? settle(async () => {
            const [discoveryEnabled, createEnabled] = await Promise.all([
              appSettings.getFlag("openUserRaceDiscoveryEnabled"),
              appSettings.getFlag("quickCreateRaceCtaEnabled"),
            ]);
            return discoveryEnabled || createEnabled
              ? getNextRaceHome({
                  userId: user.id,
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
          }, logger, "nextRace")
        : Promise.resolve({ ok: true, value: null }),
      settle(async () => {
        const current = new Date();
        if (typeof GlobalStepEvent.findViewerActiveHomeCached === "function") {
          const local = await GlobalStepEvent.findViewerActiveHomeCached({
            userId: user.id,
            now: current,
          });
          if (local) return local;
        }
        return typeof GlobalStepEvent.findActiveAtCached === "function"
          ? GlobalStepEvent.findActiveAtCached(current)
          : GlobalStepEvent.findActiveAt(current);
      }, logger, "globalEvent lookup"),
      localDate
        ? settle(() => getStepMilestonesToday({
            userId: user.id,
            localDate,
          }), logger, "stepMilestones lookup")
        : Promise.resolve({ ok: true, value: null }),
    ]);
    if (supportsNextRace) {
      result.nextRace = nextRace.ok
        ? nextRace.value
        : {
            resolved: false,
            eligible: false,
            discoveryEnabled: false,
            createEnabled: false,
            openRaces: [],
          };
    }
    if (activeEvent.ok && activeEvent.value) {
      result.globalEvent = {
        active: true,
        multiplier: Number(activeEvent.value.multiplier),
        endsAt: activeEvent.value.endsAt,
      };
    }
    if (localDate) {
      if (milestones.ok) result.stepMilestones = milestones.value;
      result.dailyReward = dailyReward;
    }

    // Wave 3: ad status, impact summary, and inbox count.
    const [adStatus, impactSummary, inboxCount] = await Promise.all([
      dailyReward?.claimedToday === true &&
      adRewardsConfig.ADS_EXTRA_SPIN_ENABLED && supportsAds
        ? settle(() => getAdExtraSpinStatus({
            userId: user.id,
            localDate,
          }), logger, "adExtraSpin lookup")
        : Promise.resolve({ ok: true, value: null }),
      supportsImpactSummaries
        ? (async () => {
            if (!(await isStrictFlagEnabled(appSettings, "apiImpactSummariesEnabled"))) {
              return null;
            }
            return derivedCache.cachedRead({
              key: cacheKeys.homeImpactSummary(user.id),
              prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
              ttlSeconds: 60,
              enabled: await isStrictFlagEnabled(
                appSettings,
                "redisCacheHomeImpactSummaryEnabled"
              ),
              load: () => getEligibleGlobalEventSummary({ prisma, userId: user.id }),
            });
          })()
        : Promise.resolve(null),
      supportsInbox
        ? (async () => {
            if (!(await isStrictFlagEnabled(appSettings, "apiInboxV1Enabled"))) {
              return null;
            }
            const now = new Date();
            return derivedCache.cachedRead({
              key: cacheKeys.homeInboxUnread(user.id),
              prefix: cacheKeys.PREFIX.HOME_INBOX_UNREAD,
              ttlSeconds: 60,
              enabled: await isStrictFlagEnabled(
                appSettings,
                "redisCacheHomeInboxUnreadEnabled"
              ),
              load: () => getInboxUnreadCount({ userId: user.id, now, prisma }),
            });
          })()
        : Promise.resolve(null),
    ]);
    if (dailyReward && adStatus.ok && adStatus.value != null) {
      dailyReward.adExtraSpin = adStatus.value;
    }
    if (impactSummary) {
      result.globalEventSummary = impactSummary;
    }
    if (typeof inboxCount === "number") {
      result.inboxUnreadCount = inboxCount;
    }

    // Wave 4: service settings and assembly of already-settled results.
    const serviceBanner = await buildServiceBanner({
      settings: appSettings,
      prisma,
      supportsReferralContest,
    });
    if (serviceBanner) result.homeServiceBanner = serviceBanner;
    if (compactShell) {
      result.contract = "home-shell-v1";
      result.resolved = {
        presentation: presentation.ok,
        friends: friends.ok,
      };
      result.presentation = presentation.ok ? presentation.value : null;
      result.friends = friends.ok ? friends.value : null;
    }
    return result;
  };
}

module.exports = { buildHomeRaceCardResponse };
