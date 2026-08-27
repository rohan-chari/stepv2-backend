const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");
const { appSettings: defaultSettings } = require("../../../shared/config/appSettings");
const { canonicalPushDeliveryKey } = require("../../notifications/pushDeliveryAttribution");
const { notificationIntentService: defaultNotificationIntentService } = require("../../notifications/services/notificationDelivery");
const redisCache = require("../../../shared/cache/redisCache");
const { userFanoutDisabled: defaultUserFanoutDisabled } = require("../../../shared/config/operationalControls");

const LEASE_MS = 30_000;
const TICK_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_TARGETS_PER_RECIPIENT = 10;
const DEFAULT_PROVIDER_CONCURRENCY = 16;
const DEFAULT_DB_WRITE_CONCURRENCY = 32;

function createSemaphore(limit) {
  let active = 0;
  const waiters = [];
  async function run(work) {
    if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    try { return await work(); }
    finally {
      active -= 1;
      waiters.shift()?.();
    }
  }
  return { run, get active() { return active; } };
}

function retryAt(now, attempts, random = Math.random, retryAfterMs = 0) {
  const cap = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 10));
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * cap);
  return new Date(now.getTime() + Math.max(0, Number(retryAfterMs) || 0, jitter));
}

function pushPayload(alert, storedPayload = null) {
  if (storedPayload && typeof storedPayload === "object" && !Array.isArray(storedPayload)) {
    return storedPayload;
  }
  const destination = alert.destination || {};
  if (alert.type === "PRIVATE_RACE_JOIN_APPROVAL" &&
      destination.route === "raceJoinRequest") {
    return {
      type: alert.type,
      destination: "RACE_JOIN_REQUEST",
      raceId: destination.raceId,
      requestId: destination.requestId,
      destinationDetails: destination,
      route: "race_join_request",
      params: {
        raceId: destination.raceId,
        requestId: destination.requestId,
      },
    };
  }
  if (alert.type === "PRIVATE_RACE_JOIN_RESULT" &&
      destination.route === "raceDetail") {
    return {
      type: alert.type,
      destination: "RACE",
      raceId: destination.raceId,
      requestId: destination.requestId,
      status: destination.status,
      destinationDetails: destination,
      route: "race_detail",
      params: {
        raceId: destination.raceId,
        ...(destination.requestId ? { requestId: destination.requestId } : {}),
        ...(destination.status ? { status: destination.status } : {}),
      },
    };
  }
  const payload = { type: alert.type, destination };
  if (destination.route === "raceDetail") {
    payload.route = "race_detail";
    payload.params = {
      raceId: destination.raceId,
      ...(destination.requestId ? { requestId: destination.requestId } : {}),
      ...(destination.status ? { status: destination.status } : {}),
    };
  } else if (destination.route === "raceJoinRequest") {
    payload.route = "race_join_request";
    payload.params = {
      raceId: destination.raceId,
      requestId: destination.requestId,
    };
  } else if (destination.route === "tournamentDetail") {
    payload.route = "tournament_detail";
    payload.params = { tournamentId: destination.tournamentId };
  } else if (destination.route === "friends") payload.route = "friends";
  else if (destination.route === "dailyReward") payload.route = "daily_reward";
  else if (destination.route === "supportThread") {
    payload.route = "support_thread";
    payload.params = { threadId: destination.threadId };
  } else payload.route = "home";
  return payload;
}

