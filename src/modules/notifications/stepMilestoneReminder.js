const { User } = require("../users");
const { JobRun } = require("../../shared/db/jobRun");
const { Notification } = require("./notification");
const { eventBus } = require("../../shared/events/eventBus");
const { getTimeZoneParts, formatDateString } = require("../../shared/time/week");
const { zonesAtSlot } = require("./dailyRewardReminder");
const {
  STEP_MILESTONE_THRESHOLDS,
} = require("../steps/constants/stepMilestones");
const { userFanoutDisabled } = require("../../shared/config/operationalControls");

// Step-milestone evening reminder (batch 2026-08-08 item 3). Same skeleton as
// dailyRewardReminder.js — see that file's header for why the two guards (a
// per-zone JobRun CAS plus a per-user unique deliveryKey) make this safe across
// a pm2 cluster with NO advisory lock (commit 3e6c827).
//
// Differences from the daily-reward job:
//   * ONE slot (19:00 local) instead of two.
//   * Eligibility is a single SET-BASED query per zone (User
//     .findStepMilestoneRemindable) rather than a user scan plus an N+1
//     per-user device-token fetch: the token check is an EXISTS inside the SQL.
//   * Bias-to-silence is expressed in that same query — ANY milestone claim on
//     localDate-1/localDate/localDate+1 suppresses.
//
// The consolidated OPS_USER_FANOUTS_DISABLED brake is read at call time, so
// the job no-ops when all user fan-out is paused. Missed slots are skipped — a 30
// minute catch-up window only; we never fire a 7pm reminder at 11pm.

const TICK_INTERVAL_MS = 5 * 60 * 1000;
// Single slot (local hour). zonesAtSlot supplies the shared 30-min catch-up.
const SLOT = 19;
// Users with no recorded timezone fall back to this zone, and it is ALWAYS a
// candidate so they are remindable before their real zone is captured.
const DEFAULT_ZONE = "America/New_York";

const REMINDER_TITLE = "Coins waiting! 🪙";
const REMINDER_BODY =
  "You crossed a step milestone today. Collect your coins before midnight.";
const NOTIFICATION_TYPE = "STEP_MILESTONE_REMINDER";

const THRESHOLD_STEPS = STEP_MILESTONE_THRESHOLDS.map((t) => t.steps);

function buildStepMilestoneReminder(dependencies = {}) {
  const userModel = dependencies.User || User;
  const jobRunModel = dependencies.JobRun || JobRun;
  const notificationModel = dependencies.Notification || Notification;
  const events = dependencies.eventBus || eventBus;
  const getParts = dependencies.getTimeZoneParts || getTimeZoneParts;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const isDisabled =
    dependencies.isDisabled ||
    (() => userFanoutDisabled());

  // Returns the reminders emitted this tick (for tests), or [] when disabled /
  // nothing due.
  return async function runStepMilestoneReminder() {
    if (isDisabled()) return [];
    const currentTime = now();
    const emitted = [];

    let zones;
    try {
      zones = await userModel.distinctTimezones();
    } catch (error) {
      logger.error(
        "[CRON] stepMilestoneReminder: distinctTimezones failed:",
        error
      );
      return emitted;
    }
    const zoneSet = new Set(zones || []);
    zoneSet.add(DEFAULT_ZONE);
    zones = [...zoneSet];

    const dueZones = zonesAtSlot(currentTime, SLOT, zones, getParts);
    for (const zone of dueZones) {
      // The zone's local calendar date is the day-key for BOTH the JobRun CAS
      // and each user's deliveryKey.
      let localDate;
      try {
        const parts = getParts(currentTime, zone);
        localDate = formatDateString(parts.year, parts.month, parts.day);
      } catch {
        continue;
      }
      const jobName = `step-milestone-reminder:${zone}`;

      // Per-zone CAS: only one worker per (zone, local-day) scans users.
      let claimedZone = false;
      try {
        claimedZone = await jobRunModel.claimRun(jobName, localDate);
      } catch (error) {
        logger.error(
          `[CRON] stepMilestoneReminder: claimRun failed for ${jobName}:`,
          error
        );
        continue;
      }
      if (!claimedZone) continue; // another worker owns this zone-day

      let users;
      try {
        // Only the default zone bucket also picks up null-timezone users.
        users = await userModel.findStepMilestoneRemindable(zone, localDate, {
          includeNull: zone === DEFAULT_ZONE,
          thresholds: THRESHOLD_STEPS,
        });
      } catch (error) {
        logger.error(
          `[CRON] stepMilestoneReminder: eligibility query failed for ${zone}:`,
          error
        );
        continue;
      }

      for (const user of users || []) {
        try {
          // INSERT-FIRST atomic per-user claim. This row IS the audit row; the
          // send handler skips writing a second one. A unique violation means
          // another worker/tick already sent today -> skip.
          const deliveryKey = `step-milestone:${user.id}:${localDate}`;
          try {
            await notificationModel.create({
              userId: user.id,
              type: NOTIFICATION_TYPE,
              title: REMINDER_TITLE,
              body: REMINDER_BODY,
              deliveryKey,
            });
          } catch (error) {
            if (error && error.code === "P2002") continue; // already claimed
            throw error;
          }

          events.emit(NOTIFICATION_TYPE, {
            userId: user.id,
            title: REMINDER_TITLE,
            body: REMINDER_BODY,
            localDate,
          });
          emitted.push({ userId: user.id, localDate });
        } catch (error) {
          logger.error(
            `[CRON] stepMilestoneReminder: user ${user.id} failed:`,
            error
          );
        }
      }
    }

    if (emitted.length > 0) {
      logger.log(
        `[CRON] Step-milestone reminder: emitted ${emitted.length} reminders`
      );
    }
    return emitted;
  };
}

function scheduleStepMilestoneReminder(dependencies = {}) {
  const run = buildStepMilestoneReminder(dependencies);
  const logger = dependencies.logger || console;
  const interval = dependencies.intervalMs || TICK_INTERVAL_MS;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] stepMilestoneReminder tick error:", error);
    }
  }

  tick(); // run once shortly after boot (no-op unless a zone is at the slot)
  setInterval(tick, interval);
  logger.log("[CRON] Step-milestone reminder scheduled (7pm local)");
}

// Only the two entry points are exported — this file is re-exported through the
// notifications barrel, so generic names (SLOT, DEFAULT_ZONE, …) stay private.
module.exports = {
  buildStepMilestoneReminder,
  scheduleStepMilestoneReminder,
};
