const { User } = require("../../modules/users");
const { DeviceToken } = require("./deviceToken");
const { apnsService } = require("./apns");
const { fcmService } = require("./fcm");
const { readPerformanceFlags } = require("../config/performanceFlags");
const { runBounded } = require("../lib/runBounded");

const ONE_HOUR_MS = 60 * 60 * 1000;

// Hard floor on the throttle window: no caller may push a given user more often
// than once per 15 minutes. iOS silently drops over-budget background pushes, so
// a tighter interval would just burn budget without waking the device — the clamp
// keeps any future caller from turning the "final stretch" nudge into a firehose.
const MIN_INTERVAL_FLOOR_MS = 15 * 60 * 1000;

function isWithinInterval(timestamp, now, intervalMs) {
  if (!timestamp) return false;
  return now.getTime() - new Date(timestamp).getTime() < intervalMs;
}

function buildStepSyncPushService(dependencies = {}) {
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const fcm = dependencies.fcmService || fcmService;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const monotonicNow = dependencies.monotonicNow || Date.now;
  const getPerformanceFlags = dependencies.getPerformanceFlags ||
    (() => readPerformanceFlags());

  function deviceTokenSuffix(token) {
    if (!token || typeof token !== "string") return "";
    return token.slice(-9);
  }

  async function requestStepSyncForUser(userId, options = {}) {
    const user = await userModel.findById(userId);
    if (!user) return;

    const currentTime = now();

    // Throttle window: defaults to the historical 1-hour cooldown, but a caller
    // (e.g. the placement job's "final stretch") may tighten it. Clamped to the
    // 15-min floor so it can only ever be tighter than an hour, never a firehose.
    const minIntervalMs = Math.max(
      MIN_INTERVAL_FLOOR_MS,
      options.minIntervalMs ?? ONE_HOUR_MS
    );

    if (isWithinInterval(user.lastStepSyncAt, currentTime, minIntervalMs)) {
      return;
    }

    if (isWithinInterval(user.lastSilentPushSentAt, currentTime, minIntervalMs)) {
      return;
    }

    const tokens = await deviceTokenModel.findByUserId(userId);
    if (!tokens || tokens.length === 0) return;

    let hadSuccessfulSend = false;

    // Phase 3: route by platform — Android -> FCM (silent data message that wakes a
    // WorkManager expedited sync), everything else (iOS) -> APNs silent push (which
    // triggers the native performSync). Both senders share the result contract, so the
    // success / unregistered / cooldown handling below is identical.
    for (const tokenRecord of tokens) {
      const push = tokenRecord.platform === "android" ? fcm : apns;
      try {
        const result = await push.sendSilentNotification({
          deviceToken: tokenRecord.token,
          payload: { type: "STEP_SYNC_REQUEST" },
        });

        if (result.success) {
          hadSuccessfulSend = true;
          continue;
        }

        if (result.unregistered) {
          await deviceTokenModel.deleteToken({
            userId,
            token: tokenRecord.token,
          });
          continue;
        }

        logger.warn("STEP_SYNC_REQUEST push failed", {
          userId,
          deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
          statusCode: result.statusCode,
          reason: result.reason,
        });
      } catch (error) {
        logger.error("STEP_SYNC_REQUEST push threw", {
          userId,
          deviceTokenSuffix: deviceTokenSuffix(tokenRecord.token),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (hadSuccessfulSend) {
      await userModel.update(userId, {
        lastSilentPushSentAt: currentTime,
      });
    }
  }

  async function requestStepSyncForUsers(userIds = [], options = {}) {
    const perfStartedAt = monotonicNow();
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    const flags = getPerformanceFlags();
    if (
      flags.stepSyncBulkEnabled &&
      typeof userModel.findStepSyncCandidates === "function" &&
      typeof deviceTokenModel.findByUserIds === "function"
    ) {
      return requestStepSyncForUsersBulk(
        uniqueUserIds,
        options,
        flags,
        userIds.length
      );
    }

    for (const userId of uniqueUserIds) {
      try {
        await requestStepSyncForUser(userId, options);
      } catch (error) {
        logger.error("STEP_SYNC_REQUEST scheduling failed", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.log?.("[PERF] step sync scheduling", {
      mode: "legacy",
      requestedUsers: userIds.length,
      uniqueUsers: uniqueUserIds.length,
      durationMs: Math.max(0, monotonicNow() - perfStartedAt),
    });
  }

  async function requestStepSyncForUsersBulk(
    uniqueUserIds,
    options,
    flags = getPerformanceFlags(),
    requestedUsers = uniqueUserIds.length
  ) {
    const perfStartedAt = monotonicNow();
    const attemptedAt = now();
    const minIntervalMs = Math.max(
      MIN_INTERVAL_FLOOR_MS,
      options.minIntervalMs ?? ONE_HOUR_MS
    );
    const [users, tokens] = await Promise.all([
      userModel.findStepSyncCandidates(uniqueUserIds),
      deviceTokenModel.findByUserIds(uniqueUserIds),
    ]);
    const tokensByUser = new Map();
    for (const tokenRecord of tokens || []) {
      const list = tokensByUser.get(tokenRecord.userId) || [];
      list.push(tokenRecord);
      tokensByUser.set(tokenRecord.userId, list);
    }

    let throttledUsers = 0;
    let noTokenUsers = 0;
    const eligible = [];
    for (const user of users || []) {
      const throttled =
        isWithinInterval(user.lastStepSyncAt, attemptedAt, minIntervalMs) ||
        isWithinInterval(
          user.lastSilentPushSentAt,
          attemptedAt,
          minIntervalMs
        );
      if (throttled) {
        throttledUsers += 1;
      } else if ((tokensByUser.get(user.id) || []).length === 0) {
        noTokenUsers += 1;
      } else {
        eligible.push(user);
      }
    }
    const sends = eligible.flatMap((user) =>
      (tokensByUser.get(user.id) || []).map((tokenRecord) => ({
        userId: user.id,
        tokenRecord,
      }))
    );
    const successfulUsers = new Set();
    const unregistered = [];
    let successfulTokens = 0;
    let failedTokens = 0;
    const failureClasses = new Map();
    const recordFailure = (errorClass) => {
      const key = errorClass || "unknown";
      failureClasses.set(key, (failureClasses.get(key) || 0) + 1);
    };
    await runBounded(
      sends,
      flags.stepSyncPushConcurrency,
      async ({ userId, tokenRecord }) => {
        const push = tokenRecord.platform === "android" ? fcm : apns;
        try {
          const result = await push.sendSilentNotification({
            deviceToken: tokenRecord.token,
            payload: { type: "STEP_SYNC_REQUEST" },
          });
          if (result.success) {
            successfulUsers.add(userId);
            successfulTokens += 1;
          } else if (result.unregistered) {
            unregistered.push({ userId, token: tokenRecord.token });
          } else {
            failedTokens += 1;
            recordFailure(
              result.statusCode != null
                ? `http_${result.statusCode}`
                : "provider_rejected"
            );
          }
        } catch (error) {
          failedTokens += 1;
          recordFailure(error instanceof Error ? error.name : "thrown_non_error");
        }
      }
    );

    await Promise.all([
      unregistered.length > 0
        ? deviceTokenModel.deleteTokensExact(unregistered)
        : Promise.resolve(),
      successfulUsers.size > 0
        ? userModel.updateLastSilentPushAttemptedAt(
            [...successfulUsers],
            attemptedAt
          )
        : Promise.resolve(),
    ]);
    if (failedTokens > 0) {
      logger.warn("STEP_SYNC_REQUEST bulk send failures", {
        failedTokens,
        errorClasses: Object.fromEntries(failureClasses),
      });
    }
    logger.log?.("[PERF] step sync scheduling", {
      mode: "bulk",
      requestedUsers,
      uniqueUsers: uniqueUserIds.length,
      throttledUsers,
      noTokenUsers,
      eligibleUsers: eligible.length,
      tokenAttempts: sends.length,
      successfulTokens,
      unregisteredTokens: unregistered.length,
      failedTokens,
      concurrency: flags.stepSyncPushConcurrency,
      durationMs: Math.max(0, monotonicNow() - perfStartedAt),
    });
  }

  async function requestStepSyncForUserPublic(userId, options = {}) {
    if (getPerformanceFlags().stepSyncBulkEnabled) {
      await requestStepSyncForUsers([userId], options);
      return;
    }
    return requestStepSyncForUser(userId, options);
  }

  return {
    requestStepSyncForUser: requestStepSyncForUserPublic,
    requestStepSyncForUsers,
  };
}

const stepSyncPushService = buildStepSyncPushService();

module.exports = { ONE_HOUR_MS, buildStepSyncPushService, stepSyncPushService };
