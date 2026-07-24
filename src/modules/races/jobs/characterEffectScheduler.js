const { prisma: defaultPrisma } = require("../../../db");
const { eventBus } = require("../../../shared/events/eventBus");
const { CharacterEffectWindow } = require("../../powerups/models/characterEffectWindow");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const {
  getTimeZoneParts,
  formatDateString,
  zonedDateTimeToUtc,
} = require("../../../shared/time/week");
const {
  characterPowersEnabled,
  zoomiesPushDisabled,
  drawZoomiesStartMinutes,
  ZOOMIES_MULTIPLIER,
  ZOOMIES_WINDOW_MS,
  ZOOMIES_SLOTS,
} = require("../services/characterPowers");

// Corgi "Zoomies" materialization (§3.6.2). Runs on the same 5-minute cron
// cadence as the other schedulers. Two responsibilities per tick:
//   1. For every corgi-equipped user, draw + INSERT-FIRST their two secret
//      10-minute 3x windows for their local day (idempotent via the
//      @@unique([userId, localDayKey, slot]) constraint — cluster-safe, NEVER an
//      advisory lock across the callback, per the 3e6c827 outage rule).
//   2. Emit a "ZOOMIES_STARTED" push for any window that is live now and not yet
//      notified, claimed via a CAS notifiedAt flip so cluster workers never
//      double-send.
// Gated entirely behind CHARACTER_POWERS_ENABLED; the push respects
// ZOOMIES_PUSH_DISABLED.
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TZ = "America/New_York";

function buildMaterializeZoomies(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const windowModel = dependencies.CharacterEffectWindow || CharacterEffectWindow;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const enabledFn = dependencies.characterPowersEnabled || characterPowersEnabled;
  const pushDisabledFn = dependencies.zoomiesPushDisabled || zoomiesPushDisabled;

  async function findCorgiUsers() {
    const equips = await prisma.userEquippedAccessory.findMany({
      where: {
        shopItem: { slot: "CHARACTER", assetKey: { startsWith: "corgi" } },
      },
      select: { userId: true, user: { select: { id: true, timezone: true } } },
    });
    const byId = new Map();
    for (const e of equips) {
      if (e.user && !byId.has(e.user.id)) {
        byId.set(e.user.id, { id: e.user.id, timezone: e.user.timezone });
      }
    }
    return [...byId.values()];
  }

  return async function materializeZoomies() {
    if (!enabledFn()) return null;
    const currentTime = now();

    let corgiUsers = [];
    try {
      corgiUsers = await findCorgiUsers();
    } catch (error) {
      logger.error("[CRON] zoomies: corgi user lookup failed:", error);
      return null;
    }

    // 1. Materialize today's two windows for each corgi user (insert-first).
    for (const user of corgiUsers) {
      const tz = user.timezone || DEFAULT_TZ;
      let parts;
      try {
        parts = getTimeZoneParts(currentTime, tz);
      } catch {
        parts = getTimeZoneParts(currentTime, DEFAULT_TZ);
      }
      const localDayKey = formatDateString(parts.year, parts.month, parts.day);
      const startMins = drawZoomiesStartMinutes(user.id, localDayKey);
      for (let slot = 0; slot < ZOOMIES_SLOTS; slot++) {
        const startMin = startMins[slot];
        const startsAt = zonedDateTimeToUtc(
          {
            year: parts.year,
            month: parts.month,
            day: parts.day,
            hour: Math.floor(startMin / 60),
            minute: startMin % 60,
            second: 0,
          },
          tz
        );
        const endsAt = new Date(startsAt.getTime() + ZOOMIES_WINDOW_MS);
        try {
          await windowModel.createIfAbsent({
            userId: user.id,
            animal: "corgi",
            multiplier: ZOOMIES_MULTIPLIER,
            startsAt,
            endsAt,
            localDayKey,
            slot,
          });
        } catch (error) {
          logger.error(
            `[CRON] zoomies: materialize failed (user ${user.id}, slot ${slot}):`,
            error
          );
        }
      }
    }

    // 2. Push for windows live now, claimed once via CAS notifiedAt.
    if (!pushDisabledFn()) {
      let due = [];
      try {
        due = await windowModel.findDueForNotify(currentTime);
      } catch (error) {
        logger.error("[CRON] zoomies: due-for-notify query failed:", error);
        due = [];
      }
      for (const w of due) {
        try {
          const claimed = await windowModel.claimNotify(w.id, currentTime);
          if (claimed) {
            events.emit("ZOOMIES_STARTED", {
              userId: w.userId,
              endsAt: w.endsAt,
              multiplier: Number(w.multiplier) || ZOOMIES_MULTIPLIER,
            });
          }
        } catch (error) {
          logger.error(`[CRON] zoomies: push claim failed (${w.id}):`, error);
        }
      }
    }

    return { corgiUsers: corgiUsers.length };
  };
}

