const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const {
  createInboxAlert: defaultCreateInboxAlert,
  invalidateInboxUnread,
} = require("../../inbox/services/inbox");
const { deferUntilAfterCommit } = require("../../../db");
const redisCache = require("../../../shared/cache/redisCache");
const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");

const SCHEDULE_PENDING = "PENDING";
const SCHEDULE_CLAIMED = "CLAIMED";
const SCHEDULE_MATERIALIZED = "MATERIALIZED";
const SCHEDULE_EXPIRED = "EXPIRED";
const SCHEDULE_CANCELED = "CANCELLED";
const GLOBAL_EVENT_ELIGIBLE = "ELIGIBLE";
const GLOBAL_EVENT_PENDING_ACTIVATION = "PENDING_ACTIVATION";
const GLOBAL_EVENT_INELIGIBLE_TERMINAL = "INELIGIBLE_TERMINAL";

function asDate(value, field, { optional = false } = {}) {
  if (value == null && optional) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function normalizeNotificationIntent(input = {}) {
  const requiredStrings = ["recipientUserId", "type", "title", "body", "deliveryKey"];
  for (const field of requiredStrings) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new TypeError(`${field} is required`);
    }
  }
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new TypeError("payload must be an object");
  }
  const availableAt = asDate(input.availableAt, "availableAt");
  const expiresAt = asDate(input.expiresAt, "expiresAt", { optional: true });
  if (expiresAt && expiresAt <= availableAt) {
    throw new RangeError("expiresAt must be after availableAt");
  }
  return {
    recipientUserId: input.recipientUserId,
    type: input.type,
    title: input.title,
    body: input.body,
    // Clone through JSON so the object persisted in Postgres is exactly the
    // object forwarded to the provider, without transport-field reconstruction.
    payload: JSON.parse(JSON.stringify(input.payload)),
    deliveryKey: input.deliveryKey,
    availableAt,
    expiresAt,
    sourceRef: typeof input.sourceRef === "string" ? input.sourceRef : null,
  };
}

function destinationForPayload(payload = {}) {
  if (payload.destination && typeof payload.destination === "object") {
    return payload.destination;
  }
  const route = payload.route;
  const params = payload.params || {};
  if (route === "race_detail" || route === "raceDetail") {
    return { route: "raceDetail", raceId: String(params.raceId || payload.raceId) };
  }
  if (route === "tournament_detail" || route === "tournamentDetail") {
    return { route: "tournamentDetail", tournamentId: String(params.tournamentId || payload.tournamentId) };
  }
  if (route === "friends") return { route: "friends" };
  if (route === "daily_reward" || route === "dailyReward") return { route: "dailyReward" };
  if (route === "support_thread" || route === "supportThread") {
    return { route: "supportThread", threadId: String(params.threadId || payload.threadId) };
  }
  if (route === "races") return { route: "races" };
  if (route === "inbox") return { route: "inbox" };
  if (route === "profile") return { route: "profile" };
  return { route: "home" };
}

async function globalEventStillEligible(tx, row, current) {
  if (row.type !== "GLOBAL_EVENT_STARTED") return GLOBAL_EVENT_ELIGIBLE;
  if (!row.sourceRef || !tx.globalStepEventEntitlement) return GLOBAL_EVENT_ELIGIBLE;
  const entitlement = await tx.globalStepEventEntitlement.findUnique({
    where: { id: row.sourceRef },
    select: {
      userId: true, startsAt: true, endsAt: true, eventId: true,
      startOutcome: true, startProcessedAt: true,
    },
  });
  // Legacy-global schedules used event IDs as sourceRef. They were normally
  // materialized immediately, but a mixed-version crash can leave one behind.
  if (!entitlement && tx.globalStepEvent) {
    const event = await tx.globalStepEvent.findUnique({
      where: { id: row.sourceRef }, select: { startsAt: true, endsAt: true },
    });
    if (!event || new Date(event.endsAt) <= current) return GLOBAL_EVENT_INELIGIBLE_TERMINAL;
    if (new Date(event.startsAt) > current) return GLOBAL_EVENT_PENDING_ACTIVATION;
    const impacts = tx.globalEventRaceImpact
      ? await tx.globalEventRaceImpact.count({ where: { eventId: row.sourceRef, userId: row.recipientUserId } })
      : 1;
    return impacts > 0 ? GLOBAL_EVENT_ELIGIBLE : GLOBAL_EVENT_PENDING_ACTIVATION;
  }
  if (!entitlement || new Date(entitlement.endsAt) <= current) {
    return GLOBAL_EVENT_INELIGIBLE_TERMINAL;
  }
  if (new Date(entitlement.startsAt) > current ||
      (!entitlement.startProcessedAt && entitlement.startOutcome === "PENDING")) {
    return GLOBAL_EVENT_PENDING_ACTIVATION;
  }
  if (["NO_ACTIVE_RACES", "SKIPPED_STALE"].includes(entitlement.startOutcome)) {
    return GLOBAL_EVENT_INELIGIBLE_TERMINAL;
  }
  const impacts = tx.globalEventRaceImpact
    ? await tx.globalEventRaceImpact.count({
        where: { eventId: entitlement.eventId, userId: entitlement.userId },
      })
    : 1;
  return impacts > 0 ? GLOBAL_EVENT_ELIGIBLE : GLOBAL_EVENT_INELIGIBLE_TERMINAL;
}

