const { Router } = require("express");
const { buildRequireAppleAuth } = require("../middleware/requireAppleAuth");
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
const {
  getChallengeStreaks: defaultGetChallengeStreaks,
  getChallengeStreakForFriend: defaultGetChallengeStreakForFriend,
} = require("../queries/getChallengeStreaks");

function createChallengesRouter(dependencies = {}) {
  const router = Router();
  const requireAppleAuth =
    dependencies.requireAppleAuth || buildRequireAppleAuth(dependencies);

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
  const getChallengeStreaks =
    dependencies.getChallengeStreaks || defaultGetChallengeStreaks;
  const getChallengeStreakForFriend =
    dependencies.getChallengeStreakForFriend ||
    defaultGetChallengeStreakForFriend;

  router.use(requireAppleAuth);

  // GET /challenges/current
  router.get("/current", async (req, res) => {
    try {
      const result = await getCurrentChallenge(req.user.id);
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

  // GET /challenges/streaks
  router.get("/streaks", async (req, res) => {
    try {
      const streaks = await getChallengeStreaks(req.user.id);
      res.json({ streaks });
    } catch (error) {
      console.error("Streaks error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /challenges/streaks/:friendUserId
  router.get("/streaks/:friendUserId", async (req, res) => {
    try {
      const streak = await getChallengeStreakForFriend(
        req.user.id,
        req.params.friendUserId
      );
      res.json({ streak });
    } catch (error) {
      console.error("Streak for friend error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /challenges/initiate
  router.post("/initiate", async (req, res) => {
    try {
      const { friendUserId } = req.body;
      const instance = await initiateChallenge({
        userId: req.user.id,
        friendUserId,
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
        req.params.instanceId
      );
      res.json({ progress });
    } catch (error) {
      console.error("Challenge progress error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createChallengesRouter };