function tokenFingerprint(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function targetMatchesCurrentRegistration(target, token, recipientUserId) {
  return Boolean(token) && token.userId === target.recipientUserId &&
    token.userId === recipientUserId &&
    (token.status == null || token.status === "ACTIVE") &&
    token.ownershipGeneration === target.ownershipGeneration &&
    token.installationId === target.installationId &&
    token.platform === target.platform &&
    token.providerEnvironment === target.providerEnvironment &&
    tokenFingerprint(token.token) === target.tokenHash;
}

function eventCollapseId(row) {
  if (row?.alert?.type !== "GLOBAL_EVENT_STARTED") return null;
  return `event:${crypto.createHash("sha256")
    .update(String(row.alert.sourceKey || row.id))
    .digest("hex").slice(0, 40)}`;
}

function runProviderWithDeadline({ semaphore, operation, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let callerSettled = false;
    const settle = (callback, value) => {
      if (callerSettled) return;
      callerSettled = true;
      callback(value);
    };
    // The deadline begins only after this request owns a permit. If it expires,
    // the caller may persist a retry, but semaphore.run deliberately remains
    // pending until the real SDK operation settles, so no hidden request can
    // escape the provider concurrency ceiling.
    let operationResult;
    let operationError;
    semaphore.run(async () => {
      let timer;
      try {
        const providerOperation = Promise.resolve().then(operation);
        timer = setTimeout(() => {
          const error = new Error("notification provider timeout");
          error.code = "PROVIDER_TIMEOUT";
          settle(reject, error);
        }, timeoutMs);
        timer.unref?.();
        try {
          operationResult = await providerOperation;
        } catch (error) {
          operationError = error;
        }
      } finally {
        clearTimeout(timer);
      }
    }).then(
      () => operationError
        ? settle(reject, operationError)
        : settle(resolve, operationResult),
      (error) => settle(reject, error),
    );
  });
}

