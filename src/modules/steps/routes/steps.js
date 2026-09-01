const { Router } = require("express");
const { recordSteps } = require("../commands/recordSteps");
const { assertFineSamplesAllowed } = require("../stepSyncCanonical");
const { recordStepSamples: defaultRecordStepSamples } = require("../commands/recordStepSamples");
const {
  recordStepSyncV2: defaultRecordStepSyncV2,
} = require("../commands/recordStepSyncV2");
const {
  RaceResolutionJob: defaultRaceResolutionJobModel,
  serializeRaceResolutionStatus,
} = require("../../races/models/raceResolutionJob");
const {
  RaceResolutionJobV2: defaultRaceResolutionJobV2Model,
} = require("../../races/models/raceResolutionJobV2");
const {
  RaceParticipant: defaultRaceParticipantModel,
} = require("../../races/models/raceParticipant");
const { getStepsByDate, getStepsHistory } = require("../queries/getSteps");
const { getStepCalendar: defaultGetStepCalendar } = require("../queries/getStepCalendar");
const { buildRequireAuth } = require("../../../middleware/requireAuth");
const { getMondayOfWeek, getTimeZoneParts } = require("../../../shared/time/week");
const { calculateStreak } = require("../streak");
const { SeasonScore } = require("../../ranked");
const {
  getProfileStats: defaultGetProfileStats,
} = require("../queries/getProfileStats");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../../shared/config/isStrictFlagEnabled");
const {
  raceResolutionIntakeDisabled,
} = require("../../../shared/config/operationalControls");
const {
  isPendingCheckoutTimeout,
} = require("../../../shared/observability/databasePoolTelemetry");
const {
  runWithStepTelemetryContext,
  recordStepTelemetryPhase,
  isStepTelemetryTransactionError,
  setStepAdmissionRelease,
} = require("../../../shared/observability/stepTelemetryContext");
const { createBoundedAdmission } = require("../../../shared/admission/boundedAdmission");
const { eventSurgeTelemetry: defaultEventSurgeTelemetry } = require("../../../shared/observability/eventSurgeTelemetry");

function classifyCaughtStepServerError(error) {
  if (isPendingCheckoutTimeout(error)) return "pool_checkout_timeout";
  if (isStepTelemetryTransactionError(error)) return "transaction_error";
  return "server_5xx";
}

// 64 KiB cap on the encoded sync-v2 body (§6.4). The app-wide express.json outer
// limit is unchanged; this is the tighter v2-specific bound.
const SYNC_V2_MAX_BYTES = 64 * 1024;
// Match the approved ten-connection HTTP pool. Real launch traffic is not
// evenly split across two long-lived worker connection sets; an eight-per-
// process ceiling rejected traffic on the busier worker while its peer still
// had unused write capacity. The database pool remains the hard concurrency
// ceiling and the bounded queue remains the overload guard.
const STEP_ADMISSION_CONCURRENCY = 6;
const STEP_ADMISSION_MAXIMUM_QUEUED = 128;
const STEP_ADMISSION_WAIT_MS = 2_000;

