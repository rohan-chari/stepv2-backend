const {
  addDaysToDateString,
  formatDateString,
  getTimeZoneParts,
  parseDateString,
  zonedDateTimeToUtc,
} = require("../../../shared/time/week");
const {
  FALLBACK_EVENT_TIMEZONE,
  LEGACY_GLOBAL,
} = require("../globalStepEvent");
const { deferUntilAfterCommit, isInPrismaTransactionScope } = require("../../../db");
const redisCache = require("../../../shared/cache/redisCache");

const TERMINAL_WORK_STATES = new Set([
  "CREATED",
  "ALL_ZERO",
  "UNSCORABLE",
  "EXPIRED_UNDELIVERED",
]);

function computeSummaryExpiresAt({ localDate, timezone }) {
  try {
    if (typeof localDate !== "string" || typeof timezone !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
    const original = parseDateString(localDate);
    const probe = new Date(Date.UTC(original.year, original.month - 1, original.day));
    if (
      probe.getUTCFullYear() !== original.year ||
      probe.getUTCMonth() + 1 !== original.month ||
      probe.getUTCDate() !== original.day
    ) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    const nextDate = addDaysToDateString(localDate, 1);
    const parts = parseDateString(nextDate);
    if (!parts) return null;
    const result = zonedDateTimeToUtc({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    }, timezone);
    return Number.isFinite(result?.getTime()) ? result : null;
  } catch {
    return null;
  }
}

function legacyGlobalSummaryEntitlement({ event, userId }) {
  if (!event || event.scheduleMode !== LEGACY_GLOBAL || !userId) return null;
  const parts = getTimeZoneParts(event.startsAt, FALLBACK_EVENT_TIMEZONE);
  return {
    event,
    eventId: event.id,
    userId,
    timezone: FALLBACK_EVENT_TIMEZONE,
    localDate: formatDateString(parts.year, parts.month, parts.day),
    startsAt: event.startsAt,
    endsAt: event.endsAt,
  };
}

async function createSummaryWorkForEntitlement(tx, entitlement, now = new Date()) {
  if (!entitlement?.event || entitlement.event.summaryAttributionVersion !== 2) {
    return null;
  }
  const expiresAt = computeSummaryExpiresAt({
    localDate: entitlement.localDate,
    timezone: entitlement.timezone,
  });
  if (!expiresAt) return null;
  const impacts = await tx.globalEventRaceImpact.findMany({
    where: {
      eventId: entitlement.eventId,
      userId: entitlement.userId,
    },
    select: { raceId: true, attributionVersion: true, status: true },
    orderBy: { raceId: "asc" },
  });
  const impactCount = impacts.length;
  const incompatible = impacts.some((impact) =>
    impact.attributionVersion !== 2 &&
    !(impact.attributionVersion === 1 && impact.status === "PENDING"));
  const expired = expiresAt.getTime() <= new Date(now).getTime();
  const initialStatus = incompatible
    ? "UNSCORABLE"
    : expired
      ? "EXPIRED_UNDELIVERED"
      : "WAITING_SYNC";
  const work = await tx.globalEventSummaryWork.upsert({
    where: {
      eventId_userId: {
        eventId: entitlement.eventId,
        userId: entitlement.userId,
      },
    },
    update: {},
    create: {
      eventId: entitlement.eventId,
      userId: entitlement.userId,
      expiresAt,
      status: initialStatus,
      requiredRaceCount: impactCount,
      availableAt: new Date(now),
      ...(incompatible
        ? { lastErrorCode: "DEPENDENCY_INPUT_UNREPLAYABLE" }
        : expired
          ? { lastErrorCode: "DEADLINE_PASSED" }
          : {}),
    },
  });
  if (expired || incompatible) {
    if (tx.jobRun) {
      await tx.jobRun.upsert({
        where: {
          jobName: `global_event_summary:${entitlement.eventId}:${entitlement.userId}:v2`,
        },
        update: {},
        create: {
          jobName: `global_event_summary:${entitlement.eventId}:${entitlement.userId}:v2`,
          lastRanFor: incompatible ? "UNSCORABLE" : "EXPIRED_UNDELIVERED",
        },
      });
    }
    // Terminal work is the durable handoff. The summary scheduler reconciles
    // its pending races in a later C0-only phase and stamps raceReconciledAt;
    // work-row transactions never acquire race C0 after the work lock.
  }
  if (isInPrismaTransactionScope()) {
    await deferUntilAfterCommit(() => redisCache.publishDurableQueueWakeup("summary"));
  }
  return work;
}

module.exports = {
  TERMINAL_WORK_STATES,
  computeSummaryExpiresAt,
  legacyGlobalSummaryEntitlement,
  createSummaryWorkForEntitlement,
};
