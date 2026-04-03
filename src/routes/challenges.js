const { Router } = require("express");
const { buildRequireAuth } = require("../middleware/requireAuth");
const {
  ChallengeInstance: defaultChallengeInstance,
} = require("../models/challengeInstance");
const {
  initiateChallenge: defaultInitiateChallenge,
} = require("../commands/initiateChallenge");
const {
  proposeStake: defaultProposeStake,
} = require("../commands/proposeStake");
const {
  respondToStake: defaultRespondToStake,
} = require("../commands/respondToStake");
const {
  getCurrentChallenge: defaultGetCurrentChallenge,
} = require("../queries/getCurrentChallenge");
const {
  getChallengeHistory: defaultGetChallengeHistory,
} = require("../queries/getChallengeHistory");
const {
  getChallengeProgress: defaultGetChallengeProgress,
} = require("../queries/getChallengeProgress");

function createChallengesRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);

  const initiateChallenge =
    dependencies.initiateChallenge || defaultInitiateChallenge;
  const proposeStake = dependencies.proposeStake || defaultProposeStake;
  const respondToStake = dependencies.respondToStake || defaultRespondToStake;
  const getCurrentChallenge =
    dependencies.getCurrentChallenge || defaultGetCurrentChallenge;
  const getChallengeHistory =
    dependencies.getChallengeHistory || defaultGetChallengeHistory;
  const getChallengeProgress =
    dependencies.getChallengeProgress || defaultGetChallengeProgress;
  const challengeInstanceModel =
    dependencies.ChallengeInstance || defaultChallengeInstance;

  router.use(requireAuth);

  // GET /challenges/current
  router.get("/current", async (req, res) => {
    try {
      const result = await getCurrentChallenge(req.user.id, req.timeZone);
      res.json(result);
    } catch (error) {
      console.error("Get current challenge error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /challenges/history
  router.get("/history", async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const result = await getChallengeHistory(req.user.id, { page, limit });
      res.json(result);
    } catch (error) {
      console.error("Challenge history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /challenges/initiate
  router.post("/initiate", async (req, res) => {
    try {
      const { friendUserId, stakeId } = req.body;

      if (!stakeId) {
        return res.status(400).json({ error: "stakeId is required" });
      }

      const instance = await initiateChallenge({
        userId: req.user.id,
        friendUserId,
        stakeId,
      });
      res.status(201).json({ instance });
    } catch (error) {
      if (error.name === "ChallengeInitiationError") {
        const status = error.statusCode || 409;
        return res.status(status).json({ error: error.message });
      }
      console.error("Challenge initiation error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /challenges/:instanceId/propose-stake
  router.post("/:instanceId/propose-stake", async (req, res) => {
    try {
      const { stakeId } = req.body;
      const instance = await proposeStake({
        userId: req.user.id,
        instanceId: req.params.instanceId,
        stakeId,
      });
      res.json({ instance });
    } catch (error) {
      if (error.name === "StakeNegotiationError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Propose stake error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /challenges/:instanceId/respond-stake
  router.put("/:instanceId/respond-stake", async (req, res) => {
    try {
      const { accept, counterStakeId } = req.body;
      const payload = {
        userId: req.user.id,
        instanceId: req.params.instanceId,
        accept,
        ...(counterStakeId !== undefined && { counterStakeId }),
      };
      const instance = await respondToStake(payload);
      res.json({ instance });
    } catch (error) {
      if (error.name === "StakeNegotiationError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Respond stake error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /challenges/:instanceId/progress
  router.get("/:instanceId/progress", async (req, res) => {
    try {
      const progress = await getChallengeProgress(
        req.user.id,
        req.params.instanceId,
        req.timeZone
      );
      res.json({ progress });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Challenge progress error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /challenges/:instanceId
  router.delete("/:instanceId", async (req, res) => {
    try {
      const instance = await challengeInstanceModel.findById(
        req.params.instanceId
      );

      if (!instance) {
        return res.status(404).json({ error: "Challenge not found" });
      }

      if (instance.userAId !== req.user.id && instance.userBId !== req.user.id) {
        return res.status(403).json({ error: "Not a participant" });
      }

      await challengeInstanceModel.deleteById(req.params.instanceId);
      res.json({ success: true });
    } catch (error) {
      console.error("Cancel challenge error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createChallengesRouter };