async function mapWithConcurrency(values, limit, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function consume() {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
  return results;
}

function buildInboxDelivery(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const deviceTokens = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const random = dependencies.random || Math.random;
  const batchSize = Math.max(1, Number(dependencies.batchSize) || DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, Number(dependencies.concurrency) || DEFAULT_CONCURRENCY));
  const providerTimeoutMs = Math.max(1, Number(dependencies.providerTimeoutMs) || DEFAULT_PROVIDER_TIMEOUT_MS);
  const settings = dependencies.appSettings || defaultSettings;
  const userFanoutDisabled = dependencies.userFanoutDisabled || defaultUserFanoutDisabled;
  const apnsSemaphore = dependencies.apnsSemaphore || createSemaphore(DEFAULT_PROVIDER_CONCURRENCY);
  const fcmSemaphore = dependencies.fcmSemaphore || createSemaphore(DEFAULT_PROVIDER_CONCURRENCY);
  const dbWriteSemaphore = dependencies.dbWriteSemaphore || createSemaphore(DEFAULT_DB_WRITE_CONCURRENCY);

  async function renewLease(rowId, leaseToken, leaseUntil) {
    const renewed = await prisma.inboxDeliveryOutbox.updateMany({
      where: { id: rowId, status: "LEASED", leaseToken },
      data: { leaseUntil },
    });
    return renewed.count === 1;
  }

  async function deliverRow(row, leaseToken, current) {
    let leaseLost = false;
    const renewal = setInterval(async () => {
      try {
        const renewed = await renewLease(row.id, leaseToken, new Date(now().getTime() + LEASE_MS));
        if (!renewed) leaseLost = true;
      } catch (error) {
        logger.error("inbox delivery lease renewal failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    }, Math.max(1_000, Math.floor(LEASE_MS / 3)));
    renewal.unref?.();

    try {
      const targetAware = typeof prisma.inboxDeliveryDeviceAttempt?.findMany === "function";
      const targets = targetAware
        ? await prisma.inboxDeliveryDeviceAttempt.findMany({
            where: {
              outboxId: row.id,
              disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: current } }],
            },
            orderBy: { id: "asc" },
          })
        : [];
      const tokens = targetAware
        ? []
        : await deviceTokens.findByUserId(row.alert.userId);
      const attributionTokens = targetAware && targets.length
        ? await prisma.deviceToken.findMany({
            where: { id: { in: targets.map((target) => target.deviceTokenId).filter(Boolean) } },
          }).then((rows) => {
            const byId = new Map(rows.map((token) => [token.id, token]));
            return targets.flatMap((target) => {
              const token = byId.get(target.deviceTokenId);
              return targetMatchesCurrentRegistration(target, token, row.alert.userId)
                ? [token]
                : [];
            });
          })
        : tokens;
      const accepted = new Set(Array.isArray(row.acceptedTokens) ? row.acceptedTokens : []);
      const payload = pushPayload(row.alert, row.payload?.payload);
      let transientFailure = false;
      let providerAccepted = false;

      if (!targetAware && (!tokens || tokens.length === 0)) {
        if (prisma.inboxDeliveryDeviceAttempt) {
          await prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: "__NO_DEVICE__" } },
            update: { disposition: "NO_DEVICE", attemptCount: { increment: 1 } },
            create: { outboxId: row.id, tokenHash: "__NO_DEVICE__", disposition: "NO_DEVICE", attemptCount: 1 },
          });
        }
      }

      let attribution = null;
      let deliveryEpochId = null;
      if ((await settings.getFlag("adminMetricsV2TelemetryEnabled")) === true) {
        const epoch = await prisma.adminMetricsCollectionEpoch.findFirst({ where: { endedAt: null }, orderBy: { startedAt: "desc" } });
        const user = await prisma.user.findUnique({ where: { id: row.alert.userId } });
        if (epoch && user && user.isReviewAccount !== true && (attributionTokens || []).some((token) =>
          token.platform === "ios" && token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === epoch.id)) {
          const deliveryKey = row.alert.sourceKey?.startsWith("visible:")
            ? row.alert.sourceKey
            : canonicalPushDeliveryKey(row.alert.type, row.alert.userId, row.alert.sourceKey || row.id);
          const delivery = await prisma.pushDelivery.upsert({
            where: { deliveryKey }, update: {},
            create: { publicId: crypto.randomUUID(), deliveryKey, userId: row.alert.userId, notificationType: row.alert.type, openCapable: false },
          });
          deliveryEpochId = epoch.id;
          attribution = { delivery, payload: { ...payload, notificationId: delivery.publicId }, epochId: epoch.id };
        }
      }
      const sendPayload = attribution?.payload || payload;

      const deliveryItems = targetAware ? targets : (tokens || []);
      const outcomes = await mapWithConcurrency(deliveryItems, Math.min(concurrency, MAX_TARGETS_PER_RECIPIENT), async (item) => {
        let token = item;
        if (targetAware) {
          token = item.deviceTokenId
            ? await prisma.deviceToken.findUnique({ where: { id: item.deviceTokenId } })
            : null;
          let terminal = null;
          if (!token) terminal = "SUPERSEDED";
          else if (token.userId !== item.recipientUserId || token.userId !== row.alert.userId) terminal = "OWNERSHIP_CHANGED";
          else if (token.status === "INVALIDATED") terminal = "INVALID";
          else if (token.status === "QUARANTINED") terminal = "QUARANTINED";
          else if (token.status === "SUPERSEDED") terminal = "SUPERSEDED";
          else if (token.status != null && token.status !== "ACTIVE") terminal = "SUPERSEDED";
          else if (token.ownershipGeneration !== item.ownershipGeneration ||
              token.installationId !== item.installationId ||
              token.platform !== item.platform ||
              token.providerEnvironment !== item.providerEnvironment ||
              tokenFingerprint(token.token) !== item.tokenHash) terminal = "SUPERSEDED";
          if (terminal) {
            await prisma.inboxDeliveryDeviceAttempt.updateMany({
              where: { id: item.id, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
              data: { disposition: terminal, nextAttemptAt: null, providerRespondedAt: now() },
            });
            return { terminal: true, disposition: terminal };
          }
        }
        const fingerprint = targetAware ? item.tokenHash : tokenFingerprint(token.token);
        if (accepted.has(fingerprint)) return { accepted: true, skipped: true };
        const record = async (disposition, lastErrorCode = null, providerResult = null) => {
          if (!prisma.inboxDeliveryDeviceAttempt) return null;
          if (targetAware) {
            const retryable = ["TRANSIENT_FAIL", "TIMEOUT"].includes(disposition);
            const proposedRetry = retryable
              ? retryAt(now(), item.attemptCount + 1, random, providerResult?.retryAfterMs)
              : null;
            const expired = proposedRetry && row.expiresAt && proposedRetry >= new Date(row.expiresAt);
            const effectiveDisposition = expired ? "EXHAUSTED" : disposition;
            return dbWriteSemaphore.run(() => prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: item.id },
              data: {
                disposition: effectiveDisposition,
                attemptCount: { increment: 1 },
                lastErrorCode,
                acceptedAt: effectiveDisposition === "ACCEPTED" ? now() : undefined,
                nextAttemptAt: retryable && !expired ? proposedRetry : null,
                providerMessageId: providerResult?.providerMessageId || null,
                providerEnvironment: providerResult?.environment ?? item.providerEnvironment,
                providerRespondedAt: now(),
              },
            }));
          }
          return prisma.inboxDeliveryDeviceAttempt.upsert({
            where: { outboxId_tokenHash: { outboxId: row.id, tokenHash: fingerprint } },
            update: {
              disposition,
              attemptCount: { increment: 1 },
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : undefined,
            },
            create: {
              outboxId: row.id,
              tokenHash: fingerprint,
              disposition,
              lastErrorCode,
              acceptedAt: disposition === "ACCEPTED" ? now() : null,
            },
          });
        };
        try {
          const provider = token.platform === "android" ? fcm : apns;
          const providerSemaphore = token.platform === "android" ? fcmSemaphore : apnsSemaphore;
          const firstAttemptedAt = now();
          const providerOperation = runProviderWithDeadline({
            semaphore: providerSemaphore,
            timeoutMs: providerTimeoutMs,
            operation: () => provider.sendNotification({
              deviceToken: token.token,
              title: row.payload.title,
              body: row.payload.body,
              payload: sendPayload,
              expiresAt: row.expiresAt,
              expectedEnvironment: token.providerEnvironment || null,
              ...((sendPayload.collapseId || eventCollapseId(row))
                ? { collapseId: sendPayload.collapseId || eventCollapseId(row) }
                : {}),
              ...(sendPayload.threadId ? { threadId: sendPayload.threadId } : {}),
            }),
          });
          const result = targetAware && item.firstAttemptedAt == null
            ? await Promise.all([
                providerOperation,
                dbWriteSemaphore.run(() =>
                  prisma.inboxDeliveryDeviceAttempt.updateMany({
                    where: { id: item.id, firstAttemptedAt: null },
                    data: { firstAttemptedAt },
                  })),
              ]).then(([providerResult]) => providerResult)
            : await providerOperation;
          if (result?.success) {
            accepted.add(fingerprint);
            providerAccepted = true;
            await record("ACCEPTED", null, result);
            if (targetAware) {
              await prisma.deviceToken.updateMany({
                where: { id: token.id, ownershipGeneration: item.ownershipGeneration },
                data: {
                  lastProviderAcceptedAt: now(),
                  ...(!token.providerEnvironment && result.environment
                    ? { providerEnvironment: result.environment }
                    : {}),
                },
              });
            }
            if (attribution?.delivery && token.platform === "ios" && token.adminMetricsOpenCapable === true && token.adminMetricsOpenEpochId === deliveryEpochId) {
              await prisma.pushDelivery.updateMany({ where: { id: attribution.delivery.id, providerAcceptedAt: null }, data: { openCapable: true, providerAcceptedAt: now() } });
            }
            return { accepted: true };
          }
          if (result?.unregistered || result?.invalidToken) {
            if (targetAware) {
              await prisma.deviceToken.updateMany({
                where: { id: token.id, ownershipGeneration: item.ownershipGeneration },
                data: {
                  status: "INVALIDATED",
                  statusReason: "PROVIDER_INVALID_TOKEN",
                  statusChangedAt: now(),
                },
              });
            } else await deviceTokens.deleteToken({ userId: row.alert.userId, token: token.token });
            await record(targetAware ? "INVALID" : "UNREGISTERED", result?.reason || null, result);
            return { unregistered: true, terminal: true };
          }
          const permanent = result?.permanent === true;
          const attempt = await record(permanent ? "PERMANENT_FAIL" : "TRANSIENT_FAIL", result?.reason || null, result);
          const exhausted = !permanent && attempt &&
            (attempt.disposition === "EXHAUSTED" || attempt.attemptCount >= 8);
          if (exhausted && attempt.disposition !== "EXHAUSTED") {
            await prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: attempt.id },
              data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: result?.reason || "RETRY_EXHAUSTED" },
            });
          }
          return { failed: !permanent && !exhausted, terminal: permanent || exhausted };
        } catch (error) {
          const attempt = await record(error?.code === "PROVIDER_TIMEOUT" ? "TIMEOUT" : "TRANSIENT_FAIL", error?.code || null, null);
          const exhausted = attempt &&
            (attempt.disposition === "EXHAUSTED" || attempt.attemptCount >= 8);
          if (exhausted && attempt.disposition !== "EXHAUSTED") {
            await prisma.inboxDeliveryDeviceAttempt.update({
              where: { id: attempt.id },
              data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: error?.code || "RETRY_EXHAUSTED" },
            });
          }
          return { failed: !exhausted, error };
        }
      });
      transientFailure = outcomes.some((outcome) => outcome?.failed);

      if (providerAccepted) {
        const acceptedUpdate = await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: { providerAcceptedAt: row.providerAcceptedAt || now(), acceptedTokens: [...accepted] },
        });
        if (acceptedUpdate.count !== 1) leaseLost = true;
      }
      if (leaseLost) return { state: "LOST_LEASE" };
      const remainingTarget = targetAware
        ? await prisma.inboxDeliveryDeviceAttempt.findFirst({
            where: { outboxId: row.id, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
            orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
            select: { nextAttemptAt: true },
          })
        : null;
      if (remainingTarget) {
        const nextAttemptAt = remainingTarget.nextAttemptAt || new Date(current.getTime() + 250);
        const deferred = await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: {
            status: "RETRY",
            ...(deliveryItems.length ? { attemptCount: { increment: 1 } } : {}),
            availableAt: nextAttemptAt,
            retryAt: nextAttemptAt,
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: transientFailure
              ? outcomes.find((outcome) => outcome?.error)?.error?.code || "PROVIDER_REJECTED"
              : "PROVIDER_RETRYABLE_TARGET",
          },
        });
        return deferred.count === 1 ? { state: "RETRY", nextAttemptAt } : { state: "LOST_LEASE" };
      }
      const completed = await prisma.inboxDeliveryOutbox.updateMany({
        where: { id: row.id, status: "LEASED", leaseToken },
        data: { status: "DELIVERED", deliveredAt: now(), leaseUntil: null, leaseToken: null },
      });
      return completed.count === 1 ? { state: "DELIVERED" } : { state: "LOST_LEASE" };
    } finally {
      clearInterval(renewal);
    }
  }

  return async function deliverInbox() {
    if (userFanoutDisabled("INBOX_DELIVERY_DISABLED")) return null;
    const current = now();
    const expiredIds = typeof prisma.$queryRawUnsafe === "function"
      ? await prisma.$queryRawUnsafe(
          `SELECT id FROM inbox_delivery_outbox
            WHERE expires_at IS NOT NULL AND expires_at <= $1
              AND status IN ('PENDING','RETRY','LEASED')
            ORDER BY expires_at,id LIMIT $2`,
          current, batchSize,
        )
      : [];
    if (expiredIds.length) {
      const ids = expiredIds.map((row) => row.id);
      await prisma.$transaction([
        prisma.inboxDeliveryDeviceAttempt.updateMany({
          where: { outboxId: { in: ids }, disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] } },
          data: { disposition: "EXHAUSTED", nextAttemptAt: null, lastErrorCode: "NOTIFICATION_EXPIRED" },
        }),
        prisma.inboxDeliveryOutbox.updateMany({
          where: { id: { in: ids }, status: { in: ["PENDING", "RETRY", "LEASED"] } },
          data: { status: "EXPIRED", leaseUntil: null, leaseToken: null, lastErrorCode: "NOTIFICATION_EXPIRED" },
        }),
      ]);
    }
    const candidates = await prisma.inboxDeliveryOutbox.findMany({
      where: {
        OR: [
          { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current }, OR: [{ expiresAt: null }, { expiresAt: { gt: current } }] },
          { status: "LEASED", leaseUntil: { lte: current } },
        ],
      },
      orderBy: { availableAt: "asc" },
      take: batchSize,
      include: { alert: { select: { userId: true, type: true, destination: true, sourceKey: true } } },
    });
    let delivered = 0;
    let claimed = 0;
    await mapWithConcurrency(candidates, concurrency, async (row) => {
      const leaseToken = crypto.randomUUID();
      const leased = typeof prisma.$transaction === "function"
        ? await prisma.$transaction(async (tx) => {
            const claim = await tx.inboxDeliveryOutbox.updateMany({
              where: {
                id: row.id,
                OR: [
                  { status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current }, OR: [{ expiresAt: null }, { expiresAt: { gt: current } }] },
                  { status: "LEASED", leaseUntil: { lte: current }, OR: [{ expiresAt: null }, { expiresAt: { gt: current } }] },
                ],
              },
              data: { status: "LEASED", claimedAt: row.claimedAt || current, leaseUntil: new Date(current.getTime() + LEASE_MS), leaseToken },
            });
            if (claim.count !== 1 || !tx.inboxDeliveryDeviceAttempt || !tx.deviceToken) return claim;
            const existingTargets = await tx.inboxDeliveryDeviceAttempt.findMany({
              where: { outboxId: row.id },
              orderBy: { id: "asc" },
            });
            const targetSnapshotExists = existingTargets.some(
              (target) => target.recipientUserId != null,
            );
            if (!targetSnapshotExists) {
              const generationState = await tx.globalStepEventGenerationState.findUnique({
                where: { id: 1 },
                select: { quarantineStartedAt: true },
              });
              const statusFilter = generationState?.quarantineStartedAt
                ? { status: "ACTIVE" }
                : { OR: [{ status: "ACTIVE" }, { status: null }] };
              const activeTokens = await tx.deviceToken.findMany({
                where: { userId: row.alert.userId, ...statusFilter },
                orderBy: [{ lastRegisteredAt: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
                take: MAX_TARGETS_PER_RECIPIENT,
              });
              const tokenByHash = new Map(activeTokens.map((token) => [
                tokenFingerprint(token.token),
                token,
              ]));
              const existingHashes = new Set(existingTargets.map((target) => target.tokenHash));
              for (const target of existingTargets) {
                const token = tokenByHash.get(target.tokenHash);
                await tx.inboxDeliveryDeviceAttempt.update({
                  where: { id: target.id },
                  data: token ? {
                    deviceTokenId: token.id,
                    recipientUserId: row.alert.userId,
                    installationId: token.installationId,
                    ownershipGeneration: token.ownershipGeneration,
                    platform: token.platform,
                    providerEnvironment: token.providerEnvironment,
                  } : {
                    recipientUserId: row.alert.userId,
                    ...(["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"].includes(target.disposition)
                      ? {
                          disposition: "SUPERSEDED",
                          nextAttemptAt: null,
                          providerRespondedAt: current,
                        }
                      : {}),
                  },
                });
              }
              const missingTokens = activeTokens.filter(
                (token) => !existingHashes.has(tokenFingerprint(token.token)),
              );
              await tx.inboxDeliveryDeviceAttempt.createMany({
                data: missingTokens.length ? missingTokens.map((token) => ({
                  outboxId: row.id,
                  tokenHash: tokenFingerprint(token.token),
                  disposition: "PENDING",
                  attemptCount: 0,
                  deviceTokenId: token.id,
                  recipientUserId: row.alert.userId,
                  installationId: token.installationId,
                  ownershipGeneration: token.ownershipGeneration,
                  platform: token.platform,
                  providerEnvironment: token.providerEnvironment,
                })) : existingTargets.length === 0 ? [{
                  outboxId: row.id,
                  tokenHash: "__NO_DEVICE__",
                  disposition: "NO_DEVICE",
                  attemptCount: 0,
                  recipientUserId: row.alert.userId,
                }] : [],
                skipDuplicates: true,
              });
            }
            return claim;
          })
        : await prisma.inboxDeliveryOutbox.updateMany({
            where: { id: row.id, status: { in: ["PENDING", "RETRY"] }, availableAt: { lte: current } },
            data: { status: "LEASED", claimedAt: row.claimedAt || current, leaseUntil: new Date(current.getTime() + LEASE_MS), leaseToken },
          });
      if (leased.count !== 1) return;
      claimed += 1;
      try {
        const result = await deliverRow({ ...row, leaseToken }, leaseToken, current);
        if (result.state === "DELIVERED") delivered += 1;
        if (result.state === "LOST_LEASE") return;
      } catch (error) {
        const attempts = row.attemptCount + 1;
        let nextRetry = retryAt(current, attempts, random);
        const expired = row.expiresAt && nextRetry >= new Date(row.expiresAt);
        if (expired) nextRetry = new Date(row.expiresAt);
        await prisma.inboxDeliveryOutbox.updateMany({
          where: { id: row.id, status: "LEASED", leaseToken },
          data: { status: expired ? "EXPIRED" : attempts >= 8 ? "EXHAUSTED" : "RETRY", attemptCount: attempts, leaseUntil: null, leaseToken: null, availableAt: nextRetry, retryAt: expired ? null : nextRetry, lastErrorCode: expired ? "NOTIFICATION_EXPIRED" : error?.code || "PROVIDER_REJECTED" },
        });
        logger.error("[CRON] inbox delivery failed", { outboxId: row.id, error: error?.message || String(error) });
      }
    });
    return { claimed, delivered, expired: expiredIds.length };
  };
}

