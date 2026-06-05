const { Router } = require("express");
const { recordSteps } = require("../commands/recordSteps");
const { recordStepSamples: defaultRecordStepSamples } = require("../commands/recordStepSamples");
const { getStepsByDate, getStepsHistory } = require("../queries/getSteps");
const { getStepCalendar: defaultGetStepCalendar } = require("../queries/getStepCalendar");
const { buildRequireAuth } = require("../middleware/requireAuth");
const { getMondayOfWeek, getTimeZoneParts } = require("../utils/week");
const { calculateStreak } = require("../utils/streak");
const { SeasonScore } = require("../models/season");

function createStepsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const saveSteps = dependencies.recordSteps || recordSteps;
  const readStepsByDate = dependencies.getStepsByDate || getStepsByDate;
  const readStepsHistory = dependencies.getStepsHistory || getStepsHistory;
  const recordSamples = dependencies.recordStepSamples || defaultRecordStepSamples;
  const getCalendar = dependencies.getStepCalendar || defaultGetStepCalendar;

  router.use(requireAuth);

  // POST /steps
  // Body: { steps, date, skipRaceResolution? }
  router.post("/", async (req, res) => {
    try {
      const { steps, date, skipRaceResolution } = req.body;

      if (steps == null || !date) {
        return res.status(400).json({ error: "steps and date are required" });
      }

      const record = await saveSteps({
        userId: req.user.id,
        steps,
        date,
        timeZone: req.timeZone,
        skipRaceResolution: skipRaceResolution === true,
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

      // 1.1.4 compat: clients pre-step-goal-removal expect stepGoal on each
      // record. Backfill with the legacy default so old UI renders cleanly.
      const COMPAT_STEP_GOAL = 5000;

      if (date) {
        const record = await readStepsByDate(req.user.id, date);
        return res.json({
          record: record ? { ...record, stepGoal: record.stepGoal ?? COMPAT_STEP_GOAL } : record,
        });
      }

      const records = await readStepsHistory(req.user.id);
      res.json({
        records: records.map((r) => ({ ...r, stepGoal: r.stepGoal ?? COMPAT_STEP_GOAL })),
      });
    } catch (error) {
      console.error("Steps query error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /steps/stats
  router.get("/stats", async (req, res) => {
    try {
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

      // Days-with-data denominators for per-day averages. One row per day
      // (unique (userId,date)), so each in-period row counts as one day.
      let weekDaysWithData = 0;
      let monthDaysWithData = 0;
      let yearDaysWithData = 0;

      // Build a date→steps map for streak calculation
      const dateMap = new Map();

      for (const record of allSteps) {
        const dateStr = new Date(record.date).toISOString().slice(0, 10);
        const steps = record.steps || 0;

        allTime += steps;
        if (dateStr >= yearStart) {
          thisYear += steps;
          yearDaysWithData += 1;
        }
        if (dateStr >= monthStart) {
          thisMonth += steps;
          monthDaysWithData += 1;
        }
        if (dateStr >= weekOf) {
          thisWeek += steps;
          weekDaysWithData += 1;
        }

        dateMap.set(dateStr, { steps });
      }

      // Per-day averages over days with recorded data. Guard divide-by-zero → 0.
      const avgPerDayWeek =
        weekDaysWithData > 0 ? Math.round(thisWeek / weekDaysWithData) : 0;
      const avgPerDayMonth =
        monthDaysWithData > 0 ? Math.round(thisMonth / monthDaysWithData) : 0;
      const avgPerDayYear =
        yearDaysWithData > 0 ? Math.round(thisYear / yearDaysWithData) : 0;

      const streak = calculateStreak(todayStr, dateMap);

      // Live ranked tier for the profile badge. Defensive: never let a ranked
      // lookup failure break the core stats response (older clients ignore
      // these fields anyway).
      const ranked = await SeasonScore.getActiveForUser(req.user.id).catch(
        () => null
      );

      res.json({
        thisWeek,
        thisMonth,
        thisYear,
        allTime,
        // Per-day averages over days with recorded data (totals above are
        // unchanged; additive fields are ignored by older clients).
        avgPerDayWeek,
        avgPerDayMonth,
        avgPerDayYear,
        streak,
        rankedTier: ranked ? ranked.provisionalTier : null,
        rankedDivision: ranked ? ranked.provisionalDivision : null,
        // 1.1.4 compat — legacy clients expect stepGoal on the stats payload.
        stepGoal: req.user.stepGoal ?? 5000,
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
