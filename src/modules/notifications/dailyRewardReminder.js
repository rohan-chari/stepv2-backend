const { User } = require("../users");
const { DeviceToken } = require("../../shared/push/deviceToken");
const { JobRun } = require("../../shared/db/jobRun");
const { Notification } = require("./notification");
const { eventBus } = require("../../shared/events/eventBus");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
} = require("../../shared/time/week");

// Daily-reward reminder scheduler (§7). Backend-scheduled VISIBLE pushes (not
// local notifications) so the backend owns claim truth, can suppress the 9pm slot
// the moment a claim lands, and works when the app is terminated.
//
// Rides the shared 5-minute tick. Per tick it finds the IANA zones currently
// inside a reminder slot's 30-minute catch-up window, claims each (zone, slot,
// local-day) exactly once across the cluster via a JobRun CAS, then for each
// enrolled user in that zone whose free daily box is still unclaimed it does an
// INSERT-FIRST atomic delivery-key claim and emits the push. Two guards make it
// cross-process safe WITHOUT any advisory lock (commit 3e6c827's pool-exhaustion
// revert): the per-zone JobRun CAS avoids redundant user scans, and the per-user
// unique deliveryKey makes each individual send exactly-once.
//
// Kill switch: DAILY_REWARD_REMINDERS_DISABLED=true. Missed slots are skipped
// (30-minute catch-up window only) — unlike the ET self-healing daily jobs, we
// never fire a 5pm reminder at 11pm after a restart.

const TICK_INTERVAL_MS = 5 * 60 * 1000;
// Slots (local hour) and the 30-minute catch-up window.
const SLOTS = [17, 21];
const CATCH_UP_MINUTES = 30;
// Users with no recorded timezone fall back to this zone (§7 / extractTimezone).
// It is always a candidate zone so null-timezone users are still remindable at
// its local slot times until their real zone is captured.
const DEFAULT_ZONE = "America/New_York";

const REMINDER_TITLE = "Your daily box is waiting";
const REMINDER_BODY = "Your mystery box has been sitting here all day. Awkward.";

// A tick "at the slot" is one whose local time is in [slot:00, slot:30).
function zonesAtSlot(now, slot, zones, getParts) {
  const result = [];
  for (const zone of zones) {
    let parts;
    try {
      parts = getParts(now, zone);
    } catch {
      continue; // a malformed/legacy zone string — skip it
    }
    if (parts.hour === slot && parts.minute < CATCH_UP_MINUTES) result.push(zone);
  }
  return result;
}

// Claim-date suppression, biased to SILENCE (§7 "Correctness Trap"). lastDailyClaimDate
// is a client device-wall-clock string that can be ±1 day off from the tz-derived
// local date (traveler, header-vs-device tz). Suppress when it matches the local
// date OR either adjacent day: a missed nudge is invisible, but nagging someone
// who already claimed is a bug report.
function claimSuppresses(lastDailyClaimDate, localDate) {
  if (!lastDailyClaimDate) return false; // never claimed -> always eligible
  if (lastDailyClaimDate === localDate) return true;
  if (lastDailyClaimDate === addDaysToDateString(localDate, -1)) return true;
  if (lastDailyClaimDate === addDaysToDateString(localDate, 1)) return true;
  return false;
}

