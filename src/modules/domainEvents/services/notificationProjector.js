const { prisma: defaultPrisma } = require("../../../db");
const {
  notificationIntentService: defaultNotificationIntentService,
} = require("../../notifications/services/notificationDelivery");
const {
  buildSilentRefreshDelivery,
} = require("../../notifications/services/silentRefreshDelivery");
const repository = require("../models/domainEventOutbox");
const { buildClaimDomainEvents } = require("../queries/claimDomainEvents");
const {
  buildClaimNotificationProjections,
} = require("../queries/claimNotificationProjections");
const {
  PRODUCER_MATRIX,
  deliveryKeyFor,
} = require("./producerMatrix");
const {
  buildProjectionClassifier,
} = require("../../notifications/services/projectionClassification");
const {
  V1_PROJECTOR_HANDLER_NAMES,
  buildTypedV1Projection,
} = require("../../notifications/services/domainEventV1Projection");

const EXPANSION_BATCH_SIZE = 100;
const PROJECTION_BATCH_SIZE = 50;
const PROJECTION_CONCURRENCY = 4;
const PROJECTOR_TICK_BUDGET_MS = 5_000;
const MAX_ATTEMPTS = 12;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function boundedErrorCode(error) {
  const raw = typeof error?.code === "string" ? error.code : error?.name || "PROJECTION_ERROR";
  return raw.replace(/[^A-Z0-9_:.-]/gi, "_").slice(0, 128) || "PROJECTION_ERROR";
}

function retryAt(now, attempt, random = Math.random) {
  const exponent = Math.max(0, Math.min(10, attempt - 1));
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exponent));
  const jitter = Math.floor(base * 0.2 * Math.max(0, Math.min(1, random())));
  return new Date(now.getTime() + base + jitter);
}

function silentPayload(event) {
  const p = event.payload || {};
  if (event.eventType === "RACE_MESSAGE_SENT_V1") {
    return {
      type: "race_message",
      route: "race_detail",
      params: { raceId: p.raceId },
      raceId: p.raceId,
      messageId: p.messageId,
      collapseId: `race_chat_${p.raceId}`,
      threadId: `race_chat_${p.raceId}`,
    };
  }
  if (event.eventType === "PLACEMENT_CHANGED_V1") {
    return {
      type: "PLACEMENT_CHANGED",
      route: "race_detail",
      params: { raceId: p.raceId },
      placement: p.placement,
      collapseId: `placement_${p.raceId}`,
    };
  }
  const error = new Error(`unsupported silent event ${event.eventType}`);
  error.code = "INVALID_PROJECTION_KIND";
  throw error;
}