function scanHint(intent) {
  return { kind: "DUE_SCAN" };
}

// Compatibility-only path for Inbox-disabled deployments and narrow injected
// callers. Normal production visible delivery remains outbox-worker based.
function buildLegacyImmediateDelivery(dependencies = {}) {
  const DeviceToken = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  return async function sendImmediate({ recipientUserId, title, body, payload, metrics = null }) {
    const tokens = await DeviceToken.findByUserId(recipientUserId);
    metrics?.onTokenRead?.(tokens || []);
    let accepted = 0;
    for (const token of tokens || []) {
      const provider = token.platform === "android" ? fcm : apns;
      metrics?.onAttempt?.(token);
      const result = await provider.sendNotification({
        deviceToken: token.token,
        title,
        body,
        payload,
        ...(payload?.collapseId ? { collapseId: payload.collapseId } : {}),
        ...(payload?.threadId ? { threadId: payload.threadId } : {}),
      });
      if (result?.success) {
        accepted += 1;
        metrics?.onSuccess?.(token);
      }
      if (result?.unregistered) {
        metrics?.onUnregistered?.(token);
        await DeviceToken.deleteToken({ userId: recipientUserId, token: token.token });
      } else if (!result?.success) {
        metrics?.onFailure?.(token, result);
      }
    }
    return { sent: accepted > 0, attempted: (tokens || []).length, accepted };
  };
}

async function sendCompatibilityNotification(input = {}) {
  const result = await buildLegacyImmediateDelivery(input)(input);
  return {
    accepted: result.sent === true,
    disposition: result.sent
      ? "PROVIDER_ACCEPTED"
      : result.attempted > 0 ? "PROVIDER_REJECTED" : "NO_DEVICE_TOKEN",
  };
}

