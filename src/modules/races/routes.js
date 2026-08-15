const { Router } = require("express");
const { buildRequireAuth } = require("../../middleware/requireAuth");
const { createRace: defaultCreateRace } = require("./commands/createRace");
const {
  inviteToRace: defaultInviteToRace,
} = require("./commands/inviteToRace");
const {
  respondToRaceInvite: defaultRespondToRaceInvite,
} = require("./commands/respondToRaceInvite");
const {
  buildJoinPublicRace,
  joinPublicRace: defaultJoinPublicRace,
} = require("./commands/joinPublicRace");
const {
  buildJoinRaceByShareToken,
  joinRaceByShareToken: defaultJoinRaceByShareToken,
} = require("./commands/joinRaceByShareToken");
const {
  createRaceShareLink: defaultCreateRaceShareLink,
} = require("./commands/createRaceShareLink");
const {
  getSharedRacePreview: defaultGetSharedRacePreview,
} = require("./queries/getSharedRacePreview");
const { buildShareUrl } = require("../web").sharing;
const {
  kickRaceParticipant: defaultKickRaceParticipant,
} = require("./commands/kickRaceParticipant");
const {
  getPublicRaces: defaultGetPublicRaces,
} = require("./queries/getPublicRaces");
const {
  getFeaturedRaces: defaultGetFeaturedRaces,
} = require("./queries/getFeaturedRaces");
const { buildStartRace, startRace: defaultStartRace } = require("./commands/startRace");
const { cancelRace: defaultCancelRace } = require("./commands/cancelRace");
const { editRace: defaultEditRace } = require("./commands/editRace");
const {
  switchRaceTeam: defaultSwitchRaceTeam,
} = require("./commands/switchRaceTeam");
const { leaveRace: defaultLeaveRace } = require("./commands/leaveRace");
const { forfeitRace: defaultForfeitRace } = require("./commands/forfeitRace");
const {
  generateTeamNamePair: defaultGenerateTeamNamePair,
} = require("./constants/teamNames");
const {
  usePowerup: defaultUsePowerup,
} = require("../powerups");
const {
  discardPowerup: defaultDiscardPowerup,
} = require("../powerups");
const {
  openMysteryBox: defaultOpenMysteryBox,
} = require("../powerups");
const {
  openMysteryBoxBatch: defaultOpenMysteryBoxBatch,
} = require("../powerups");
const {
  rerollMysteryBox: defaultRerollMysteryBox,
} = require("../powerups");
const {
  rerollMysteryBoxBatch: defaultRerollMysteryBoxBatch,
} = require("../powerups");
const {
  redeemPowerupToRace: defaultRedeemPowerupToRace,
} = require("../powerups");
const { getRaces: defaultGetRaces } = require("./queries/getRaces");
const {
  getRaceInvitePreflight: defaultGetRaceInvitePreflight,
} = require("./queries/getRaceInvitePreflight");
const {
  buildSeededRaceBuckets,
  SeededBucketError,
  supportsBuckets: supportsSeededRaceBuckets,
} = require("./services/seededRaceBuckets");
const {
  getRacePayoutDoubleOffer: defaultGetRacePayoutDoubleOffer,
  buildGetRacePayoutDoubleOffer,
} = require("./queries/getRacePayoutDoubleOffer");
const {
  createRacePayoutDoubleOffer: defaultCreateRacePayoutDoubleOffer,
  buildCreateRacePayoutDoubleOffer,
} = require("./commands/createRacePayoutDoubleOffer");
const {
  claimRacePayoutDouble: defaultClaimRacePayoutDouble,
  buildClaimRacePayoutDouble,
} = require("./commands/claimRacePayoutDouble");
const {
  RacePayoutDouble: defaultRacePayoutDoubleModel,
  buildRacePayoutDoubleModel,
} = require("./models/racePayoutDouble");
const { asyncHandler } = require("../../shared/http/asyncHandler");
const {
  safeStructuredEvent,
} = require("./services/racePayoutDoublePolicy");
const {
  getTournamentsForUser: defaultGetTournamentsForUser,
} = require("../tournaments/queries/getTournamentsForUser");
const {
  getPublicTournaments: defaultGetPublicTournaments,
} = require("../tournaments/queries/getPublicTournaments");
const {
  getRaceDiscoverySummary: defaultGetRaceDiscoverySummary,
} = require("./queries/getRaceDiscoverySummary");
const {
  getRaceDetails: defaultGetRaceDetails,
} = require("./queries/getRaceDetails");
const {
  getRaceProgress: defaultGetRaceProgress,
} = require("./queries/getRaceProgress");
const {
  getSneakySwapTargets: defaultGetSneakySwapTargets,
  buildGetSneakySwapTargets,
} = require("./queries/getSneakySwapTargets");
const {
  getRaceInventory: defaultGetRaceInventory,
} = require("../powerups");
const {
  getRaceFeed: defaultGetRaceFeed,
} = require("./queries/getRaceFeed");
const {
  getRaceMessages: defaultGetRaceMessages,
  getRaceMessageStreams: defaultGetRaceMessageStreams,
} = require("../social");
const {
  getPowerupInventory: defaultGetPowerupInventory,
} = require("../powerups");
const {
  sendRaceMessage: defaultSendRaceMessage,
} = require("../social");
const {
  deleteRaceMessage: defaultDeleteRaceMessage,
} = require("../social");
const {
  setRaceChatMute: defaultSetRaceChatMute,
  markRaceChatRead: defaultMarkRaceChatRead,
} = require("./commands/setRaceChatMute");
const {
  setRacePlacementMute: defaultSetRacePlacementMute,
} = require("./commands/setRacePlacementMute");
const {
  markRaceResultsSeen: defaultMarkRaceResultsSeen,
} = require("./commands/markRaceResultsSeen");
const { Race: defaultRaceModel } = require("./models/race");
const { User: defaultUserModel } = require("../users");
const { RacePowerup: defaultPowerupModel } = require("../powerups");
const {
  RaceActiveEffect: defaultEffectModel,
} = require("../powerups");
const {
  supportsNextRace,
  hasAnyQuickMetadata,
  withQuickMembershipLock,
  hasLiveUserCreatedRace,
} = require("./services/nextRacePolicy");
const { appSettings } = require("../../shared/config/appSettings");
const {
  getOrCreateReferralCode,
} = require("../social/commands/getOrCreateReferralCode");
const {
  isStrictFlagEnabled,
} = require("../../shared/config/isStrictFlagEnabled");

// A powerup is STEALABLE via Sneaky Swap only if it is currently HELD and its
// type is neither SNEAKY_SWAP (not stealable in either direction) nor
// MYSTERY_BOX (an unopened box isn't stealable). Callers that pass already-held
// rows can rely on type alone; we still guard on status defensively.
function isStealable(powerup) {
  if (!powerup) return false;
  if (powerup.status && powerup.status !== "HELD") return false;
  return powerup.type !== "SNEAKY_SWAP" && powerup.type !== "MYSTERY_BOX";
}

function beginRacePerformance(queryCounter) {
  return {
    startedAt: process.hrtime.bigint(),
    queryCounter,
    queryStart:
      queryCounter && typeof queryCounter.snapshot === "function"
        ? queryCounter.snapshot()
        : null,
  };
}

