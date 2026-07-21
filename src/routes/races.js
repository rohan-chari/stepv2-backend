const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { createRace: defaultCreateRace } = require("../commands/createRace");
const {
  inviteToRace: defaultInviteToRace,
} = require("../commands/inviteToRace");
const {
  respondToRaceInvite: defaultRespondToRaceInvite,
} = require("../commands/respondToRaceInvite");
const {
  joinPublicRace: defaultJoinPublicRace,
} = require("../commands/joinPublicRace");
const {
  joinRaceByShareToken: defaultJoinRaceByShareToken,
} = require("../commands/joinRaceByShareToken");
const {
  createRaceShareLink: defaultCreateRaceShareLink,
} = require("../commands/createRaceShareLink");
const {
  getSharedRacePreview: defaultGetSharedRacePreview,
} = require("../queries/getSharedRacePreview");
const { buildShareUrl } = require("../config/sharing");
const {
  kickRaceParticipant: defaultKickRaceParticipant,
} = require("../commands/kickRaceParticipant");
const {
  getPublicRaces: defaultGetPublicRaces,
} = require("../queries/getPublicRaces");
const {
  getFeaturedRaces: defaultGetFeaturedRaces,
} = require("../queries/getFeaturedRaces");
const { startRace: defaultStartRace } = require("../commands/startRace");
const { cancelRace: defaultCancelRace } = require("../commands/cancelRace");
const { editRace: defaultEditRace } = require("../commands/editRace");
const {
  switchRaceTeam: defaultSwitchRaceTeam,
} = require("../commands/switchRaceTeam");
const { leaveRace: defaultLeaveRace } = require("../commands/leaveRace");
const { forfeitRace: defaultForfeitRace } = require("../commands/forfeitRace");
const {
  generateTeamNamePair: defaultGenerateTeamNamePair,
} = require("../constants/teamNames");
const {
  usePowerup: defaultUsePowerup,
} = require("../commands/usePowerup");
const {
  discardPowerup: defaultDiscardPowerup,
} = require("../commands/discardPowerup");
const {
  openMysteryBox: defaultOpenMysteryBox,
} = require("../commands/openMysteryBox");
const {
  openMysteryBoxBatch: defaultOpenMysteryBoxBatch,
} = require("../commands/openMysteryBoxBatch");
const {
  redeemPowerupToRace: defaultRedeemPowerupToRace,
} = require("../commands/redeemPowerupToRace");
const { getRaces: defaultGetRaces } = require("../queries/getRaces");
const {
  getTournamentsForUser: defaultGetTournamentsForUser,
} = require("../queries/getTournamentsForUser");
const {
  getRaceDiscoverySummary: defaultGetRaceDiscoverySummary,
} = require("../queries/getRaceDiscoverySummary");
const {
  getRaceDetails: defaultGetRaceDetails,
} = require("../queries/getRaceDetails");
const {
  getRaceProgress: defaultGetRaceProgress,
} = require("../queries/getRaceProgress");
const {
  getRaceInventory: defaultGetRaceInventory,
} = require("../queries/getRaceInventory");
const {
  getRaceFeed: defaultGetRaceFeed,
} = require("../queries/getRaceFeed");
const {
  getRaceMessages: defaultGetRaceMessages,
} = require("../queries/getRaceMessages");
const {
  sendRaceMessage: defaultSendRaceMessage,
} = require("../commands/sendRaceMessage");
const {
  deleteRaceMessage: defaultDeleteRaceMessage,
} = require("../commands/deleteRaceMessage");
const {
  setRaceChatMute: defaultSetRaceChatMute,
  markRaceChatRead: defaultMarkRaceChatRead,
} = require("../commands/setRaceChatMute");
const {
  setRacePlacementMute: defaultSetRacePlacementMute,
} = require("../commands/setRacePlacementMute");
const {
  markRaceResultsSeen: defaultMarkRaceResultsSeen,
} = require("../commands/markRaceResultsSeen");
const { Race: defaultRaceModel } = require("../models/race");
const { User: defaultUserModel } = require("../models/user");
const { RacePowerup: defaultPowerupModel } = require("../models/racePowerup");
const {
  RaceActiveEffect: defaultEffectModel,
} = require("../models/raceActiveEffect");
const { stepSyncPushService } = require("../services/stepSyncPush");

// A powerup is STEALABLE via Sneaky Swap only if it is currently HELD and its
// type is neither SNEAKY_SWAP (not stealable in either direction) nor
// MYSTERY_BOX (an unopened box isn't stealable). Callers that pass already-held
// rows can rely on type alone; we still guard on status defensively.
function isStealable(powerup) {
  if (!powerup) return false;
  if (powerup.status && powerup.status !== "HELD") return false;
  return powerup.type !== "SNEAKY_SWAP" && powerup.type !== "MYSTERY_BOX";
}

function createRacesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);

  const createRace = dependencies.createRace || defaultCreateRace;
  const inviteToRace = dependencies.inviteToRace || defaultInviteToRace;
  const respondToRaceInvite =
    dependencies.respondToRaceInvite || defaultRespondToRaceInvite;
  const joinPublicRace =
    dependencies.joinPublicRace || defaultJoinPublicRace;
  const joinRaceByShareToken =
    dependencies.joinRaceByShareToken || defaultJoinRaceByShareToken;
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
  const startRace = dependencies.startRace || defaultStartRace;
  const cancelRace = dependencies.cancelRace || defaultCancelRace;
  const editRace = dependencies.editRace || defaultEditRace;
  const switchRaceTeam = dependencies.switchRaceTeam || defaultSwitchRaceTeam;
  const leaveRace = dependencies.leaveRace || defaultLeaveRace;
  const forfeitRace = dependencies.forfeitRace || defaultForfeitRace;
  const generateTeamNamePair =
    dependencies.generateTeamNamePair || defaultGenerateTeamNamePair;
  const getRaces = dependencies.getRaces || defaultGetRaces;
  const getTournamentsForUser =
    dependencies.getTournamentsForUser || defaultGetTournamentsForUser;
  const getRaceDiscoverySummary =
    dependencies.getRaceDiscoverySummary || defaultGetRaceDiscoverySummary;
  const getRaceDetails = dependencies.getRaceDetails || defaultGetRaceDetails;
  const getRaceProgress =
    dependencies.getRaceProgress || defaultGetRaceProgress;
  const usePowerup = dependencies.usePowerup || defaultUsePowerup;
  const discardPowerup = dependencies.discardPowerup || defaultDiscardPowerup;
  const openMysteryBox = dependencies.openMysteryBox || defaultOpenMysteryBox;
  const openMysteryBoxBatch =
    dependencies.openMysteryBoxBatch || defaultOpenMysteryBoxBatch;
  const redeemPowerupToRace =
    dependencies.redeemPowerupToRace || defaultRedeemPowerupToRace;
  const getRaceInventory =
    dependencies.getRaceInventory || defaultGetRaceInventory;
  const getRaceFeed = dependencies.getRaceFeed || defaultGetRaceFeed;
  const getRaceMessages =
    dependencies.getRaceMessages || defaultGetRaceMessages;
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
  const userModel = dependencies.User || defaultUserModel;
  const powerupModel = dependencies.RacePowerup || defaultPowerupModel;
  const effectModel = dependencies.RaceActiveEffect || defaultEffectModel;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const logger = dependencies.logger || console;

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
      } = req.body;
      const race = await createRace({
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
      });
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

  // GET /races
  router.get("/", async (req, res) => {
    try {
      // TR-702: old clients (no team_races token) never receive team races.
      const supportsTeamRaces = req.clientFeatures?.has("team_races") ?? false;
      const supportsTournaments = req.clientFeatures?.has("tournaments") ?? false;
      // Start the core race list and (for token clients) the tournament list
      // concurrently — they read disjoint rows, so there's no reason to await
      // them serially (Phase B4). Old clients pass null and get byte-identical
      // JSON (§4/§6.3).
      const [result, tournaments] = await Promise.all([
        getRaces(req.user.id, supportsTeamRaces),
        supportsTournaments
          ? getTournamentsForUser(req.user.id)
          : Promise.resolve(null),
      ]);
      if (tournaments) {
        result.tournaments = tournaments;
      }
      res.json(result);
    } catch (error) {
      console.error("Get races error:", error);
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
      const summary = await getRaceDiscoverySummary({
        userId: req.user.id,
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
        supportsTournaments: req.clientFeatures?.has("tournaments") ?? false,
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
      const races = await getPublicRaces({
        userId: req.user.id,
        // TR-702: old clients never see team races in the public browser.
        supportsTeamRaces: req.clientFeatures?.has("team_races") ?? false,
      });
      res.json({ races });
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
      const races = await getFeaturedRaces({ userId: req.user.id });
      res.json({ races });
    } catch (error) {
      console.error("Get featured races error:", error);
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
      res.status(201).json({ shareToken, url: buildShareUrl(shareToken) });
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
        req.clientFeatures?.has("characters") ?? false
      );
      res.json(result);

      // Opening a live race nudges its OTHER accepted participants to upload
      // fresh steps, so the viewer's leaderboard reflects rivals' latest counts.
      // Fire-and-forget AFTER res.json so it never blocks/fails the response;
      // the push service self-throttles (skips anyone synced/pushed in the last
      // hour). Only for a race actively in progress — ACTIVE, not yet completed,
      // and not past endsAt (settlement owns it then; see resolveRaceState's
      // endsAt guard). Reuses the participant list already in the details
      // payload rather than issuing another query.
      const isInProgress =
        result &&
        result.status === "ACTIVE" &&
        !result.completedAt &&
        (!result.endsAt || new Date(result.endsAt).getTime() > Date.now());
      if (isInProgress) {
        const rivalIds = (result.participants || [])
          .filter((p) => p.status === "ACCEPTED" && p.userId !== req.user.id)
          .map((p) => p.userId);
        if (rivalIds.length > 0) {
          Promise.resolve()
            .then(() => requestStepSyncForUsers(rivalIds))
            .catch((error) => {
              logger.error("Race detail step sync request error:", error);
            });
        }
      }
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
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

  // POST /races/:raceId/leave — leave a PENDING team race lobby (TR-205).
  // Releases a HELD buy-in and frees the slot; re-joining later is a fresh
  // join. New endpoint; old clients never call it.
  router.post("/:raceId/leave", async (req, res) => {
    try {
      await leaveRace({
        userId: req.user.id,
        raceId: req.params.raceId,
      });
      res.json({ success: true });
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
      const progress = await getRaceProgress(
        req.user.id,
        req.params.raceId,
        req.timeZone,
        req.clientFeatures?.has("characters") ?? false,
        // §9.3: Hitchhike effect entries are only rendered by powerups3 builds.
        req.clientFeatures?.has("powerups3") ?? false
      );
      res.json({ progress });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Race progress error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /races/:raceId/powerups/:powerupId/use
  // POST /races/:raceId/powerups/redeem — spend ONE global-inventory powerup
  // (e.g. IMPOSTER) into this active race, creating a HELD RacePowerup in the
  // in-race tray. Additive; only the new app calls this.
  router.post("/:raceId/powerups/redeem", async (req, res) => {
    try {
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
    try {
      const {
        targetUserId,
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
      });
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
    try {
      const result = await openMysteryBox({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        displayName: req.user.displayName,
      });
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
    }
  });

  // POST /races/:raceId/powerups/open-batch — "Open All Boxes" (Item 1).
  // Additive; only the new app calls it. Old clients keep using single .../open.
  router.post("/:raceId/powerups/open-batch", async (req, res) => {
    try {
      const { powerupIds, includeQueued, maxCount } = req.body || {};
      const result = await openMysteryBoxBatch({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupIds: Array.isArray(powerupIds) ? powerupIds : [],
        includeQueued: includeQueued === true,
        maxCount: typeof maxCount === "number" ? maxCount : undefined,
        displayName: req.user.displayName,
      });
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
    }
  });

  // GET /races/:raceId/inventory
  router.get("/:raceId/inventory", async (req, res) => {
    try {
      const result = await getRaceInventory(req.user.id, req.params.raceId);
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
  router.get("/:raceId/powerups/sneaky-swap-targets", async (req, res) => {
    try {
      const race = await raceModel.findById(req.params.raceId);
      if (!race || race.status !== "ACTIVE") {
        return res.status(400).json({ error: "Race is not active" });
      }

      // Team races (TR-651/657): Sneaky Swap is enemy-only, and forfeited
      // members drop out of the target pool entirely.
      const me = race.participants.find(
        (p) => p.userId === req.user.id && p.status === "ACCEPTED"
      );
      const candidates = race.participants.filter(
        (p) =>
          p.userId !== req.user.id &&
          p.status === "ACCEPTED" &&
          !p.finishedAt &&
          !p.forfeitedAt &&
          (!race.isTeamRace || (me && p.team != null && p.team !== me.team))
      );

      const evaluated = await Promise.all(
        candidates.map(async (p) => {
          const [stealth, held] = await Promise.all([
            effectModel.findActiveByTypeForParticipant(p.id, "STEALTH_MODE"),
            powerupModel.findHeldByParticipant(p.id),
          ]);
          if (stealth) return null;
          if (!held.some((pw) => isStealable(pw))) return null;
          return {
            userId: p.userId,
            displayName: p.user ? p.user.displayName : null,
          };
        })
      );

      res.json({ targets: evaluated.filter(Boolean) });
    } catch (error) {
      console.error("Sneaky swap targets error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

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

  // POST /races/results/seen
  // Body: { raceIds: [...] }. Marks the calling user's race-results popup as
  // seen for the given races. Additive + display-only; old app builds never
  // call this. Validates raceIds is a non-empty array of strings; unknown ids
  // are ignored gracefully by the underlying updateMany.
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
      });
      res.json({ success: true });
    } catch (error) {
      if (error.name === "MarkRaceResultsSeenError") {
        return res
          .status(error.statusCode || 400)
          .json({ error: error.message });
      }
      console.error("Mark race results seen error:", error);
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