const materializeZoomies = buildMaterializeZoomies();

function scheduleCharacterEffects(dependencies = {}) {
  const interval = dependencies.intervalMs || SCHEDULER_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const runFn = dependencies.materializeZoomies || materializeZoomies;

  async function run() {
    try {
      await runFn();
    } catch (error) {
      logger.error("[CRON] Character effect scheduler error:", error);
    }
  }

  run();
  const timer = setInterval(run, interval);
  if (timer.unref) timer.unref();
  logger.log(
    `[CRON] Character effect (zoomies) scheduler scheduled (every ${interval / 1000}s)`
  );
}

// ── Retention (§3.6.2): prune window rows older than 45 days ─────────────────
const RETENTION_JOB_NAME = "character_effect_window_retention";
const RETENTION_DAYS = 45;
const RETENTION_TICK_MS = 5 * 60 * 1000;
const RETENTION_TARGET_HOUR_ET = 4; // off-peak, distinct from step retention (3am)

function buildCleanupCharacterEffectWindows(dependencies = {}) {
  const windowModel = dependencies.CharacterEffectWindow || CharacterEffectWindow;
  const jobRunModel = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const retentionDays = dependencies.retentionDays || RETENTION_DAYS;

  return async function cleanupCharacterEffectWindows() {
    const currentTime = now();
    const lastRanFor = await jobRunModel.lastRanFor(RETENTION_JOB_NAME);
    const runKey = dailyRunKey({
      now: currentTime,
      targetHour: dependencies.targetHour ?? RETENTION_TARGET_HOUR_ET,
      lastRanFor,
    });
    if (!runKey) return null;

    let claimed = false;
    try {
      claimed = await jobRunModel.claimRun(RETENTION_JOB_NAME, runKey);
    } catch (error) {
      logger.error("[CRON] characterEffectWindowRetention: claimRun failed:", error);
      return null;
    }
    if (!claimed) return null;

    const cutoff = new Date(
      currentTime.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );
    const count = await windowModel.deleteEndedBefore(cutoff);
    logger.log(
      `[CRON] character_effect_windows retention: deleted ${count} rows ended before ${cutoff.toISOString()}`
    );
    return { count };
  };
}

function scheduleCharacterEffectRetention(dependencies = {}) {
  const run = buildCleanupCharacterEffectWindows(dependencies);
  const logger = dependencies.logger || console;
  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] characterEffectWindowRetention tick error:", error);
    }
  }
  tick();
  const timer = setInterval(tick, dependencies.intervalMs || RETENTION_TICK_MS);
  if (timer.unref) timer.unref();
  logger.log("[CRON] character_effect_windows retention scheduled (4am ET, 45d)");
}

module.exports = {
  buildMaterializeZoomies,
  materializeZoomies,
  scheduleCharacterEffects,
  buildCleanupCharacterEffectWindows,
  scheduleCharacterEffectRetention,
  SCHEDULER_INTERVAL_MS,
};