function logRacePerformance(logger, endpoint, performance, fields = {}) {
  const queryEnd =
    performance.queryStart != null &&
    typeof performance.queryCounter?.snapshot === "function"
      ? performance.queryCounter.snapshot()
      : null;
  logger.log?.("[PERF] race endpoint", {
    endpoint,
    durationMs:
      Number(process.hrtime.bigint() - performance.startedAt) / 1e6,
    ...(queryEnd != null
      ? { dbQueryCount: Math.max(0, queryEnd - performance.queryStart) }
      : {}),
    ...fields,
  });
}

function createRacesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const performanceQueryCounter = dependencies.performanceQueryCounter || null;

  const createRace = dependencies.createRace || defaultCreateRace;
  const inviteToRace = dependencies.inviteToRace || defaultInviteToRace;
  const respondToRaceInvite =
    dependencies.respondToRaceInvite || defaultRespondToRaceInvite;
  const joinPublicRace =
    dependencies.joinPublicRace ||
    (dependencies.beforeCommitRaceStart || dependencies.beforeRaceStartedRecord
      ? buildJoinPublicRace(dependencies)
      : defaultJoinPublicRace);
  const joinRaceByShareToken =
    dependencies.joinRaceByShareToken ||
    (dependencies.beforeCommitRaceStart ||
    dependencies.beforeRaceStartedRecord ||
    dependencies.beforeAutoFriendWrite ||
    dependencies.prisma
      ? buildJoinRaceByShareToken(dependencies)
      : defaultJoinRaceByShareToken);
  const createRaceShareLink =
    dependencies.createRaceShareLink || defaultCreateRaceShareLink;
  const getSharedRacePreview =
    dependencies.getSharedRacePreview || defaultGetSharedRacePreview;
  const kickRaceParticipant =
    dependencies.kickRaceParticipant || defaultKickRaceParticipant;
  const getPublicRaces =
    dependencies.getPublicRaces || defaultGetPublicRaces;
  const getFeaturedRaces =
    dependencies.getFeaturedRaces || defaultGetFeaturedRaces;
  const startRace =
    dependencies.startRace ||
    (dependencies.beforeCommitRaceStart || dependencies.beforeRaceStartedRecord
      ? buildStartRace(dependencies)
      : defaultStartRace);
  const cancelRace = dependencies.cancelRace || defaultCancelRace;
  const editRace = dependencies.editRace || defaultEditRace;
  const switchRaceTeam = dependencies.switchRaceTeam || defaultSwitchRaceTeam;
  const leaveRace = dependencies.leaveRace || defaultLeaveRace;
  const forfeitRace = dependencies.forfeitRace || defaultForfeitRace;
  const generateTeamNamePair =
    dependencies.generateTeamNamePair || defaultGenerateTeamNamePair;
  const getRaces = dependencies.getRaces || defaultGetRaces;
  const getRaceInvitePreflight =
    dependencies.getRaceInvitePreflight || defaultGetRaceInvitePreflight;
  const settings = dependencies.appSettings || appSettings;
  const seededBuckets = dependencies.seededBuckets || buildSeededRaceBuckets(dependencies);
  const racePayoutDoubleModel =
    dependencies.RacePayoutDouble ||
    (dependencies.prisma
      ? buildRacePayoutDoubleModel(dependencies)
      : defaultRacePayoutDoubleModel);
  const getRacePayoutDoubleOffer =
    dependencies.getRacePayoutDoubleOffer ||
    (dependencies.prisma || dependencies.appSettings || dependencies.adRewardsConfig
      ? buildGetRacePayoutDoubleOffer({
          ...dependencies,
          RacePayoutDouble: racePayoutDoubleModel,
        })
      : defaultGetRacePayoutDoubleOffer);
  const createRacePayoutDoubleOffer =
    dependencies.createRacePayoutDoubleOffer ||
    (dependencies.prisma || dependencies.adRewardsConfig
      ? buildCreateRacePayoutDoubleOffer(dependencies)
      : defaultCreateRacePayoutDoubleOffer);
  const claimRacePayoutDouble =
    dependencies.claimRacePayoutDouble ||
    (dependencies.prisma ||
    dependencies.adRewardsConfig ||
    dependencies.awardCoins ||
    dependencies.beforeRacePayoutDoubleCommit ||
    dependencies.onRacePayoutDoubleError
      ? buildClaimRacePayoutDouble(dependencies)
      : defaultClaimRacePayoutDouble);
  const getTournamentsForUser =
    dependencies.getTournamentsForUser || defaultGetTournamentsForUser;
  const getPublicTournaments =
    dependencies.getPublicTournaments || defaultGetPublicTournaments;
  const getRaceDiscoverySummary =
    dependencies.getRaceDiscoverySummary || defaultGetRaceDiscoverySummary;
  const getRaceDetails = dependencies.getRaceDetails || defaultGetRaceDetails;
  const getRaceProgress =
    dependencies.getRaceProgress || defaultGetRaceProgress;
  const getSneakySwapTargets =
    dependencies.getSneakySwapTargets ||
    (dependencies.Race || dependencies.RacePowerup || dependencies.RaceActiveEffect
      ? buildGetSneakySwapTargets(dependencies)
      : defaultGetSneakySwapTargets);
  const usePowerup = dependencies.usePowerup || defaultUsePowerup;
  const discardPowerup = dependencies.discardPowerup || defaultDiscardPowerup;
  const openMysteryBox = dependencies.openMysteryBox || defaultOpenMysteryBox;
  const openMysteryBoxBatch =
    dependencies.openMysteryBoxBatch || defaultOpenMysteryBoxBatch;
  const rerollMysteryBox =
    dependencies.rerollMysteryBox || defaultRerollMysteryBox;
  const rerollMysteryBoxBatch =
    dependencies.rerollMysteryBoxBatch || defaultRerollMysteryBoxBatch;
  const redeemPowerupToRace =
    dependencies.redeemPowerupToRace || defaultRedeemPowerupToRace;
  const getRaceInventory =
    dependencies.getRaceInventory || defaultGetRaceInventory;
  const getRaceFeed = dependencies.getRaceFeed || defaultGetRaceFeed;
  const getRaceMessages =
    dependencies.getRaceMessages || defaultGetRaceMessages;
  const getRaceMessageStreams =
    dependencies.getRaceMessageStreams || defaultGetRaceMessageStreams;
  const getPowerupInventory =
    dependencies.getPowerupInventory || defaultGetPowerupInventory;
  const sendRaceMessage =
    dependencies.sendRaceMessage || defaultSendRaceMessage;
  const deleteRaceMessage =
    dependencies.deleteRaceMessage || defaultDeleteRaceMessage;
  const setRaceChatMute =
    dependencies.setRaceChatMute || defaultSetRaceChatMute;
  const markRaceChatRead =
    dependencies.markRaceChatRead || defaultMarkRaceChatRead;
  const setRacePlacementMute =
    dependencies.setRacePlacementMute || defaultSetRacePlacementMute;
  const markRaceResultsSeen =
    dependencies.markRaceResultsSeen || defaultMarkRaceResultsSeen;
  const raceModel = dependencies.Race || defaultRaceModel;

  async function rejectTokenlessBucketDetail(req, res) {
    if (supportsSeededRaceBuckets(req.clientFeatures)) return false;
    const race = typeof raceModel.findSeededBucketMarker === "function"
      ? await raceModel.findSeededBucketMarker(req.params.raceId)
      : await raceModel.findById(req.params.raceId);
    if (!race?.seededBucketId) return false;
    res.status(404).json({ error: "Race not found", code: "RACE_NOT_FOUND" });
    return true;
  }
  const userModel = dependencies.User || defaultUserModel;
  const powerupModel = dependencies.RacePowerup || defaultPowerupModel;
  const effectModel = dependencies.RaceActiveEffect || defaultEffectModel;
  const logger = dependencies.logger || console;
  const hasLiveUserCreatedRaceFn =
    dependencies.hasLiveUserCreatedRace || hasLiveUserCreatedRace;

  // `forceFullParticipants` is for callers that need the WHOLE roster regardless
  // of what the client put in the query string — currently /powerups/use-context,
  // whose entire purpose is action-time targeting against every participant.
  // Without it, a client appending `?view=participants-v1` to that URL would get
  // a 10-row page AND a null `powerupData`, which its own gate reads as "not an
  // active participant" and answers 403.
  function loadRaceProgress(
    req,
    resolvedContext = null,
    { forceFullParticipants = false } = {}
  ) {
    const view = forceFullParticipants ? null : req.query.view;
    const rawOffset = Number(req.query.offset);
    const rawLimit = Number(req.query.limit);
    const participantsOffset =
      Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const participantsLimit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 10;
    const isParticipantsView = view === "participants-v1";
    const clampedLimit = isParticipantsView
      ? Math.min(Math.max(participantsLimit, 1), 50)
      : participantsLimit;

    return getRaceProgress(
      req.user.id,
      req.params.raceId,
      req.timeZone,
      req.clientFeatures?.has("characters") ?? false,
      req.clientFeatures?.has("powerups3") ?? false,
      req.clientFeatures?.has("powerups4") ?? false,
      req.clientFeatures?.has("powerups5") ?? false,
      req.releaseChannel,
      req.clientFeatures?.has("ads") ?? false,
      req.user.timezone || req.timeZone || null,
      req.clientFeatures?.has("remote_assets") ?? false,
      resolvedContext,
      {
        participantsView: isParticipantsView ? "participants-v1" : null,
        participantsOffset: isParticipantsView ? participantsOffset : 0,
        participantsLimit: isParticipantsView ? clampedLimit : 10,
      }
    );
  }

  async function loadBootstrapAccess(req) {
    const context = typeof raceModel.findBootstrapAccessContext === "function"
      ? await raceModel.findBootstrapAccessContext(req.params.raceId, req.user.id)
      : null;
    if (!context) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }
    if (
      context.seededBucketId &&
      !supportsSeededRaceBuckets(req.clientFeatures)
    ) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      error.code = "RACE_NOT_FOUND";
      throw error;
    }
    const direct = context.participants?.[0];
    const tournamentAccess =
      context.tournamentId != null &&
      (context.tournament?.participants?.length || 0) > 0;
    if ((!direct || direct.status === "DECLINED") && !tournamentAccess) {
      const error = new Error("You are not a participant in this race");
      error.statusCode = 403;
      throw error;
    }
    return context;
  }

  function payoutDoubleEndpoint(operation, handler) {
    return asyncHandler(async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        safeStructuredEvent(logger, {
          event: "race_payout_double_endpoint_metric",
          operation,
          code: error?.code || "INTERNAL_ERROR",
        });
        throw error;
      }
    });
  }

  // GET /races/share/:token  — PUBLIC, declared BEFORE requireAuth so the
  // landing page and the app's pre-join screen can read a shared race without a
  // session. Returns only display-safe fields (see getSharedRacePreview); 404
  // for an unknown/revoked token. Declared ahead of the authed GET /:raceId so
  // "share" is never mistaken for a race id.
  router.get("/share/:token", async (req, res) => {
    try {
      const preview = await getSharedRacePreview({ token: req.params.token });
      if (!preview) {
        return res.status(404).json({ error: "Race not found" });
      }
      res.json({ race: preview });
    } catch (error) {
      console.error("Get shared race preview error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.use(requireAuth);

  // POST /races
  router.post("/", async (req, res) => {
    try {
      const {
        name,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        isPublic,
        maxParticipants,
        scheduledStartAt,
        targetSteps,
        // Team races (TR-100s). Old clients never send these.
        isTeamRace,
        teamSize,
        teamAName,
        teamBName,
        team,
        creationSource,
        startPolicy,
      } = req.body;
      const create = () => createRace({
        userId: req.user.id,
        name,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        payoutPreset,
        isPublic,
        maxParticipants,
        scheduledStartAt,
        targetSteps,
        // Creator's device tz -> race's canonical scoring tz, so live standings
        // and placement pushes match what every participant sees on-screen.
        timeZone: req.timeZone,
        isTeamRace,
        teamSize,
        teamAName,
        teamBName,
        team,
        clientFeatures: req.clientFeatures,
        creationSource,
        startPolicy,
      });
      const race = supportsNextRace(req.clientFeatures) &&
        hasAnyQuickMetadata({ creationSource, startPolicy })
        ? await withQuickMembershipLock(req.user.id, create)
        : await create();
      res.status(201).json({ race });
    } catch (error) {
      if (error.name === "RaceCreationError") {
        const status = error.statusCode || 400;
        // `code` is additive — old clients only read `error`; new clients
        // branch on machine-readable codes (TEAM_NAMES_IDENTICAL, …).
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Create race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Fresh invite decision check for the Races-tab gate. This must precede the
  // full list: the gate needs only pending invitation cards, not list payload.
  router.get("/invite-preflight", async (req, res) => {
    try {
      const supportsTournaments = req.clientFeatures?.has("tournaments") ?? false;
      const homeInviteModal =
        (req.clientFeatures?.has("home_invite_modal") ?? false) &&
        (await settings.getFlag("homeInviteModalEnabled"));
      res.json(
        await getRaceInvitePreflight({
          userId: req.user.id,
          supportsTournaments,
          supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
          homeInviteModal,
        })
      );
    } catch (error) {
      logger.error("Load race invite preflight error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races
  router.get("/", async (req, res) => {
    try {
      // TR-702: old clients (no team_races token) never receive team races.
      const supportsTeamRaces = req.clientFeatures?.has("team_races") ?? false;
      const supportsTournaments = req.clientFeatures?.has("tournaments") ?? false;
      const supportsCharacters = req.clientFeatures?.has("characters") ?? false;
      // Start the core race list and (for token clients) the tournament list
      // concurrently — they read disjoint rows, so there's no reason to await
      // them serially (Phase B4). Old clients pass null and get byte-identical
      // JSON (§4/§6.3).
      const supportsPayoutDouble =
        req.clientFeatures?.has("race_payout_double") ?? false;
      let pendingPayoutDoubleOffer = null;
      if (supportsPayoutDouble) {
        try {
          pendingPayoutDoubleOffer = await racePayoutDoubleModel.findPending(
            req.user.id,
          );
        } catch (error) {
          logger.error("Load pending race payout double offer error:", error);
        }
      }
      const [result, tournaments] = await Promise.all([
        getRaces(req.user.id, supportsTeamRaces, {
          clientFeatures: req.clientFeatures,
          // Batch 2026-08-08 item 4: the completed-race podium rows gate
          // test-only characters on the release channel, same as race detail.
          releaseChannel: req.releaseChannel,
          extraCompletedRaceIds: pendingPayoutDoubleOffer
            ? pendingPayoutDoubleOffer.items.map((item) => item.raceIdSnapshot)
            : [],
        }),
        supportsTournaments
          ? getTournamentsForUser(req.user.id, {
              supportsCharacters,
              releaseChannel: req.releaseChannel,
              supportsRemoteAssets:
                req.clientFeatures?.has("remote_assets") ?? false,
            })
          : Promise.resolve(null),
      ]);
      if (tournaments) {
        result.tournaments = tournaments;
      }
      if (supportsNextRace(req.clientFeatures)) {
        try {
          const createEnabled = await appSettings.getFlag("quickCreateRaceCtaEnabled");
          // The results surface consumes eligibility only when creation can be
          // offered. With the default-off flag, avoid even the existence query.
          const eligible = createEnabled
            ? !(await hasLiveUserCreatedRaceFn(req.user.id))
            : false;
          result.nextRace = { resolved: true, eligible, createEnabled };
        } catch (error) {
          logger.error("Build races nextRace error:", error);
          result.nextRace = {
            resolved: false,
            eligible: false,
            createEnabled: false,
          };
        }
      }
      if (supportsPayoutDouble) {
        try {
          const offer = await getRacePayoutDoubleOffer({
            userId: req.user.id,
            completed: result.completed,
            pendingOffer: pendingPayoutDoubleOffer,
          });
          if (offer) result.payoutDoubleOffer = offer;
        } catch (error) {
          logger.error("Build race payout double offer error:", error);
        }
      }
      res.json(result);
    } catch (error) {
      console.error("Get races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Static payout-double paths MUST precede every /:raceId route. New clients
  // prepare before loading an ad; old clients never call these endpoints.
  router.post(
    "/results/double-payout/offer",
    payoutDoubleEndpoint("prepare", async (req, res) => {
      const result = await createRacePayoutDoubleOffer({
        userId: req.user.id,
        raceIds: req.body?.raceIds,
        clientFeatures: req.clientFeatures,
      });
      res.status(result.created ? 201 : 200).json(result.body);
    }),
  );

  router.post(
    "/results/double-payout/:offerId/claim",
    payoutDoubleEndpoint("claim", async (req, res) => {
      const body = await claimRacePayoutDouble({
        userId: req.user.id,
        offerId: req.params.offerId,
        clientFeatures: req.clientFeatures,
      });
      res.json(body);
    }),
  );

  router.post("/results/seen", async (req, res) => {
    try {
      const { raceIds } = req.body || {};
      if (
        !Array.isArray(raceIds) ||
        raceIds.length === 0 ||
        !raceIds.every((id) => typeof id === "string" && id.length > 0)
      ) {
        return res
          .status(400)
          .json({ error: "raceIds must be a non-empty array of strings" });
      }
      await markRaceResultsSeen({
        userId: req.user.id,
        raceIds,
        racePayoutDoubleCapability:
          req.clientFeatures?.has("race_payout_double") ?? false,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "MarkRaceResultsSeenError") {
        return res.status(error.statusCode || 400).json({ error: error.message });
      }
      console.error("Mark race results seen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/discovery-summary — one compact request replacing the Races
  // screen's public-count + featured-races + featured-tournaments background
  // calls (§6.2). Additive; old clients never call it (they keep the three
  // separate endpoints). Static path declared BEFORE any GET /:raceId so it is
  // never read as a race id.
  router.get("/discovery-summary", async (req, res) => {
    try {
      const capable = supportsSeededRaceBuckets(req.clientFeatures);
      const hiddenSeedKinds = capable
        ? new Set()
        : await seededBuckets.selectedBucketSeedKinds(req.user.id);
      const hiddenSeededWindows = await seededBuckets.bucketModeWindowKeys({
        userId: capable ? null : req.user.id,
      });
      const summary = await getRaceDiscoverySummary({
        userId: req.user.id,
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        supportsTournaments: req.clientFeatures?.has("tournaments") ?? false,
        supportsBuckets: capable,
        hiddenSeedKinds,
        hiddenSeededWindows,
      });
      res.json(summary);
    } catch (error) {
      console.error("Get race discovery summary error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/public
  router.get("/public", async (req, res) => {
    try {
      const capable = supportsSeededRaceBuckets(req.clientFeatures);
      const compact =
        req.query.view === "browser-v1" &&
        (await isStrictFlagEnabled(
          settings,
          "apiPublicRaceBrowserV1Enabled"
        ));
      const publicPromise = getPublicRaces({
        userId: req.user.id,
        // TR-702: old clients never see team races in the public browser.
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        // Capable clients never see the legacy global seeded field during the
        // mixed-version bridge; their private card is /featured-only.
        excludeSeeded: false,
        hiddenSeededWindows: await seededBuckets.bucketModeWindowKeys({
          userId: capable ? null : req.user.id,
        }),
      });
      if (!compact) return res.json({ races: await publicPromise });

      const supportsTournaments =
        req.clientFeatures?.has("tournaments") ?? false;
      const featuredPromise = (async () => {
        if (capable && req.user.autoJoinFeaturedRaces === true) {
          await seededBuckets.reconcileFeaturedUser({
            userId: req.user.id,
            capable,
            autoJoinFeaturedRaces: true,
          });
        }
        return getFeaturedRaces({
          userId: req.user.id,
          supportsBuckets: capable,
          hiddenSeedKinds: capable
            ? new Set()
            : await seededBuckets.selectedBucketSeedKinds(req.user.id),
        });
      })();
      const tournamentsPromise = supportsTournaments
        ? getPublicTournaments({ userId: req.user.id })
        : Promise.resolve({ featured: [], tournaments: [] });
      const minePromise = supportsTournaments
        ? getTournamentsForUser(req.user.id, {
            supportsCharacters: false,
            releaseChannel: req.releaseChannel,
            supportsRemoteAssets: false,
          })
        : Promise.resolve([]);
      const [publicResult, featuredResult, tournamentsResult, mineResult] =
        await Promise.allSettled([
          publicPromise,
          featuredPromise,
          tournamentsPromise,
          minePromise,
        ]);
      if (publicResult.status === "rejected") throw publicResult.reason;
      res.json({
        contract: "public-race-browser-v1",
        races: publicResult.value,
        resolved: {
          featuredRaces: featuredResult.status === "fulfilled",
          tournaments: tournamentsResult.status === "fulfilled",
          mine: mineResult.status === "fulfilled",
        },
        featuredRaces:
          featuredResult.status === "fulfilled" ? featuredResult.value : [],
        tournaments: {
          featured:
            tournamentsResult.status === "fulfilled"
              ? tournamentsResult.value.featured
              : [],
          public:
            tournamentsResult.status === "fulfilled"
              ? tournamentsResult.value.tournaments
              : [],
          mine: mineResult.status === "fulfilled" ? mineResult.value : [],
        },
      });
    } catch (error) {
      console.error("Get public races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/featured
  // The live seeded daily/weekly races, pinned for the Featured section. Static
  // path declared before any GET /:raceId so it isn't captured as a race id.
  // New endpoint — old clients never call it.
  router.get("/featured", async (req, res) => {
    try {
      const capable = supportsSeededRaceBuckets(req.clientFeatures);
      // The documented GET mutation: it is capability-gated and protected by
      // the window advisory lock inside the service. Any thrown infrastructure
      // error reaches the existing 500 response with no partial transfer.
      if (capable && req.user.autoJoinFeaturedRaces === true) {
        await seededBuckets.reconcileFeaturedUser({
          userId: req.user.id,
          capable,
          autoJoinFeaturedRaces: true,
        });
      }
      const races = await getFeaturedRaces({
        userId: req.user.id,
        supportsBuckets: capable,
        hiddenSeedKinds: capable ? new Set() : await seededBuckets.selectedBucketSeedKinds(req.user.id),
      });
      res.json({ races });
    } catch (error) {
      console.error("Get featured races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Explicit election only: GET /featured remains virtual/read-only. This is
  // static and intentionally declared before /:raceId routes.
  router.post("/seeded/:seedKind/assign", async (req, res) => {
    try {
      if (!supportsSeededRaceBuckets(req.clientFeatures)) {
        return res.status(503).json({ error: "Seeded bucket matching is unavailable", code: "MATCHING_UNAVAILABLE" });
      }
      const result = await seededBuckets.elect({ userId: req.user.id, seedKind: req.params.seedKind, window: req.body?.window });
      res.status(202).json({ elected: true, raceId: null, finalizesAt: result.finalizesAt });
    } catch (error) {
      if (error instanceof SeededBucketError || error.name === "SeededBucketError") {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      logger.error("Seeded bucket election error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/team-names/suggest — a fresh pair of DISTINCT playful team
  // names from the backend pool (TR-103), for the create screen's name plaques
  // + dice-reroll before the race exists (TR-801). Read-only and cheap (no DB);
  // creation re-generates server-side anyway, so this is purely a preview.
  // Static path declared BEFORE any GET /:raceId so it isn't read as a race id.
  // New endpoint — old clients never call it.
  router.get("/team-names/suggest", async (_req, res) => {
    try {
      const [teamAName, teamBName] = generateTeamNamePair();
      res.json({ teamAName, teamBName });
    } catch (error) {
      console.error("Team name suggest error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Private seeded buckets are a capability-gated surface. Put this ahead of
  // every dynamic `/:raceId/...` route so a frozen device sharing an upgraded
  // account cannot use a remembered/push-delivered id to read or mutate bucket
  // data it cannot render. Static routes above remain unaffected.
  router.use("/:raceId", async (req, res, next) => {
    try {
      if (await rejectTokenlessBucketDetail(req, res)) return;
      next();
    } catch (error) {
      next(error);
    }
  });

  // POST /races/:raceId/join
  // Optional body { onboarding: boolean } — when true (and server-side
  // eligibility passes) grants the one-time "join your first race" bonus boxes.
  // Old clients omit it (defaults false), preserving current behavior.
  router.post("/:raceId/join", async (req, res) => {
    try {
      const participant = await joinPublicRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        onboarding: req.body && req.body.onboarding === true,
        // Team races (TR-201): required side pick; ignored on individual races.
        team: (req.body && req.body.team) || null,
        clientFeatures: req.clientFeatures,
      });
      res.status(201).json({ participant });
    } catch (error) {
      if (error.name === "RaceJoinError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Join public race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/share-link
  // Mints (or returns the existing) shareable link for a race the caller
  // participates in. Idempotent. Returns { shareToken, url }.
  router.post("/:raceId/share-link", async (req, res) => {
    try {
      const { shareToken } = await createRaceShareLink({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      let url = buildShareUrl(shareToken);
      try {
        const referralCode = await getOrCreateReferralCode({ userId: req.user.id });
        if (referralCode) {
          url = buildShareUrl(shareToken, referralCode);
        }
      } catch (error) {
        logger.error("Referral lookup for race share failed:", error);
      }
      res.status(201).json({ shareToken, url });
    } catch (error) {
      if (error.name === "RaceShareLinkError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Create race share link error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/share/:token/join
  // Joins the race behind a shared link. Bypasses the isPublic gate (possession
  // of the token IS the invite). Optional body { onboarding } mirrors
  // POST /:raceId/join. Distinct segment count from /:raceId/join — no collision.
  router.post("/share/:token/join", async (req, res) => {
    try {
      const participant = await joinRaceByShareToken({
        userId: req.user.id,
        token: req.params.token,
        onboarding: req.body && req.body.onboarding === true,
        // Team races (TR-201): required side pick; ignored on individual races.
        team: (req.body && req.body.team) || null,
        clientFeatures: req.clientFeatures,
      });
      res.status(201).json({ participant, raceId: participant.raceId });
    } catch (error) {
      if (
        error.name === "RaceShareJoinError" ||
        error.name === "RaceJoinError"
      ) {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Join race by share token error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/onboarding/first-race-seen
  // Marks the authed user as having seen the first-race onboarding step (the
  // SKIP path). Idempotent — safe to call repeatedly. Static path is declared
  // before /:raceId routes that take an action suffix, so there's no collision.
  router.post("/onboarding/first-race-seen", async (req, res) => {
    try {
      await userModel.update(req.user.id, { firstRaceOnboardingSeen: true });
      res.json({ success: true });
    } catch (error) {
      console.error("Mark first-race onboarding seen error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Additive capable-client contract. Disabled is a definite 404 so the app
  // can cache its legacy three-request fallback without changing any frozen
  // client's existing route or response.
  router.get("/:raceId/bootstrap", async (req, res) => {
    if (!(await isStrictFlagEnabled(settings, "apiRaceBootstrapV1Enabled"))) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const access = await loadBootstrapAccess(req);
      const detailArgs = [
        req.user.id,
        req.params.raceId,
        req.clientFeatures?.has("characters") ?? false,
        req.releaseChannel,
        req.clientFeatures?.has("remote_assets") ?? false,
        req.clientFeatures?.has("race_leave") ?? false,
        req.clientFeatures?.has("team_races") ?? false,
        supportsSeededRaceBuckets(req.clientFeatures),
      ];
      if (access.status !== "ACTIVE") {
        const race = await getRaceDetails(...detailArgs);
        return res.json({
          contract: "race-bootstrap-v1",
          race,
          progress: null,
          progressError: null,
          globalPowerupInventory: null,
        });
      }
      const resolvedContext = {};
      const [progressResult, inventoryResult] = await Promise.allSettled([
        // Honours the same paging query as /progress. Old clients send no view
        // and are served the whole roster exactly as before.
        loadRaceProgress(req, resolvedContext),
        getPowerupInventory(
          req.user.id,
          req.clientFeatures?.has("powerups4") ?? false
        ),
      ]);
      if (progressResult.status === "rejected") {
        logger.error("Race bootstrap progress unavailable", {
          error: progressResult.reason?.message || "unknown",
        });
      }
      if (inventoryResult.status === "rejected") {
        logger.error("Race bootstrap inventory unavailable", {
          error: inventoryResult.reason?.message || "unknown",
        });
      }
      const race = await getRaceDetails(
        ...detailArgs,
        resolvedContext.race || null
      );
      res.json({
        contract: "race-bootstrap-v1",
        race,
        progress:
          progressResult.status === "fulfilled" ? progressResult.value : null,
        progressError:
          progressResult.status === "fulfilled"
            ? null
            : { code: "PROGRESS_UNAVAILABLE" },
        globalPowerupInventory:
          inventoryResult.status === "fulfilled" ? inventoryResult.value : null,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      }
      logger.error("Race bootstrap error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/:raceId/message-streams", async (req, res) => {
    if (!(await isStrictFlagEnabled(settings, "apiRaceMessageStreamsV1Enabled"))) {
      return res.status(404).json({ error: "Not found" });
    }
    try {
      const result = await getRaceMessageStreams({
        userId: req.user.id,
        raceId: req.params.raceId,
        includeUser: req.query.includeUser !== "false",
        limit: req.query.limit,
      });
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      logger.error("Race message streams error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId/participants/:userId
  router.delete("/:raceId/participants/:userId", async (req, res) => {
    try {
      await kickRaceParticipant({
        userId: req.user.id,
        raceId: req.params.raceId,
        targetUserId: req.params.userId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "RaceKickError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Kick participant error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId
  router.get("/:raceId", async (req, res) => {
    try {
      const result = await getRaceDetails(
        req.user.id,
        req.params.raceId,
        req.clientFeatures?.has("characters") ?? false,
        req.releaseChannel,
        req.clientFeatures?.has("remote_assets") ?? false,
        req.clientFeatures?.has("race_leave") ?? false,
        req.clientFeatures?.has("team_races") ?? false,
        supportsSeededRaceBuckets(req.clientFeatures)
      );
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      }
      console.error("Get race details error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/invite
  router.post("/:raceId/invite", async (req, res) => {
    try {
      const { inviteeIds } = req.body;
      const race = await inviteToRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        inviteeIds,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceInviteError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Invite to race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/respond
  router.put("/:raceId/respond", async (req, res) => {
    try {
      const { accept, team } = req.body;
      const participant = await respondToRaceInvite({
        userId: req.user.id,
        raceId: req.params.raceId,
        accept,
        // Team races (TR-201): side is required when accepting; ignored otherwise.
        team: team || null,
        clientFeatures: req.clientFeatures,
      });
      res.json({ participant });
    } catch (error) {
      if (error.name === "RaceInviteResponseError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Respond to race invite error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/team — switch sides in a PENDING team race (TR-203).
  // Body: { team: "TEAM_A" | "TEAM_B" }. New endpoint; old clients never call it.
  router.put("/:raceId/team", async (req, res) => {
    try {
      const participant = await switchRaceTeam({
        userId: req.user.id,
        raceId: req.params.raceId,
        team: req.body && req.body.team,
      });
      res.json({ participant });
    } catch (error) {
      if (error.name === "RaceTeamSwitchError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Switch race team error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/leave — legacy PENDING team leave, plus the additive
  // token+stamp-gated ordinary PENDING leave / ACTIVE forfeit protocol.
  router.post("/:raceId/leave", async (req, res) => {
    try {
      const result = await leaveRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        supportsRaceLeave: req.clientFeatures?.has("race_leave") ?? false,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "RaceLeaveError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Leave race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/forfeit — mid-race forfeit in an ACTIVE team race
  // (TR-601). Freezes the caller's total as-is; may complete the race on team
  // collapse (TR-603). New endpoint; old clients never call it.
  router.post("/:raceId/forfeit", async (req, res) => {
    try {
      const result = await forfeitRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "RaceForfeitError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Forfeit race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/start
  router.post("/:raceId/start", async (req, res) => {
    try {
      const race = await startRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceStartError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Start race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/progress
  router.get("/:raceId/progress", async (req, res) => {
    try {
      const compact =
        req.query.view === "compact-v1" &&
        (await isStrictFlagEnabled(
          settings,
          "apiRaceProgressCompactV1Enabled"
        ));
      if (!compact) {
        const progress = await loadRaceProgress(req);
        // Requirements §5.2: the paged view answers with its own contract tag.
        // It is the ONLY signal a client can use to tell "this backend paginates"
        // from "this backend ignored my query string and sent everything", which
        // is what §8's degrade-to-legacy path keys on. Classic requests keep the
        // bare `{ progress }` envelope byte-for-byte.
        if (req.query.view === "participants-v1") {
          return res.json({
            contract: "race-progress-participants-v1",
            progress,
          });
        }
        return res.json({ progress });
      }
      const inventoryPromise = getPowerupInventory(
        req.user.id,
        req.clientFeatures?.has("powerups4") ?? false
      );
      const progress = await loadRaceProgress(req);
      const inventoryResult = await Promise.allSettled([inventoryPromise]);
      res.json({
        contract: "race-progress-compact-v1",
        progress,
        globalPowerupInventory:
          inventoryResult[0].status === "fulfilled"
            ? inventoryResult[0].value
            : null,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Race progress error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/powerups/use-context
  // Additive endpoint (new app only): returns full participant rows (active
  // participants only) plus the viewer's held powerups/slots for
  // action-time targeting. Older apps never call this and keep using legacy
  // progress-derived candidates.
  router.get("/:raceId/powerups/use-context", async (req, res) => {
    try {
      const progress = await loadRaceProgress(req, null, {
        forceFullParticipants: true,
      });
      if (progress?.status !== "ACTIVE") {
        return res.status(400).json({
          error: "Race is not active",
          code: "RACE_NOT_ACTIVE",
        });
      }
      const powerupData = progress?.powerupData;
      if (!powerupData || powerupData.enabled !== true) {
        return res.status(403).json({
          error: "You are not an active participant in this race",
          code: "NOT_ACTIVE_PARTICIPANT",
        });
      }

      const rawParticipants = Array.isArray(progress?.participants)
        ? progress.participants
        : [];
      const participants = rawParticipants
        .map((participant) =>
          participant && typeof participant === "object" ? participant : null
        )
        .filter(Boolean);

      res.json({
        contract: "race-powerup-use-context-v1",
        participants,
        powerupData: {
          powerupSlots: powerupData.powerupSlots ?? 3,
          inventory: Array.isArray(powerupData.inventory) ? powerupData.inventory : [],
          queuedBoxCount: powerupData.queuedBoxCount ?? 0,
          myPlacement: progress?.myPlacement ?? null,
        },
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Race powerup use-context error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/use
  // POST /races/:raceId/powerups/redeem — spend ONE global-inventory powerup
  // (e.g. IMPOSTER) into this active race, creating a HELD RacePowerup in the
  // in-race tray. Additive; only the new app calls this.
  router.post("/:raceId/powerups/redeem", async (req, res) => {
    try {
      if (req.body?.powerupType === "QUICKSAND" && !req.clientFeatures?.has("powerups4")) {
        return res.status(400).json({ error: "Update required to use Quicksand", code: "UPDATE_REQUIRED" });
      }
      const result = await redeemPowerupToRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupType: req.body.powerupType,
      });
      res.json({ result });
    } catch (error) {
      if (error.name === "RedeemPowerupError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Redeem powerup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/:raceId/powerups/:powerupId/use", async (req, res) => {
    const performance = beginRacePerformance(performanceQueryCounter);
    let perfOutcome = "error";
    let perfType = null;
    try {
      const {
        targetUserId,
        targetUserIds,
        targetDirection,
        swapOfferedPowerupId,
        swapRequestedPowerupId,
        upgradeLevel,
        targetEffectId,
      } = req.body;
      const result = await usePowerup({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        targetUserId,
        targetUserIds,
        targetDirection,
        swapOfferedPowerupId,
        swapRequestedPowerupId,
        timeZone: req.timeZone,
        upgradeLevel: upgradeLevel != null ? upgradeLevel : 0,
        // §6.3: optional. Absent (every legacy request) keeps the exact legacy
        // Pocket Watch meaning.
        targetEffectId: targetEffectId || null,
        // §7.5: REQUEST-scoped capabilities, never the user's stored sticky
        // union — that would upgrade a request made by a frozen binary.
        clientFeatures: req.clientFeatures || null,
        onPerformanceContext: ({ powerupType }) => {
          perfType = powerupType;
        },
      });
      perfOutcome = "success";
      perfType = result?.type || result?.powerupType || null;
      // X-Ray (DEFENSE_SCAN) is an instantaneous intel read: surface the scan at
      // the TOP LEVEL per the contract ({ ok, scan }). `result` is kept alongside
      // for back-compat with clients that read the standard use-result envelope.
      if (result && result.scan) {
        return res.json({ ok: true, scan: result.scan, result });
      }
      res.json({ result });
    } catch (error) {
      if (error.name === "PowerupUseError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Use powerup error:", error);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      logRacePerformance(logger, "use-powerup", performance, {
        powerupType: perfType,
        outcome: perfOutcome,
      });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/discard
  router.post("/:raceId/powerups/:powerupId/discard", async (req, res) => {
    try {
      const result = await discardPowerup({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
        // Batch 2026-08-08 item 1: the discard coin cap is per LOCAL day. Prefer
        // the user's STORED zone (sticky-written by requireAuth) over the
        // per-request header, so the cap can't be widened by spoofing
        // X-Timezone; fall back to the request zone, then to ET in the service.
        timezone: req.user.timezone || req.timeZone || null,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "PowerupDiscardError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Discard powerup error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/open
  router.post("/:raceId/powerups/:powerupId/open", async (req, res) => {
    const performance = beginRacePerformance(performanceQueryCounter);
    let perfOutcome = "error";
    let perfType = null;
    let perfPostRepair = false;
    try {
      const result = await openMysteryBox({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
        // 2026-07-26 §5.6 — the roll's wave-5 compat gate. A frozen binary that
        // rolled a wave-5 type would be refused at use time (UPDATE_REQUIRED),
        // i.e. a dead slot in a live race.
        supportsPowerups5: req.clientFeatures?.has("powerups5") ?? false,
      });
      perfOutcome = result.alreadyOpened ? "replay" : "opened";
      perfType = result.type || null;
      perfPostRepair = !result.alreadyOpened;
      res.json({ result });
    } catch (error) {
      if (error.name === "MysteryBoxOpenError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Open mystery box error:", error);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      logRacePerformance(logger, "open-mystery-box", performance, {
        powerupType: perfType,
        outcome: perfOutcome,
        optionalPostWork: perfPostRepair,
      });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/reroll — batch 2026-08-08 item 11.
  // Spend one SSV-verified rewarded-ad watch to re-roll an already-revealed box
  // result, ONCE. New endpoint behind a default-OFF kill switch; no shipped
  // binary calls it.
  router.post("/:raceId/powerups/:powerupId/reroll", async (req, res) => {
    try {
      const result = await rerollMysteryBox({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
        // The ad grant is keyed on the watcher's LOCAL date. Prefer the stored
        // zone (sticky-written by requireAuth) over the spoofable header, same
        // as the discard cap above. `localDate` in the body is OPTIONAL — the
        // locked client contract sends no body.
        timeZone: req.user.timezone || req.timeZone || null,
        localDate: req.body?.localDate,
        // Same wave-5 compat gate as /open — a reroll must not be a way to land
        // a type the requesting binary cannot render or use.
        supportsPowerups5: req.clientFeatures?.has("powerups5") ?? false,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "PowerupRerollError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Reroll mystery box error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/reroll-batch — batch 2026-08-10b item 1.
  // ONE rewarded-ad watch re-rolls EVERY eligible box from an Open All batch.
  //
  // Routing note: this is safe alongside `/:raceId/powerups/:powerupId/reroll`
  // because every parameterized powerup route carries a further path segment
  // and no bare `POST /:raceId/powerups/:powerupId` route exists — verified
  // before adding, since a bare one would shadow this literal path.
  router.post("/:raceId/powerups/reroll-batch", async (req, res) => {
    try {
      const result = await rerollMysteryBoxBatch({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupIds: req.body?.powerupIds,
        displayName: req.user.displayName,
        // The ad grant is keyed on the WATCHER's local date. Prefer the stored
        // zone (sticky-written by requireAuth) over the spoofable header, same
        // as the single reroll. `localDate` in the body is OPTIONAL.
        timeZone: req.user.timezone || req.timeZone || null,
        localDate: req.body?.localDate,
        // Same wave-5 compat gate as /open and the single reroll — REROLL ALL
        // must not be a way to land a type the requesting binary cannot use.
        supportsPowerups5: req.clientFeatures?.has("powerups5") ?? false,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "PowerupRerollBatchError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Reroll mystery box batch error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/open-batch — "Open All Boxes" (Item 1).
  // Additive; only the new app calls it. Old clients keep using single .../open.
  router.post("/:raceId/powerups/open-batch", async (req, res) => {
    const performance = beginRacePerformance(performanceQueryCounter);
    let perfOutcome = "error";
    let perfOpened = 0;
    try {
      const { powerupIds, includeQueued, maxCount } = req.body || {};
      const result = await openMysteryBoxBatch({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupIds: Array.isArray(powerupIds) ? powerupIds : [],
        includeQueued: includeQueued === true,
        maxCount: typeof maxCount === "number" ? maxCount : undefined,
        displayName: req.user.displayName,
        // Same gate as the single-open path above — "Open All" must not be a
        // way around it.
        supportsPowerups5: req.clientFeatures?.has("powerups5") ?? false,
      });
      perfOutcome = "success";
      perfOpened = Array.isArray(result?.results) ? result.results.length : 0;
      res.json(result);
    } catch (error) {
      if (
        error.name === "MysteryBoxBatchError" ||
        error.name === "MysteryBoxOpenError"
      ) {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Open mystery box batch error:", error);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      logRacePerformance(logger, "open-mystery-box-batch", performance, {
        outcome: perfOutcome,
        opened: perfOpened,
      });
    }
  });

  // GET /races/:raceId/inventory
  router.get("/:raceId/inventory", async (req, res) => {
    try {
      const result = await getRaceInventory(
        req.user.id,
        req.params.raceId,
        req.clientFeatures?.has("powerups4") ?? false
      );
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race inventory error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/feed
  router.get("/:raceId/feed", async (req, res) => {
    try {
      const { cursor, limit } = req.query;
      const result = await getRaceFeed(req.user.id, req.params.raceId, {
        cursor,
        limit: limit ? parseInt(limit, 10) : undefined,
        supportsPowerups4: req.clientFeatures?.has("powerups4") ?? false,
      });
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race feed error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/:raceId/powerups/sneaky-swap-options/:targetUserId", async (req, res) => {
    try {
      const race = await raceModel.findById(req.params.raceId);
      if (!race || race.status !== "ACTIVE") {
        return res.status(400).json({ error: "Race is not active" });
      }
      if (req.params.targetUserId === req.user.id) {
        return res.status(400).json({ error: "You cannot target yourself" });
      }

      const mine = race.participants.find(
        (p) => p.userId === req.user.id && p.status === "ACCEPTED"
      );
      const target = race.participants.find(
        (p) => p.userId === req.params.targetUserId && p.status === "ACCEPTED"
      );
      if (!mine || !target || target.finishedAt) {
        return res.status(400).json({ error: "Target is not an active participant in this race" });
      }

      const targetStealth = await effectModel.findActiveByTypeForParticipant(
        target.id,
        "STEALTH_MODE"
      );
      if (targetStealth) {
        return res.status(400).json({ error: "You cannot target a stealthed player" });
      }

      const [ownPowerups, targetPowerups] = await Promise.all([
        powerupModel.findHeldByParticipant(mine.id),
        powerupModel.findHeldByParticipant(target.id),
      ]);
      const sneakySwap = ownPowerups.find((p) => p.type === "SNEAKY_SWAP");
      if (!sneakySwap) {
        return res.status(400).json({ error: "Sneaky Swap is required" });
      }

      res.json({
        ownPowerups: ownPowerups.filter((p) => p.type !== "SNEAKY_SWAP"),
        // A held powerup is only stealable if it is NOT a SNEAKY_SWAP and NOT a
        // MYSTERY_BOX (an unopened box isn't stealable). Filtering here keeps the
        // second stage from ever offering a sneaky swap to steal. Existing
        // 400/validation behavior and overall response shape are unchanged.
        targetPowerups: targetPowerups.filter((p) => isStealable(p)),
      });
    } catch (error) {
      console.error("Sneaky swap options error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId/powerups/sneaky-swap-targets
  // Additive endpoint (new app only): returns the participants the requesting
  // user could sneaky-swap with right now — i.e. participants who are NOT the
  // requester, NOT stealthed, NOT finished, and who hold >=1 STEALABLE powerup
  // (HELD, type not SNEAKY_SWAP and not MYSTERY_BOX). Old apps never call this
  // and keep using the per-target options endpoint.
  router.get(
    "/:raceId/powerups/sneaky-swap-targets",
    asyncHandler(async (req, res) => {
      const performance = beginRacePerformance(performanceQueryCounter);
      let outcome = "error";
      let targets = 0;
      try {
        const result = await getSneakySwapTargets(
          req.user.id,
          req.params.raceId
        );
        outcome = "success";
        targets = result.targets.length;
        res.json(result);
      } finally {
        logRacePerformance(logger, "sneaky-swap-targets", performance, {
          outcome,
          targets,
        });
      }
    })
  );

  // GET /races/:raceId/messages
  router.get("/:raceId/messages", async (req, res) => {
    try {
      const { cursor, limit, kind } = req.query;
      const parsedLimit = limit ? Math.min(Number(limit) || 50, 100) : 50;
      // Backward compatible: omit kind => merged feed (legacy clients).
      const parsedKind = kind === "USER" || kind === "SYSTEM" ? kind : undefined;
      const result = await getRaceMessages(req.user.id, req.params.raceId, {
        cursor,
        limit: parsedLimit,
        kind: parsedKind,
      });
      res.json(result);
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Get race messages error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/messages
  router.post("/:raceId/messages", async (req, res) => {
    try {
      const { body } = req.body;
      const message = await sendRaceMessage({
        userId: req.user.id,
        raceId: req.params.raceId,
        body,
      });
      res.status(201).json({ message });
    } catch (error) {
      if (error.name === "RaceMessageError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Send race message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId/messages/:messageId
  router.delete("/:raceId/messages/:messageId", async (req, res) => {
    try {
      await deleteRaceMessage({
        userId: req.user.id,
        raceId: req.params.raceId,
        messageId: req.params.messageId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "DeleteRaceMessageError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Delete race message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/chat/mute
  router.put("/:raceId/chat/mute", async (req, res) => {
    try {
      const { muted } = req.body;
      await setRaceChatMute({
        userId: req.user.id,
        raceId: req.params.raceId,
        muted: !!muted,
      });
      res.json({ success: true, muted: !!muted });
    } catch (error) {
      if (error.name === "SetRaceChatMuteError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Set race chat mute error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/placement/mute
  // Per-race opt-out for live placement-change pushes. Additive endpoint; old app
  // builds never call it. Mirrors the chat/mute route shape.
  router.put("/:raceId/placement/mute", async (req, res) => {
    try {
      const { muted } = req.body;
      await setRacePlacementMute({
        userId: req.user.id,
        raceId: req.params.raceId,
        muted: !!muted,
      });
      res.json({ success: true, muted: !!muted });
    } catch (error) {
      if (error.name === "SetRacePlacementMuteError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Set race placement mute error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/chat/read
  router.post("/:raceId/chat/read", async (req, res) => {
    try {
      await markRaceChatRead({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "SetRaceChatMuteError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Mark race chat read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /races/:raceId
  router.patch("/:raceId", async (req, res) => {
    try {
      const {
        name,
        maxDurationDays,
        isPublic,
        powerupsEnabled,
        powerupStepInterval,
        buyInAmount,
        // Issue 4: `buyInEnabled:false` toggles a PENDING race to free (and
        // refunds everyone). Old clients never send it. editRace ignores it on
        // non-team/non-buy-in edits.
        buyInEnabled,
        payoutPreset,
        maxParticipants,
        // Team races (TR-105). isTeamRace is accepted only so editRace can
        // reject a conversion attempt with IMMUTABLE_FIELD.
        isTeamRace,
        teamAName,
        teamBName,
        teamSize,
      } = req.body || {};

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (maxDurationDays !== undefined) updates.maxDurationDays = maxDurationDays;
      if (isPublic !== undefined) updates.isPublic = isPublic;
      if (powerupsEnabled !== undefined) updates.powerupsEnabled = powerupsEnabled;
      if (powerupStepInterval !== undefined) updates.powerupStepInterval = powerupStepInterval;
      if (buyInAmount !== undefined) updates.buyInAmount = buyInAmount;
      if (buyInEnabled !== undefined) updates.buyInEnabled = buyInEnabled;
      if (payoutPreset !== undefined) updates.payoutPreset = payoutPreset;
      if (maxParticipants !== undefined) updates.maxParticipants = maxParticipants;
      if (isTeamRace !== undefined) updates.isTeamRace = isTeamRace;
      if (teamAName !== undefined) updates.teamAName = teamAName;
      if (teamBName !== undefined) updates.teamBName = teamBName;
      if (teamSize !== undefined) updates.teamSize = teamSize;

      const race = await editRace({
        userId: req.user.id,
        raceId: req.params.raceId,
        updates,
      });
      res.json({ race });
    } catch (error) {
      if (error.name === "RaceEditError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Edit race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /races/:raceId
  router.delete("/:raceId", async (req, res) => {
    try {
      await cancelRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "RaceCancelError") {
        const status = error.statusCode || 400;
        return res
          .status(status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      console.error("Cancel race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createRacesRouter };
