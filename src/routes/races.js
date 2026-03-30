const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { createRace: defaultCreateRace } = require("../commands/createRace");
const {
  inviteToRace: defaultInviteToRace,
} = require("../commands/inviteToRace");
const {
  respondToRaceInvite: defaultRespondToRaceInvite,
} = require("../commands/respondToRaceInvite");
const { startRace: defaultStartRace } = require("../commands/startRace");
const { cancelRace: defaultCancelRace } = require("../commands/cancelRace");
const {
  usePowerup: defaultUsePowerup,
} = require("../commands/usePowerup");
const {
  discardPowerup: defaultDiscardPowerup,
} = require("../commands/discardPowerup");
const { getRaces: defaultGetRaces } = require("../queries/getRaces");
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

function createRacesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);

  const createRace = dependencies.createRace || defaultCreateRace;
  const inviteToRace = dependencies.inviteToRace || defaultInviteToRace;
  const respondToRaceInvite =
    dependencies.respondToRaceInvite || defaultRespondToRaceInvite;
  const startRace = dependencies.startRace || defaultStartRace;
  const cancelRace = dependencies.cancelRace || defaultCancelRace;
  const getRaces = dependencies.getRaces || defaultGetRaces;
  const getRaceDetails = dependencies.getRaceDetails || defaultGetRaceDetails;
  const getRaceProgress =
    dependencies.getRaceProgress || defaultGetRaceProgress;
  const usePowerup = dependencies.usePowerup || defaultUsePowerup;
  const discardPowerup = dependencies.discardPowerup || defaultDiscardPowerup;
  const getRaceInventory =
    dependencies.getRaceInventory || defaultGetRaceInventory;
  const getRaceFeed = dependencies.getRaceFeed || defaultGetRaceFeed;

  router.use(requireAuth);

  // POST /races
  router.post("/", async (req, res) => {
    try {
      const { name, targetSteps, maxDurationDays, powerupsEnabled, powerupStepInterval } = req.body;
      const race = await createRace({
        userId: req.user.id,
        name,
        targetSteps,
        maxDurationDays,
        powerupsEnabled,
        powerupStepInterval,
      });
      res.status(201).json({ race });
    } catch (error) {
      if (error.name === "RaceCreationError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Create race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races
  router.get("/", async (req, res) => {
    try {
      const result = await getRaces(req.user.id);
      res.json(result);
    } catch (error) {
      console.error("Get races error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /races/:raceId
  router.get("/:raceId", async (req, res) => {
    try {
      const result = await getRaceDetails(req.user.id, req.params.raceId);
      res.json(result);
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
        return res.status(status).json({ error: error.message });
      }
      console.error("Invite to race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /races/:raceId/respond
  router.put("/:raceId/respond", async (req, res) => {
    try {
      const { accept } = req.body;
      const participant = await respondToRaceInvite({
        userId: req.user.id,
        raceId: req.params.raceId,
        accept,
      });
      res.json({ participant });
    } catch (error) {
      if (error.name === "RaceInviteResponseError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Respond to race invite error:", error);
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
        return res.status(status).json({ error: error.message });
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
        req.timeZone
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
  router.post("/:raceId/powerups/:powerupId/use", async (req, res) => {
    try {
      const { targetUserId } = req.body;
      const result = await usePowerup({
        userId: req.user.id,
        raceId: req.params.raceId,
        powerupId: req.params.powerupId,
        targetUserId,
      });
      res.json({ result });
    } catch (error) {
      if (error.name === "PowerupUseError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
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
        return res.status(status).json({ error: error.message });
      }
      console.error("Discard powerup error:", error);
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
        return res.status(status).json({ error: error.message });
      }
      console.error("Cancel race error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createRacesRouter };