async function safeWake(publishWakeup, hint, logger) {
  try {
    await publishWakeup(hint);
  } catch (error) {
    logger.error("notification wake-up failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildNotificationIntentService(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const createInboxAlert = dependencies.createInboxAlert || defaultCreateInboxAlert;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const publishWakeup = dependencies.publishWakeup ||
    (async (hint) => redisCache.publishNotificationWakeup(hint));
  const legacyImmediate = dependencies.legacyImmediateDelivery ||
    buildLegacyImmediateDelivery(dependencies);
  const runTransaction = dependencies.transaction ||
    ((work) => prisma.$transaction(work));
  const scheduleModel = dependencies.notificationSchedule || prisma.notificationSchedule;

  async function writeIntent(intent, tx, current) {
    if (intent.availableAt <= current) {
      const alert = await createInboxAlert({
        userId: intent.recipientUserId,
        type: intent.type,
        title: intent.title,
        body: intent.body,
        destination: destinationForPayload(intent.payload),
        sourceKey: intent.deliveryKey,
        payload: intent.payload,
        now: current,
        tx,
      });
      return { kind: "IMMEDIATE", alertId: alert?.id || null };
    }

    const scheduleStore = tx.notificationSchedule || scheduleModel;
    if (!scheduleStore?.upsert) throw new Error("notification schedule store is unavailable");
    const schedule = await scheduleStore.upsert({
      where: {
        recipientUserId_deliveryKey: {
          recipientUserId: intent.recipientUserId,
          deliveryKey: intent.deliveryKey,
        },
      },
      update: {},
      create: {
        recipientUserId: intent.recipientUserId,
        type: intent.type,
        title: intent.title,
        body: intent.body,
        payload: intent.payload,
        deliveryKey: intent.deliveryKey,
        availableAt: intent.availableAt,
        expiresAt: intent.expiresAt,
        sourceRef: intent.sourceRef,
      },
    });
    return { kind: "SCHEDULED", scheduleId: schedule?.id || null };
  }

  async function submit(input, { tx = null, afterCommit = null, now: suppliedNow = null } = {}) {
    const intent = normalizeNotificationIntent(input);
    const current = suppliedNow ? asDate(suppliedNow, "now") : asDate(now(), "now");
    const result = tx
      ? await writeIntent(intent, tx, current)
      : await runTransaction((transaction) => writeIntent(intent, transaction, current));
    const wake = () => safeWake(publishWakeup, scanHint(intent), logger);
    const invalidate = () => invalidateInboxUnread(intent.recipientUserId).catch((error) => {
      logger.error("notification unread invalidation failed", {
        userId: intent.recipientUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (tx) {
      // A Prisma transaction handle does not expose a commit hook. Publishing
      // here would let a worker observe work that can still roll back, so
      // callers that own the outer transaction must invoke `afterCommit`; the
      // durable polling path covers callers that cannot provide one.
      if (typeof afterCommit === "function") afterCommit(wake);
      if (typeof afterCommit === "function") afterCommit(invalidate);
      else await deferUntilAfterCommit(invalidate);
    } else {
      await wake();
      await invalidate();
    }
    return result;
  }

  async function releaseDue({ now: suppliedNow = null, batchSize = 100, eligibility = null } = {}) {
    const current = suppliedNow ? asDate(suppliedNow, "now") : asDate(now(), "now");
    const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
    const recipients = new Set();
    const result = await runTransaction(async (tx) => {
      const rows = typeof tx.$queryRawUnsafe === "function"
        ? await tx.$queryRawUnsafe(
          `SELECT id, recipient_user_id AS "recipientUserId", type, title, body,
                  payload, delivery_key AS "deliveryKey", available_at AS "availableAt",
                  expires_at AS "expiresAt", source_ref AS "sourceRef"
             FROM notification_schedules
            WHERE status=$1 AND available_at <= $2
            ORDER BY available_at ASC, id ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED`,
          SCHEDULE_PENDING, current, limit
        )
        : await tx.notificationSchedule.findMany({
          where: { status: SCHEDULE_PENDING, availableAt: { lte: current } },
          orderBy: [{ availableAt: "asc" }, { id: "asc" }],
          take: limit,
        });
      let released = 0;
      let expired = 0;
      let canceled = 0;
      for (const row of rows) {
        const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
        if (expiresAt && expiresAt <= current) {
          await tx.notificationSchedule.updateMany({
            where: { id: row.id, status: SCHEDULE_PENDING },
            data: { status: SCHEDULE_EXPIRED, claimedAt: current, canceledAt: current, cancellationReason: "EXPIRED" },
          });
          expired += 1;
          continue;
        }
        const boundaryEligibility = await globalEventStillEligible(tx, row, current);
        if (boundaryEligibility === GLOBAL_EVENT_PENDING_ACTIVATION) {
          // The gameplay boundary may be committing concurrently. Keep this
          // legacy schedule pending and move its next scan a bounded distance;
          // notification reconciliation never decides gameplay eligibility.
          await tx.notificationSchedule.updateMany({
            where: { id: row.id, status: SCHEDULE_PENDING },
            data: { availableAt: new Date(current.getTime() + 5_000) },
          });
          continue;
        }
        if (boundaryEligibility === GLOBAL_EVENT_INELIGIBLE_TERMINAL ||
            (typeof eligibility === "function" && !(await eligibility(row, tx, current)))) {
          await tx.notificationSchedule.updateMany({
            where: { id: row.id, status: SCHEDULE_PENDING },
            data: { status: SCHEDULE_CANCELED, claimedAt: current, canceledAt: current, cancellationReason: "INELIGIBLE_AT_BOUNDARY" },
          });
          canceled += 1;
          continue;
        }
        const claimed = await tx.notificationSchedule.updateMany({
          where: { id: row.id, status: SCHEDULE_PENDING },
          data: { status: SCHEDULE_CLAIMED, claimedAt: current },
        });
        if (claimed.count !== 1) continue;
        const alert = await createInboxAlert({
          userId: row.recipientUserId,
          type: row.type,
          title: row.title,
          body: row.body,
          destination: destinationForPayload(row.payload),
          sourceKey: row.deliveryKey,
          payload: row.payload,
          now: current,
          tx,
        });
        const materialized = await tx.notificationSchedule.updateMany({
          where: { id: row.id, status: SCHEDULE_CLAIMED },
          data: { status: SCHEDULE_MATERIALIZED, releasedAt: current },
        });
        if (materialized.count === 1) {
          recipients.add(row.recipientUserId);
          released += 1;
        } else if (alert?.id) {
          // A row locked in this transaction should always update successfully.
          // If a narrow test double violates that invariant, surface it rather
          // than leaving a visible alert without a terminal schedule state.
          throw new Error(`notification schedule claim lost for ${row.id}`);
        }
      }
      return { released, expired, canceled };
    });
    for (const recipientUserId of recipients) {
      await safeWake(publishWakeup, { recipientUserId }, logger);
    }
    return result;
  }

  async function releaseOneDue({
    tx,
    recipientUserId,
    deliveryKey,
    now: suppliedNow = null,
    eligible = true,
  } = {}) {
    if (!tx || typeof recipientUserId !== "string" || typeof deliveryKey !== "string") return false;
    const current = suppliedNow ? asDate(suppliedNow, "now") : asDate(now(), "now");
    const store = tx.notificationSchedule || scheduleModel;
    if (!store?.findFirst || !store?.updateMany) return false;
    const row = await store.findFirst({
      where: { recipientUserId, deliveryKey, status: SCHEDULE_PENDING },
    });
    if (!row || new Date(row.availableAt) > current) return null;
    if (row.expiresAt && new Date(row.expiresAt) <= current) {
      await store.updateMany({
        where: { id: row.id, status: SCHEDULE_PENDING },
        data: {
          status: SCHEDULE_EXPIRED,
          claimedAt: current,
          canceledAt: current,
          cancellationReason: "EXPIRED",
        },
      });
      return false;
    }
    if (!eligible) {
      await store.updateMany({
        where: { id: row.id, status: SCHEDULE_PENDING },
        data: {
          status: SCHEDULE_CANCELED,
          claimedAt: current,
          canceledAt: current,
          cancellationReason: "INELIGIBLE_AT_BOUNDARY",
        },
      });
      return false;
    }
    const claimed = await store.updateMany({
      where: { id: row.id, status: SCHEDULE_PENDING },
      data: { status: SCHEDULE_CLAIMED, claimedAt: current },
    });
    if (claimed.count !== 1) return false;
    const alert = await createInboxAlert({
      userId: row.recipientUserId,
      type: row.type,
      title: row.title,
      body: row.body,
      destination: destinationForPayload(row.payload),
      sourceKey: row.deliveryKey,
      payload: row.payload,
      now: current,
      tx,
    });
    const materialized = await store.updateMany({
      where: { id: row.id, status: SCHEDULE_CLAIMED },
      data: { status: SCHEDULE_MATERIALIZED, releasedAt: current },
    });
    if (materialized.count !== 1) {
      throw new Error(`notification schedule claim lost for ${row.id}`);
    }
    return { released: true, alertId: alert?.id || null, recipientUserId };
  }

  async function wake(hint = {}) {
    await safeWake(publishWakeup, hint, logger);
  }

  async function nextDueAt() {
    if (!scheduleModel?.findFirst) return null;
    const row = await scheduleModel.findFirst({
      where: { status: SCHEDULE_PENDING },
      orderBy: { availableAt: "asc" },
      select: { availableAt: true },
    });
    return row?.availableAt ? new Date(row.availableAt) : null;
  }

  return {
    submit,
    releaseDue,
    releaseOneDue,
    wake,
    nextDueAt,
    legacyImmediate,
    normalizeNotificationIntent,
    destinationForPayload,
  };
}

const notificationIntentService = buildNotificationIntentService();

module.exports = {
  SCHEDULE_PENDING,
  SCHEDULE_CLAIMED,
  SCHEDULE_MATERIALIZED,
  SCHEDULE_EXPIRED,
  SCHEDULE_CANCELED,
  GLOBAL_EVENT_ELIGIBLE,
  GLOBAL_EVENT_PENDING_ACTIVATION,
  GLOBAL_EVENT_INELIGIBLE_TERMINAL,
  globalEventStillEligible,
  normalizeNotificationIntent,
  destinationForPayload,
  buildNotificationIntentService,
  buildLegacyImmediateDelivery,
  sendCompatibilityNotification,
  notificationIntentService,
};
