const { Router } = require("express");
const { recordSteps } = require("../commands/recordSteps");
const { getStepsByDate, getStepsHistory } = require("../queries/getSteps");
const { User } = require("../models/user");
const { ChallengeInstance } = require("../models/challengeInstance");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");

function createStepsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const saveSteps = dependencies.recordSteps || recordSteps;
  const readStepsByDate = dependencies.getStepsByDate || getStepsByDate;
  const readStepsHistory = dependencies.getStepsHistory || getStepsHistory;
  const userModel = dependencies.User || User;

  router.use(requireAuth);

  // POST /steps
  // Body: { steps, date }
  router.post("/", async (req, res) => {
    try {
      const { steps, date } = req.body;

      if (steps == null || !date) {
        return res.status(400).json({ error: "steps and date are required" });
      }

      const record = await saveSteps({
        userId: req.user.id,
        steps,
        date,
      });
      res.json({ record });
    } catch (error) {
      console.error("Steps error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /steps?date=YYYY-MM-DD
  router.get("/", async (req, res) => {
    try {
      const { date } = req.query;

      if (date) {
        const record = await readStepsByDate(req.user.id, date);
        return res.json({ record });
      }

      const records = await readStepsHistory(req.user.id);
      res.json({ records });
    } catch (error) {
      console.error("Steps query error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /steps/stats
  router.get("/stats", async (req, res) => {
    try {
      const user = await userModel.findById(req.user.id);
      const stepGoal = user?.stepGoal || 5000;
      const allSteps = await readStepsHistory(req.user.id);

      const now = new Date();
      const parts = getTimeZoneParts(now);
      const todayStr = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
      const weekOf = getMondayOfWeek(now);
      const monthStart = `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
      const yearStart = `${parts.year}-01-01`;

      let thisWeek = 0;
      let thisMonth = 0;
      let thisYear = 0;
      let allTime = 0;

      // Build a date→steps map for streak calculation
      const dateMap = new Map();

      for (const record of allSteps) {
        const dateStr = new Date(record.date).toISOString().slice(0, 10);
        const steps = record.steps || 0;

        allTime += steps;
        if (dateStr >= yearStart) thisYear += steps;
        if (dateStr >= monthStart) thisMonth += steps;
        if (dateStr >= weekOf) thisWeek += steps;

        dateMap.set(dateStr, steps);
      }

      // Streak: consecutive days hitting step goal.
      // Start from yesterday so today being incomplete doesn't reset the streak.
      // Add today to the streak if it also qualifies.
      let streak = 0;
      const todaySteps = dateMap.get(todayStr) || 0;
      const todayHit = todaySteps >= stepGoal;

      for (let i = 1; ; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const dStr = d.toISOString().slice(0, 10);
        const daySteps = dateMap.get(dStr);
        if (daySteps === undefined || daySteps < stepGoal) break;
        streak++;
      }

      if (todayHit) streak++;

      // Challenge W/L record
      const { prisma } = require("../db");
      const completed = await prisma.challengeInstance.findMany({
        where: {
          status: "COMPLETED",
          OR: [{ userAId: req.user.id }, { userBId: req.user.id }],
          winnerUserId: { not: null },
        },
        select: { winnerUserId: true },
      });

      let wins = 0;
      let losses = 0;
      for (const inst of completed) {
        if (inst.winnerUserId === req.user.id) {
          wins++;
        } else {
          losses++;
        }
      }

      res.json({
        thisWeek,
        thisMonth,
        thisYear,
        allTime,
        streak,
        stepGoal,
        wins,
        losses,
      });
    } catch (error) {
      console.error("Stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createStepsRouter };