function createStepsRouter(dependencies = {}) {
  const router = Router();
  const requireAuth =
    dependencies.requireAuth || buildRequireAuth(dependencies);
  const saveSteps = dependencies.recordSteps || recordSteps;
  const readStepsByDate = dependencies.getStepsByDate || getStepsByDate;
  const readStepsHistory = dependencies.getStepsHistory || getStepsHistory;
  const recordSamples = dependencies.recordStepSamples || defaultRecordStepSamples;
  const recordStepSyncV2 =
    dependencies.recordStepSyncV2 || defaultRecordStepSyncV2;
  const raceResolutionJobModel =
    dependencies.RaceResolutionJob || defaultRaceResolutionJobModel;
  const raceResolutionJobV2Model =
    dependencies.RaceResolutionJobV2 || defaultRaceResolutionJobV2Model;
  const raceParticipantModel =
    dependencies.RaceParticipant || defaultRaceParticipantModel;
  const getCalendar = dependencies.getStepCalendar || defaultGetStepCalendar;
  const getProfileStats =
    dependencies.getProfileStats || defaultGetProfileStats;
  const settings = dependencies.appSettings || defaultAppSettings;
  const stepTelemetry = dependencies.stepTelemetry || null;
  const admissionTelemetry = dependencies.eventSurgeTelemetry || defaultEventSurgeTelemetry;
  const stepAdmission = dependencies.stepAdmission || createBoundedAdmission({
    concurrency: STEP_ADMISSION_CONCURRENCY,
    maximumQueued: STEP_ADMISSION_MAXIMUM_QUEUED,
    waitMs: STEP_ADMISSION_WAIT_MS,
  });

  const telemetryEndpoint = (req) => {
    if (req.method !== "POST") return null;
    if (req.path === "/") return "steps";
    if (req.path === "/samples") return "samples";
    if (req.path === "/sync-v2") return "sync-v2";
    return null;
  };

  router.use((req, res, next) => {
    const endpoint = telemetryEndpoint(req);
    if (!endpoint) return next();
    const startedAt = process.hrtime.bigint();
    const telemetryContext = { phases: {}, phaseObservations: {} };
    if (typeof stepTelemetry?.recordStepRequest !== "function") {
      return runWithStepTelemetryContext(telemetryContext, next);
    }
    res.locals.stepTelemetryStartedAt = startedAt;
    res.once("finish", () => {
      const status = res.statusCode;
      const outcome = res.locals.stepTelemetryOutcome ||
        (status >= 200 && status < 400 ? "success" :
          ([401, 403].includes(status) ? "auth_4xx" :
            (status >= 400 && status < 500 ? "validation_4xx" : "server_5xx")));
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      try {
        stepTelemetry.recordStepRequest({
          endpoint,
          outcome,
          durationMs,
          authenticationDurationMs: res.locals.stepTelemetryAuthDurationMs ?? durationMs,
          ...(telemetryContext.phases.checkout_wait != null
            ? {
                checkoutWaitMs: telemetryContext.phases.checkout_wait,
                checkoutWaitDurationsMs: telemetryContext.phaseObservations.checkout_wait,
              }
            : {}),
          ...(telemetryContext.phases.transaction_total != null
            ? {
                transactionDurationMs: telemetryContext.phases.transaction_total,
                transactionDurationsMs: telemetryContext.phaseObservations.transaction_total,
              }
            : {}),
        });
        for (const [phase, observations] of Object.entries(telemetryContext.phaseObservations)) {
          for (const phaseDurationMs of observations) {
            stepTelemetry.recordStepPhase?.({ phase, durationMs: phaseDurationMs, samplingRate: 1 });
          }
        }
      } catch {}
    });
    runWithStepTelemetryContext(telemetryContext, next);
  });

  // Permanent write-work bulkhead for the three canonical step POST contracts.
  // Reject excess write work before authentication or any database access.
  router.use(async (req, res, next) => {
    const endpoint = telemetryEndpoint(req);
    if (!endpoint) return next();
    const started = process.hrtime.bigint();
    try {
      const release = await stepAdmission.acquire();
      const waitMs = Number(process.hrtime.bigint() - started) / 1e6;
      const admittedState = stepAdmission.snapshot?.() || {};
      admissionTelemetry?.recordStepAdmission?.({
        outcome: "admitted", waitMs,
        active: admittedState.active, queued: admittedState.queued,
      });
      let released = false;
      let finished = false;
      const releasePermit = () => {
        if (released) return;
        released = true;
        release();
      };
      setStepAdmissionRelease(releasePermit);
      const finish = () => {
        if (finished) return;
        finished = true;
        const state = stepAdmission.snapshot?.() || admittedState;
        admissionTelemetry?.recordStepAdmission?.({
          outcome: res.statusCode >= 500 ? "failed" : "succeeded",
          waitMs, active: state.active, queued: state.queued,
        });
        releasePermit();
      };
      res.once("finish", finish);
      res.once("close", finish);
      return next();
    } catch {
      const waitMs = Number(process.hrtime.bigint() - started) / 1e6;
      const state = stepAdmission.snapshot?.() || {};
      admissionTelemetry?.recordStepAdmission?.({
        outcome: "rejected", waitMs, active: state.active, queued: state.queued,
      });
      res.locals.stepTelemetryOutcome = "server_5xx";
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  router.use((req, res, next) => {
    res.locals.stepTelemetryAuthStartedAt = process.hrtime.bigint();
    next();
  });
  router.use(requireAuth);
  router.use((req, res, next) => {
    if (res.locals.stepTelemetryStartedAt != null) {
      const authStartedAt = res.locals.stepTelemetryAuthStartedAt ||
        res.locals.stepTelemetryStartedAt;
      const durationMs = Number(process.hrtime.bigint() - authStartedAt) / 1e6;
      res.locals.stepTelemetryAuthDurationMs = durationMs;
      recordStepTelemetryPhase("authentication", durationMs);
    }
    next();
  });

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
      res.locals.stepTelemetryOutcome = classifyCaughtStepServerError(error);
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
      res.locals.stepTelemetryOutcome = classifyCaughtStepServerError(error);
      console.error("Step samples error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /steps/sync-v2 (§6.4)
  // Persist the daily total + optional hourly samples in one request,
  // synchronously reconcile the UPLOADER's own race totals/box state, then
  // enqueue durable full-field reconciliation. Async-capable NEW clients only;
  // old clients keep POST /steps + POST /steps/samples. Declared before the
  // parameterless GET "/" so it never collides. Static path.
  router.post("/sync-v2", async (req, res) => {
    // Kill switch: return 503 BEFORE any step/sample/idempotency/queue write so
    // the client can safely run legacy sync without duplicating a v2 persist.
    if (raceResolutionIntakeDisabled()) {
      return res.status(503).json({
        error: "Step sync temporarily unavailable",
        code: "ASYNC_DISABLED",
      });
    }

    // 64 KiB body cap (§6.4). Reject oversized encoded requests with the 413
    // contract before doing any work.
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > SYNC_V2_MAX_BYTES) {
      return res.status(413).json({
        error: "Step sync request too large",
        code: "STEP_SYNC_TOO_LARGE",
      });
    }

    try {
      // Below-floor builds may not submit fine-grained samples (see
      // assertFineSamplesAllowed) — checked here where the version header lives.
      assertFineSamplesAllowed(
        Array.isArray(req.body?.samples) ? req.body.samples : [],
        req.headers["x-app-version"]
      );
      const response = await recordStepSyncV2({
        userId: req.user.id,
        body: req.body,
        idempotencyKey: req.headers["idempotency-key"],
        timeZone: req.timeZone,
        // Exact case-sensitive value only. Headerless and any other value keep
        // the legacy unrestricted sync contract.
        homePull: req.get("X-Step-Sync-Intent") === "home-pull",
      });
      if (
        req.clientFeatures?.has("impact_summaries") !== true ||
        req.clientFeatures?.has("impact_summary_expiry_v1") !== true
      ) {
        const legacyResponse = { ...response };
        delete legacyResponse.globalEventSummaryWork;
        return res.status(202).json(legacyResponse);
      }
      res.status(202).json(response);
    } catch (error) {
      // Validation (bad shape) and manual-sample rejection both → 400.
      if (
        error.code === "INVALID_STEP_SYNC" ||
        error.name === "StepSyncValidationError" ||
        error.name === "StepSampleError"
      ) {
        res.locals.stepTelemetryOutcome = "validation_4xx";
        return res
          .status(400)
          .json({ error: error.message, code: "INVALID_STEP_SYNC" });
      }
      if (error.code === "STEP_SYNC_COOLDOWN" || error.name === "StepSyncCooldownError") {
        res.locals.stepTelemetryOutcome = "validation_4xx";
        const retryAfterSeconds = Math.max(1, Math.min(30, Number(error.retryAfterSeconds) || 1));
        return res
          .status(429)
          .set("Retry-After", String(retryAfterSeconds))
          .set("Cache-Control", "no-store")
          .json({
            error: "Step sync is cooling down",
            code: "STEP_SYNC_COOLDOWN",
            retryAfterSeconds,
          });
      }
      if (
        error.code === "IDEMPOTENCY_CONFLICT" ||
        error.name === "StepSyncConflictError"
      ) {
        res.locals.stepTelemetryOutcome = "validation_4xx";
        return res.status(409).json({
          error: "Idempotency key already used",
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      res.locals.stepTelemetryOutcome = classifyCaughtStepServerError(error);
      console.error("Step sync v2 error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /steps/race-resolution/:jobId?generation=<int> (§6.5)
  // Owner-only foreground status poll for the durable resolution job. The Home
  // indicator never waits on this. Additive; old clients never call it.
  router.get("/race-resolution/:jobId", async (req, res) => {
    try {
      const generation = Number(req.query.generation);
      if (!Number.isInteger(generation) || generation < 1) {
        return res
          .status(400)
          .json({ error: "Valid generation is required", code: "INVALID_GENERATION" });
      }
      // C0: jobs are RACE-keyed now, so ownership is "the caller is an accepted
      // participant of the job's race" rather than "the job's user_id is the
      // caller". The v1 lookup stays as a FALLBACK so a job id handed out by an
      // old binary moments before a pm2 reload still resolves for its poller —
      // the response shape is identical either way.
      // Defensive: a v2 read failure (table absent on an old DB, injected model
      // that only knows v1) must degrade to the v1 lookup, never 500 a poll.
      let v2Job = null;
      try {
        v2Job = await raceResolutionJobV2Model.findById(req.params.jobId);
      } catch {
        v2Job = null;
      }
      if (v2Job) {
        let isParticipant;
        if (
          typeof raceParticipantModel.existsAcceptedByRaceAndUser ===
          "function"
        ) {
          isParticipant = await raceParticipantModel.existsAcceptedByRaceAndUser(
            v2Job.raceId,
            req.user.id
          );
        } else {
          // Compatibility for older injected/model implementations during a
          // rolling deploy. Production uses the narrow indexed query above.
          const participants = await raceParticipantModel.findAcceptedByRace(
            v2Job.raceId
          );
          isParticipant = (participants || []).some(
            (p) => p.userId === req.user.id
          );
        }
        if (!isParticipant) {
          return res.status(404).json({ error: "Race resolution job not found" });
        }
        return res.json({
          raceResolution: serializeRaceResolutionStatus(v2Job, generation),
        });
      }

      const job = await raceResolutionJobModel.findById(req.params.jobId);
      // Unknown OR not owned by the caller → 404, to avoid leaking identifiers.
      if (!job || job.userId !== req.user.id) {
        return res.status(404).json({ error: "Race resolution job not found" });
      }
      res.json({ raceResolution: serializeRaceResolutionStatus(job, generation) });
    } catch (error) {
      console.error("Race resolution status error:", error);
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
      const now = new Date();
      const parts = getTimeZoneParts(now, req.timeZone);
      const todayStr = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
      const weekOf = getMondayOfWeek(now, req.timeZone);
      const monthStart = `${parts.year}-${String(parts.month).padStart(2, "0")}-01`;
      const yearStart = `${parts.year}-01-01`;

      const compact =
        req.query.view === "profile-v1" &&
        (await isStrictFlagEnabled(settings, "apiProfileStatsV1Enabled"));
      if (compact) {
        const profile = await getProfileStats({
          userId: req.user.id,
          today: todayStr,
          weekStart: weekOf,
          monthStart,
          yearStart,
        });
        // The compact stats contract already ships in frozen binaries. Keep its
        // exact historical payload unless the carrying profile build declares
        // it can render the positive-only podium card.
        if (req.clientFeatures?.has("profile_podiums") !== true) {
          delete profile.racePodiums;
        }
        return res.json(profile);
      }

      const allSteps = await readStepsHistory(req.user.id);

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
        // Ranked v2 home tier (weekly cohorts, app >= 1.3.0). Additive; old
        // clients keep reading rankedTier/rankedDivision above. Null until the
        // user's first settled week.
        rankedTierV2: req.user.rankedTierV2 ?? null,
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

module.exports = {
  createStepsRouter,
  STEP_ADMISSION_CONCURRENCY,
  STEP_ADMISSION_MAXIMUM_QUEUED,
  STEP_ADMISSION_WAIT_MS,
};