function scheduleInboxDelivery(dependencies = {}) {
  const run = buildInboxDelivery(dependencies);
  // Compatibility seam for existing injected callers. Production starts the
  // dedicated schedule-release worker separately, so it deliberately leaves
  // this unset and avoids coupling visible delivery back to schedule release.
  const releaseDue = dependencies.releaseDue || null;
  const subscribeWakeup = dependencies.subscribeNotificationWakeup ||
    redisCache.subscribeNotificationWakeup;
  const nextDueAt = dependencies.nextDueAt ||
    (dependencies.notificationIntentService || defaultNotificationIntentService).nextDueAt;
  const logger = dependencies.logger || console;
  let running = null;
  let dueTimer = null;
  let stopped = false;
  let unsubscribe = null;
  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(() => releaseDue?.({ now: dependencies.now?.() }))
      .then(() => run())
      .then(async (result) => {
        if (result?.claimed >= (dependencies.batchSize || DEFAULT_BATCH_SIZE)) {
          setImmediate(tick);
        }
        if (typeof nextDueAt !== "function") return;
        const dueAt = await nextDueAt();
        if (!dueAt) return;
        const delay = Math.max(0, Math.min(60_000, new Date(dueAt).getTime() - Date.now()));
        if (dueTimer) clearTimeout(dueTimer);
        dueTimer = setTimeout(tick, delay);
        dueTimer.unref?.();
      })
      .catch((error) => logger.error("[CRON] inboxDelivery tick error:", error))
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  Promise.resolve(subscribeWakeup(() => tick()))
    .then((stop) => { unsubscribe = stop; })
    .catch((error) => {
      logger.error("[CRON] notification wake subscription failed:", error);
    });
  logger.log("[CRON] Inbox delivery scheduled");
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (dueTimer) clearTimeout(dueTimer);
      await unsubscribe?.();
      await running;
    },
  };
}

module.exports = {
  buildInboxDelivery,
  scheduleInboxDelivery,
  retryAt,
  runProviderWithDeadline,
  pushPayload,
  mapWithConcurrency,
  createSemaphore,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_DB_WRITE_CONCURRENCY,
  eventCollapseId,
  LEASE_MS,
};
