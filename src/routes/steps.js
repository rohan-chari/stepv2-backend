const { Router } = require("express");
const { recordSteps } = require("../commands/recordSteps");
const { recordStepSamples: defaultRecordStepSamples } = require("../commands/recordStepSamples");
const { getStepsByDate, getStepsHistory } = require("../queries/getSteps");
const { getStepCalendar: defaultGetStepCalendar } = require("../queries/getStepCalendar");
const { User } = require("../models/user");
const { ChallengeInstance } = require("../models/challengeInstance");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");
const { calculateStreak } = require("../utils/streak");

function createStepsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const saveSteps = dependencies.recordSteps || recordSteps;
  const readStepsByDate = dependencies.getStepsByDate || getStepsByDate;
  const readStepsHistory = dependencies.getStepsHistory || getStepsHistory;
  const recordSamples = dependencies.recordStepSamples || defaultRecordStepSamples;
  const userModel = dependencies.User || User;
  const getCalendar = dependencies.getStepCalendar || defaultGetStepCalendar;

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
        timeZone: req.timeZone,
      });
      res.json({ record });
    } catch (error) {
      console.error("Steps error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /steps/samples
  // Body: { samples: [{ periodStart, periodEnd, steps }] }
  router.post("/samples", async (req, res) => {
    try {
      const { samples } = req.body;

      const result = await recordSamples({
        userId: req.user.id,
        samples,
        timeZone: req.timeZone,
      });
      res.json(result);
    } catch (error) {
      if (error.name === "StepSampleError") {
        const status = error.statusCode || 400;
        return res.status(status).json({ error: error.message });
      }
      console.error("Step samples error:", error);
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
      const parts = getTimeZoneParts(now, req.timeZone);
      const todayStr = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
      const weekOf = getMondayOfWeek(now, req.timeZone);
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

        dateMap.set(dateStr, { steps, stepGoal: record.stepGoal });
      }

      const streak = calculateStreak(todayStr, dateMap, stepGoal);

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

  // GET /steps/calendar?month=YYYY-MM
  router.get("/calendar", async (req, res) => {
    try {
      const { month } = req.query;

      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: "month query parameter required in YYYY-MM format" });
      }

      const result = await getCalendar(req.user.id, month, req.timeZone);
      res.json(result);
    } catch (error) {
      console.error("Calendar error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createStepsRouter };
