const { User } = require("../users");
const { JobRun } = require("../../shared/db/jobRun");
const { prisma: defaultPrisma } = require("../../db");
const { Prisma } = require("@prisma/client");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../domainEvents");
const {
  getTimeZoneParts,
  formatDateString,
  addDaysToDateString,
  nextMidnightNewYork,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../shared/time/week");
const { userFanoutDisabled } = require("../../shared/config/operationalControls");

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
const SLOTS = [17];
const CATCH_UP_MINUTES = 30;
// Users with no recorded timezone fall back to this zone (§7 / extractTimezone).
// It is always a candidate zone so null-timezone users are still remindable at
// its local slot times until their real zone is captured.
const DEFAULT_ZONE = "America/New_York";

const REMINDER_COPY = Object.freeze({
  MYSTERY_BOX: Object.freeze({
    title: "Your mystery box is waiting",
    body: "Open it before your race ends.",
  }),
  DAILY_REWARD: Object.freeze({
    title: "Your daily reward is waiting",
    body: "Claim today's reward before midnight.",
  }),
});

async function findReminderCandidates(db, zone, { includeNull, currentTime }) {
  const zoneFilter = includeNull
    ? Prisma.sql`(u."timezone" = ${zone} OR u."timezone" IS NULL)`
    : Prisma.sql`u."timezone" = ${zone}`;
  return db.$queryRaw(Prisma.sql`
    SELECT u."id",
           u."last_daily_claim_date" AS "lastDailyClaimDate",
           mystery."raceId" AS "mysteryBoxRaceId"
      FROM "users" u
      LEFT JOIN LATERAL (
        SELECT rpup."race_id" AS "raceId"
          FROM "race_powerups" rpup
          JOIN "race_participants" participant
            ON participant."id" = rpup."participant_id"
           AND participant."user_id" = u."id"
           AND participant."status" = 'accepted'::"RaceParticipantStatus"
          JOIN "races" race
            ON race."id" = rpup."race_id"
           AND race."status" = 'active'::"RaceStatus"
           AND race."ends_at" > ${currentTime}
         WHERE rpup."user_id" = u."id"
           AND rpup."status" = 'mystery_box'::"PowerupStatus"
           AND rpup."type" IS NULL
         ORDER BY race."ends_at" ASC, rpup."id" ASC
         LIMIT 1
      ) mystery ON TRUE
     WHERE u."daily_reward_reminders_enabled" = TRUE
       AND u."is_review_account" = FALSE
       AND ${zoneFilter}
     ORDER BY u."id" ASC
  `);
}

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
  const jobRunModel = dependencies.JobRun || JobRun;
  const db = dependencies.prisma || defaultPrisma;
  const compatibilityEvents = dependencies.eventBus || null;
  const compatibilityDeviceTokens = dependencies.DeviceToken || null;
  const compatibilityNotifications = dependencies.Notification || null;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  const durable = !dependencies.eventBus && !dependencies.Notification && !dependencies.DeviceToken;
  const getParts = dependencies.getTimeZoneParts || getTimeZoneParts;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const isDisabled =
    dependencies.isDisabled ||
    (() => userFanoutDisabled("DAILY_REWARD_REMINDERS_DISABLED"));

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

        // Durable fan-out marks completion only after every deterministic
        // per-user append has succeeded. A crash before or midway leaves the
        // day open; replay safely confirms already-appended event keys and
        // resumes the rest. Legacy injected delivery keeps its historical
        // insert-first zone claim.
        let claimedZone = false;
        try {
          if (durable) {
            claimedZone = (await jobRunModel.lastRanFor(jobName)) !== localDate;
          } else {
            claimedZone = await jobRunModel.claimRun(jobName, localDate);
          }
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
          users = durable && typeof db.$queryRaw === "function"
            ? await findReminderCandidates(db, zone, {
                includeNull: zone === DEFAULT_ZONE,
                currentTime,
              })
            : await userModel.findRemindableInZones([zone], {
                includeNull: zone === DEFAULT_ZONE,
              });
        } catch (error) {
          logger.error(
            `[CRON] dailyRewardReminder: findRemindableInZones failed for ${zone}:`,
            error
          );
          continue;
        }

        let fanoutComplete = true;
        const localDay = parseDateString(localDate);
        const occurrenceAt = zonedDateTimeToUtc({
          ...localDay,
          hour: slot,
          minute: 0,
          second: 0,
        }, zone);
        const expiresAt = nextMidnightNewYork(occurrenceAt, zone);
        for (const user of users || []) {
          try {
            // Re-check the claim-date suppression per user.
            const rewardType = user.mysteryBoxRaceId ? "MYSTERY_BOX" : "DAILY_REWARD";
            const copy = REMINDER_COPY[rewardType];
            if (rewardType === "DAILY_REWARD" &&
                claimSuppresses(user.lastDailyClaimDate, localDate)) continue;

            const reminder = {
              userId: user.id,
              slot,
              localDate,
              title: copy.title,
              body: copy.body,
              rewardType,
              ...(user.mysteryBoxRaceId ? { raceId: user.mysteryBoxRaceId } : {}),
            };
            if (durable) {
              await db.$transaction((tx) => appendDomainEvent(tx, {
                eventKey: `UNCLAIMED_REWARD:${user.id}:${localDate}`,
                eventType: "UNCLAIMED_REWARD_REMINDER_V1", schemaVersion: 1,
                aggregateType: "USER", aggregateId: user.id,
                occurredAt: occurrenceAt,
                payload: {
                  userId: user.id,
                  slot,
                  title: copy.title,
                  body: copy.body,
                  localDate,
                  rewardType,
                  ...(user.mysteryBoxRaceId ? { raceId: user.mysteryBoxRaceId } : {}),
                },
                audience: [{ recipientId: user.id, facts: {
                  timeZone: zone,
                  expiresAt,
                } }],
              }));
            } else {
              // Explicitly injected legacy collaborators are retained for old
              // internal callers and narrow unit doubles. Production never
              // enters this branch: notification delivery is projected from
              // the durable domain event and token presence is irrelevant to
              // whether the Inbox intent exists.
              if (compatibilityDeviceTokens) {
                const tokens = await compatibilityDeviceTokens.findByUserId(user.id);
                if (!tokens?.length) continue;
              }
              if (compatibilityNotifications) {
                try {
                  await compatibilityNotifications.create({
                    userId: user.id,
                    type: "UNCLAIMED_REWARD",
                    title: copy.title,
                    body: copy.body,
                    deliveryKey: `unclaimed-reward:${user.id}:${localDate}`,
                  });
                } catch (error) {
                  if (error?.code === "P2002") continue;
                  throw error;
                }
              }
              compatibilityEvents?.emit("DAILY_REWARD_REMINDER", reminder);
            }
            emitted.push({
              userId: user.id,
              slot,
              localDate,
              rewardType,
              ...(user.mysteryBoxRaceId ? { raceId: user.mysteryBoxRaceId } : {}),
            });
          } catch (error) {
            fanoutComplete = false;
            logger.error(
              `[CRON] dailyRewardReminder: user ${user.id} slot ${slot} failed:`,
              error
            );
          }
        }
        if (durable && fanoutComplete) {
          try {
            await jobRunModel.markRan(jobName, localDate);
          } catch (error) {
            // All event keys are deterministic, so a marker failure is safe:
            // the next tick re-confirms them before retrying this completion.
            logger.error(`[CRON] dailyRewardReminder: markRan failed for ${jobName}:`, error);
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
  logger.log("[CRON] Unclaimed-reward reminder scheduled (5pm local)");
}

module.exports = {
  buildDailyRewardReminder,
  scheduleDailyRewardReminder,
  claimSuppresses,
  zonesAtSlot,
  findReminderCandidates,
};
