const { SUPPORT_ADDRESS, VISIBLE_FROM, googleWorkspaceFeedbackTransport } =
  require("../../modules/feedback/services/googleWorkspaceFeedbackTransport");
const { buildOperationalEmailAlertModel } = require("./operationalEmailAlertModel");

const SUBJECTS = Object.freeze({
  slow: "[Bara Prod] Race resolution slow (30s)",
  watchdog: "[Bara Prod] Race resolution watchdog restarted worker",
});

function operationalAlertMessage(alert) {
  const payload = alert.payload || {};
  const safeAttempt = String(payload.attemptId || alert.dedupeKey || "unknown")
    .toLowerCase()
    .replace(/[^0-9a-z-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const subject = SUBJECTS[alert.alertType];
  if (!subject) throw new Error("unknown operational alert type");
  const lines = [
    alert.alertType === "slow"
      ? "Race resolution has remained active for at least 30 seconds."
      : "The 60-second race-resolution watchdog restarted the dedicated worker.",
    "",
    `Environment: ${payload.environment || "unknown"}`,
    `Observed: ${payload.observedAt || "unknown"}`,
    `Attempt: ${payload.attemptId || "unknown"}`,
    `Job: ${payload.jobId || "unknown"}`,
    `Race: ${payload.raceId || "unknown"}`,
    `Active phase: ${payload.activePhase || "unknown"}`,
    `Parent phase: ${payload.parentPhase || "none"}`,
    `Phase elapsed ms: ${Number(payload.phaseElapsedMs || 0)}`,
    `Attempt elapsed ms: ${Number(payload.attemptElapsedMs || 0)}`,
    `Queue lag ms: ${Number(payload.queueLagMs || 0)}`,
    `Lease expiry: ${payload.leaseExpiresAt || "unknown"}`,
    `Lease status at capture: ${payload.leaseExpiresAt && Date.parse(payload.leaseExpiresAt) <= Date.parse(payload.observedAt) ? "expired" : "not expired or unknown"}`,
    `Work lanes: active=${Number(payload.workLaneActive || 0)}, queued-core=${Number(payload.workLaneQueuedCore || 0)}, queued-post=${Number(payload.workLaneQueuedPost || 0)}`,
    `Expired leases: ${payload.expiredLeaseCount == null ? "unknown" : Number(payload.expiredLeaseCount)}`,
  ];
  if (alert.alertType === "watchdog") {
    lines.push(
      `Authoritative commit completed: ${payload.authoritativeCommitCompleted === true ? "yes" : "no"}`,
      `Previous PID: ${payload.previousPid || payload.workerPid || "unknown"}`,
      `New PID: ${payload.newPid || "unknown"}`,
      `New boot time: ${payload.newBootedAt || "unknown"}`
    );
  }
  lines.push("", "Operator action: inspect correlated phase logs, queue health, PgBouncer, and Prisma errors.");
  return {
    operationalAlert: true,
    from: VISIBLE_FROM,
    to: SUPPORT_ADDRESS,
    subject,
    messageId: `<operational-${alert.alertType}-${safeAttempt}@barastep.com>`,
    text: `${lines.join("\n")}\n`,
  };
}

function buildOperationalEmailAlertDispatcher(dependencies = {}) {
  const processRole = dependencies.processRole || process.env.STEPS_PROCESS_ROLE || "all";
  const nodeEnv = dependencies.nodeEnv || process.env.NODE_ENV || "development";
  const model = dependencies.model || buildOperationalEmailAlertModel({ prisma: dependencies.prisma });
  const transport = dependencies.transport || googleWorkspaceFeedbackTransport;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  let running = false;

  return async function dispatchOperationalEmailAlert() {
    if (nodeEnv !== "production" || processRole !== "cron" || running) return 0;
    running = true;
    try {
      await model.reconcileExpiredSending({ now: now() });
      if (typeof model.scrubTerminalPayloads === "function") {
        await model.scrubTerminalPayloads({ now: now() });
      }
      const alert = await model.claimNext({ now: now() });
      if (!alert) return 0;
      let message;
      try {
        message = operationalAlertMessage(alert);
      } catch (error) {
        if (alert.attempts >= 5) {
          await model.markFailed({ id: alert.id, leaseToken: alert.leaseToken, errorCode: "MESSAGE_BUILD_FAILED", now: now() });
        } else {
          await model.retry({ id: alert.id, leaseToken: alert.leaseToken, attempts: alert.attempts, errorCode: "MESSAGE_BUILD_FAILED", now: now() });
        }
        return 1;
      }

      let acceptanceProven = false;
      try {
        const result = await transport.send(message);
        const accepted = Array.isArray(result?.accepted) ? result.accepted : [];
        const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
        if (
          accepted.length !== 1 ||
          String(accepted[0]).toLowerCase() !== SUPPORT_ADDRESS ||
          rejected.length !== 0
        ) {
          const error = new Error("Gmail acceptance was not confirmed");
          error.feedbackDelivery = "uncertain";
          error.safeCode = "gmail_acceptance_unconfirmed";
          throw error;
        }
        acceptanceProven = true;
        const finalized = await model.markAccepted({
          id: alert.id, leaseToken: alert.leaseToken, now: now(),
        });
        if (finalized?.count === 0) {
          const error = new Error("accepted delivery lost its finalization lease");
          error.feedbackDelivery = "uncertain";
          error.safeCode = "accepted_finalization_lease_lost";
          throw error;
        }
        logger.log(JSON.stringify({ event: "operational_email_alert_delivery", outcome: "accepted", alertType: alert.alertType }));
      } catch (error) {
        const errorCode = String(error?.safeCode || "DELIVERY_ERROR").slice(0, 64);
        if (acceptanceProven || error?.feedbackDelivery !== "unavailable") {
          try {
            await model.markUncertain({
              id: alert.id, leaseToken: alert.leaseToken, errorCode, now: now(),
            });
          } catch (finalizationError) {
            logger.error(JSON.stringify({
              event: "operational_email_alert_delivery",
              outcome: "uncertain_finalization_failed",
              alertType: alert.alertType,
              errorCode: String(finalizationError?.code || "FINALIZATION_FAILED").slice(0, 64),
            }));
          }
          logger.error(JSON.stringify({ event: "operational_email_alert_delivery", outcome: "uncertain", alertType: alert.alertType, errorCode }));
        } else if (alert.attempts >= 5) {
          await model.markFailed({ id: alert.id, leaseToken: alert.leaseToken, errorCode, now: now() });
          logger.error(JSON.stringify({ event: "operational_email_alert_delivery", outcome: "failed", alertType: alert.alertType, errorCode }));
        } else {
          await model.retry({ id: alert.id, leaseToken: alert.leaseToken, attempts: alert.attempts, errorCode, now: now() });
          logger.error(JSON.stringify({ event: "operational_email_alert_delivery", outcome: "retry", alertType: alert.alertType, errorCode }));
        }
      }
      return 1;
    } finally {
      running = false;
    }
  };
}

function scheduleOperationalEmailAlertDispatcher(dependencies = {}) {
  const run = buildOperationalEmailAlertDispatcher(dependencies);
  const intervalMs = 30_000;
  let stopped = false;
  let tickRunning = false;
  const tick = async () => {
    if (stopped || tickRunning) return;
    tickRunning = true;
    try {
      for (let count = 0; count < 25; count += 1) {
        if (await run() === 0) break;
      }
    } finally {
      tickRunning = false;
    }
  };
  const interval = setInterval(() => tick().catch(() => {}), intervalMs);
  interval.unref?.();
  tick().catch(() => {});
  return { interval, stop() { stopped = true; clearInterval(interval); } };
}

module.exports = {
  SUBJECTS,
  buildOperationalEmailAlertDispatcher,
  operationalAlertMessage,
  scheduleOperationalEmailAlertDispatcher,
};