function buildDailyRewardReminder(dependencies = {}) {
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const jobRunModel = dependencies.JobRun || JobRun;
  const notificationModel = dependencies.Notification || Notification;
  const events = dependencies.eventBus || eventBus;
  const getParts = dependencies.getTimeZoneParts || getTimeZoneParts;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const isDisabled =
    dependencies.isDisabled ||
    (() => process.env.DAILY_REWARD_REMINDERS_DISABLED === "true");

  // Returns the emitted reminders this tick (for tests), or [] when disabled /
  // nothing due.
  return async function runDailyRewardReminder() {
    if (isDisabled()) return [];
    const currentTime = now();
    const emitted = [];

    let zones;
    try {
      zones = await userModel.distinctTimezones();
    } catch (error) {
      logger.error("[CRON] dailyRewardReminder: distinctTimezones failed:", error);
      return emitted;
    }
    // Always consider the default zone so null-timezone users (who fall back to
    // it) are remindable even before any user has a real zone recorded.
    const zoneSet = new Set(zones || []);
    zoneSet.add(DEFAULT_ZONE);
    zones = [...zoneSet];

    for (const slot of SLOTS) {
      const dueZones = zonesAtSlot(currentTime, slot, zones, getParts);
      for (const zone of dueZones) {
        // The zone's local calendar date is the day-key for BOTH the JobRun CAS
        // and each user's deliveryKey (all users in the zone share it).
        let localDate;
        try {
          const parts = getParts(currentTime, zone);
          localDate = formatDateString(parts.year, parts.month, parts.day);
        } catch {
          continue;
        }
        const jobName = `daily_reward_${slot}:${zone}`;

        // Per-zone CAS: only one worker per (zone, slot, local-day) scans users.
        let claimedZone = false;
        try {
          claimedZone = await jobRunModel.claimRun(jobName, localDate);
        } catch (error) {
          logger.error(
            `[CRON] dailyRewardReminder: claimRun failed for ${jobName}:`,
            error
          );
          continue;
        }
        if (!claimedZone) continue; // another worker owns this zone-slot-day

        let users;
        try {
          // Only the default zone bucket also picks up null-timezone users.
          users = await userModel.findRemindableInZones([zone], {
            includeNull: zone === DEFAULT_ZONE,
          });
        } catch (error) {
          logger.error(
            `[CRON] dailyRewardReminder: findRemindableInZones failed for ${zone}:`,
            error
          );
          continue;
        }

        for (const user of users || []) {
          try {
            // Re-check the claim-date suppression per user.
            if (claimSuppresses(user.lastDailyClaimDate, localDate)) continue;

            // Re-check ≥1 valid device token before claiming/sending.
            const tokens = await deviceTokenModel.findByUserId(user.id);
            if (!tokens || tokens.length === 0) continue;

            // INSERT-FIRST atomic per-user claim. This row IS the audit row; the
            // send handler skips writing a second one. A unique-violation means
            // another worker/tick already sent this slot today -> skip.
            const deliveryKey = `daily-reward:${user.id}:${localDate}:${slot}`;
            try {
              await notificationModel.create({
                userId: user.id,
                type: `DAILY_REWARD_REMINDER_${slot}`,
                title: REMINDER_TITLE,
                body: REMINDER_BODY,
                deliveryKey,
              });
            } catch (error) {
              if (error && error.code === "P2002") continue; // already claimed
              throw error;
            }

            events.emit("DAILY_REWARD_REMINDER", {
              userId: user.id,
              slot,
              title: REMINDER_TITLE,
              body: REMINDER_BODY,
            });
            emitted.push({ userId: user.id, slot, localDate });
          } catch (error) {
            logger.error(
              `[CRON] dailyRewardReminder: user ${user.id} slot ${slot} failed:`,
              error
            );
          }
        }
      }
    }

    if (emitted.length > 0) {
      logger.log(
        `[CRON] Daily-reward reminder: emitted ${emitted.length} reminders`
      );
    }
    return emitted;
  };
}

function scheduleDailyRewardReminder(dependencies = {}) {
  const run = buildDailyRewardReminder(dependencies);
  const logger = dependencies.logger || console;
  const interval = dependencies.intervalMs || TICK_INTERVAL_MS;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] dailyRewardReminder tick error:", error);
    }
  }

  tick(); // run once shortly after boot (no-op unless a zone is at a slot)
  setInterval(tick, interval);
  logger.log("[CRON] Daily-reward reminder scheduled (5pm & 9pm local)");
}

module.exports = {
  buildDailyRewardReminder,
  scheduleDailyRewardReminder,
  claimSuppresses,
  zonesAtSlot,
};