function buildNotificationProjector(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const monotonicNow = dependencies.monotonicNow || Date.now;
  const random = dependencies.random || Math.random;
  const logger = dependencies.logger || console;
  const repo = dependencies.repository || repository;
  const claimDomainEvents = dependencies.claimDomainEvents ||
    buildClaimDomainEvents({ repository: repo, prisma });
  const claimNotificationProjections = dependencies.claimNotificationProjections ||
    buildClaimNotificationProjections({ repository: repo, prisma });
  const silentDelivery = dependencies.silentRefreshDelivery || buildSilentRefreshDelivery(dependencies);
  const typedProjection = dependencies.typedProjection || buildTypedV1Projection(dependencies);
  const notificationService = dependencies.notificationIntentService || defaultNotificationIntentService;
  const classifyProjection = dependencies.classifyProjection || buildProjectionClassifier(dependencies);

  async function expandOne(claim) {
    const current = now();
    const event = await repo.loadEventContext(prisma, claim.id);
    if (!event || event.leaseToken !== claim.leaseToken) return false;
    if (claim.reclaimed) logger.log?.("[DOMAIN_EVENT] expansion lease reclaimed", {
      eventId: event.id, eventType: event.eventType, attemptCount: event.attemptCount,
    });
    const matrix = PRODUCER_MATRIX[event.eventType];
    if (!matrix || matrix.schemaVersion !== event.schemaVersion) {
      const error = new Error(`unknown domain event version ${event.eventType}@${event.schemaVersion}`);
      error.code = "UNKNOWN_DOMAIN_EVENT_VERSION";
      throw error;
    }
    const afterOrdinal = event.expansionCursor == null ? -1 : Number(event.expansionCursor);
    const page = await repo.loadAudiencePage(prisma, {
      domainEventId: event.id,
      afterOrdinal,
      batchSize: EXPANSION_BATCH_SIZE,
    });
    const expansionComplete = page.length < EXPANSION_BATCH_SIZE;
    const persisted = await repo.withTransaction(prisma, async (tx) => {
      const projections = [];
      for (const audience of page) {
        const classified = await classifyProjection(tx, { event, audience, now: current });
        const projectionKind = classified.projectionKind;
        projections.push({
          recipientUserId: audience.recipientId,
          deliveryKey: classified.deliveryKey || deliveryKeyFor(event, audience, projectionKind),
          projectionKind,
          availableAt: event.availableAt,
          status: classified.status,
          reason: classified.reason,
        });
      }
      return repo.persistExpansionPage(tx, {
        eventId: event.id,
        leaseToken: claim.leaseToken,
        projections,
        nextCursor: page.at(-1)?.ordinal ?? event.expansionCursor,
        expansionComplete,
        now: current,
      });
    });
    if (persisted && expansionComplete) {
      await repo.finishEventIfTerminal(prisma, event.id, current);
    }
    return persisted;
  }

  async function projectSupport({ event, audience, projection }) {
    const { user, message, thread } = await repo.loadSupportProjectionFacts(prisma, {
      userId: audience.recipientId,
      messageId: event.payload.messageId,
      threadId: event.payload.threadId,
    });
    if (!user) return { status: "SUPPRESSED", reason: "RECIPIENT_DELETED" };
    if (!message || !thread || (thread.expiresAt && thread.expiresAt <= now())) {
      return { status: "SUPPRESSED", reason: "SUPPORT_THREAD_UNAVAILABLE" };
    }
    await notificationService.submit({
      recipientUserId: audience.recipientId,
      type: "SUPPORT_REPLY",
      title: "BARA SUPPORT",
      body: message.text,
      payload: {
        type: "SUPPORT_REPLY",
        route: "support_thread",
        params: { threadId: thread.id },
      },
      deliveryKey: projection.deliveryKey,
      availableAt: event.availableAt,
    });
    return { status: "COMPLETED" };
  }

  async function projectHighMultiplier({ event, audience, projection }) {
    const p = event.payload || {};
    const recipientUserId = audience.recipientId;
    return repo.withHighMultiplierRecipientLock(prisma, recipientUserId, async (tx) => {
      const recent = await repo.findRecentHighMultiplierNotification(
        tx,
        recipientUserId,
        new Date(now().getTime() - 24 * 60 * 60 * 1000),
      );
      if (recent?.deliveryKey === projection.deliveryKey) {
        // A mixed-version compatibility hint already materialized this exact
        // canonical delivery. The durable event remains authoritative and can
        // finish idempotently without creating a duplicate audit or Inbox row.
        return { status: "COMPLETED" };
      }
      if (recent) return { status: "SUPPRESSED", reason: "RECIPIENT_DAILY_CAP" };
      let actorName = p.stealthed === true ? "???" : p.actorName;
      if (!actorName && p.actorUserId) {
        actorName = (await repo.loadUserDisplayName(tx, p.actorUserId))?.displayName;
      }
      actorName ||= "Someone";
      const multiplier = Number.isFinite(Number(p.multiplier)) ? Number(p.multiplier) : null;
      const title = "🔥 Someone's heating up";
      const body = `${actorName}'s multiplier is stacked at ${multiplier != null ? `${multiplier}x` : "a high multiplier"}. Slow them down or catch up!`;
      await notificationService.submit({
        recipientUserId,
        type: "HIGH_MULTIPLIER_ALERT",
        title,
        body,
        payload: {
          type: "HIGH_MULTIPLIER_ALERT",
          route: "race_detail",
          params: { raceId: p.raceId },
          multiplier,
          collapseId: `himult_${String(p.raceId).slice(0, 8)}_${String(p.actorUserId).slice(0, 8)}`,
        },
        deliveryKey: projection.deliveryKey,
        availableAt: event.availableAt,
      }, { tx, now: now() });
      await repo.createHighMultiplierNotificationAudit(tx, {
        userId: recipientUserId, type: "HIGH_MULTIPLIER_ALERT", title, body, raceId: p.raceId,
      });
      return { status: "COMPLETED" };
    });
  }

  async function processOne(claim) {
    const current = now();
    const context = await repo.loadProjectionContext(prisma, claim.id);
    if (!context || context.leaseToken !== claim.leaseToken) return false;
    if (claim.reclaimed) logger.log?.("[DOMAIN_EVENT] projection lease reclaimed", {
      eventId: context.domainEventId, projectionId: context.id,
      eventType: context.event?.eventType, attemptCount: context.attemptCount,
    });
    let event = context.event;
    const audience = event.audience.find((row) => row.recipientId === context.recipientUserId);
    if (!audience) {
      const error = new Error("projection audience snapshot is missing");
      error.code = "MISSING_AUDIENCE_SNAPSHOT";
      throw error;
    }
    if (event.eventType === "RACE_MESSAGE_SENT_V1") {
      const message = await repo.loadRaceMessage(prisma, event.payload.messageId);
      if (!message || message.deletedAt) {
        await repo.finishProjection(prisma, {
          id: context.id, leaseToken: claim.leaseToken, status: "SUPPRESSED",
          errorCode: "MESSAGE_DELETED", now: current,
        });
        await repo.finishEventIfTerminal(prisma, event.id, current);
        return true;
      }
      event = { ...event, payload: { ...event.payload, body: message.body } };
    }
    const user = await repo.loadRecipient(prisma, context.recipientUserId);
    let result;
    if (!user) result = { status: "SUPPRESSED", reason: "RECIPIENT_DELETED" };
    else if ((event.payload?.endsAt && new Date(event.payload.endsAt) <= current) ||
        (audience.facts?.expiresAt && new Date(audience.facts.expiresAt) <= current)) {
      result = { status: "SUPPRESSED", reason: "EVENT_EXPIRED" };
    } else if (context.projectionKind === "SILENT_REFRESH") {
      await silentDelivery({
        recipientUserId: context.recipientUserId,
        payload: silentPayload(event),
        transportKey: context.deliveryKey,
      });
      result = { status: "COMPLETED" };
    } else if (context.projectionKind !== "VISIBLE") {
      const error = new Error(`immutable projection kind ${context.projectionKind} is invalid`);
      error.code = "INVALID_PROJECTION_KIND";
      throw error;
    } else if (event.eventType === "SUPPORT_REPLY_CREATED_V1") {
      result = await projectSupport({ event, audience, projection: context });
    } else if (event.eventType === "HIGH_MULTIPLIER_ALERT_V1") {
      result = await projectHighMultiplier({ event, audience, projection: context });
    } else {
      result = await typedProjection({ event, audience, projection: context });
    }
    await repo.finishProjection(prisma, {
      id: context.id,
      leaseToken: claim.leaseToken,
      status: result.status,
      errorCode: result.reason || null,
      now: current,
    });
    await repo.finishEventIfTerminal(prisma, event.id, current);
    logger.log?.("[DOMAIN_EVENT] projection terminal", {
      eventId: event.id,
      eventType: event.eventType,
      projectionId: context.id,
      status: result.status,
      suppressionReason: result.reason || null,
      materializationLatencyMs: Math.max(
        0,
        current.getTime() - new Date(event.availableAt || event.occurredAt).getTime(),
      ),
    });
    return true;
  }

  async function recoverProjection(claim, error) {
    const context = await repo.loadProjectionContext(prisma, claim.id);
    if (!context || context.leaseToken !== claim.leaseToken) return;
    const current = now();
    const nextAttempt = context.attemptCount + 1;
    const terminal = nextAttempt >= MAX_ATTEMPTS;
    await repo.finishProjection(prisma, {
      id: context.id,
      leaseToken: claim.leaseToken,
      status: terminal ? "FAILED_TERMINAL" : "RETRY",
      errorCode: boundedErrorCode(error),
      availableAt: terminal ? null : retryAt(current, nextAttempt, random),
      incrementAttempt: true,
      now: current,
    });
    if (terminal) {
      logger.error("domain event projection failed terminally", {
        eventId: context.domainEventId,
        projectionId: context.id,
        eventType: context.event?.eventType,
        errorCode: boundedErrorCode(error),
      });
      await repo.finishEventIfTerminal(prisma, context.domainEventId, current);
    }
  }

  async function recoverExpansion(claim, error) {
    const event = await repo.loadEventContext(prisma, claim.id);
    if (!event || event.leaseToken !== claim.leaseToken) return;
    const current = now();
    const nextAttempt = event.attemptCount + 1;
    const terminal = nextAttempt >= MAX_ATTEMPTS;
    await repo.failEvent(prisma, {
      id: event.id,
      leaseToken: claim.leaseToken,
      status: terminal ? "FAILED_TERMINAL" : "RETRY",
      errorCode: boundedErrorCode(error),
      retryAt: terminal ? null : retryAt(current, nextAttempt, random),
      incrementAttempt: true,
      now: current,
    });
    if (terminal) logger.error("domain event expansion failed terminally", {
      eventId: event.id, eventType: event.eventType, errorCode: boundedErrorCode(error),
    });
  }

  async function run({ budgetMs = PROJECTOR_TICK_BUDGET_MS } = {}) {
    const started = monotonicNow();
    const stats = { expanded: 0, projected: 0, retries: 0 };
    while (monotonicNow() - started < budgetMs) {
      const events = await claimDomainEvents({ now: now(), batchSize: 1 });
      if (!events.length) break;
      const claim = events[0];
      try { if (await expandOne(claim)) stats.expanded += 1; }
      catch (error) { stats.retries += 1; await recoverExpansion(claim, error); }
    }
    while (monotonicNow() - started < budgetMs) {
      const claims = await claimNotificationProjections({
        now: now(),
        batchSize: PROJECTION_CONCURRENCY,
      });
      if (!claims.length) break;
      await Promise.all(claims.map(async (claim) => {
        try { if (await processOne(claim)) stats.projected += 1; }
        catch (error) { stats.retries += 1; await recoverProjection(claim, error); }
      }));
    }
    return stats;
  }

  return { run, expandOne, processOne };
}

module.exports = {
  EXPANSION_BATCH_SIZE,
  PROJECTION_BATCH_SIZE,
  PROJECTION_CONCURRENCY,
  PROJECTOR_TICK_BUDGET_MS,
  MAX_ATTEMPTS,
  boundedErrorCode,
  retryAt,
  V1_PROJECTOR_HANDLER_NAMES,
  buildTypedV1Projection,
  buildNotificationProjector,
};
