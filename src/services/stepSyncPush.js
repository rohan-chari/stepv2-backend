const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("./apns");
const { fcmService } = require("./fcm");

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
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

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
  }

  return {
    requestStepSyncForUser,
    requestStepSyncForUsers,
  };
}

const stepSyncPushService = buildStepSyncPushService();

module.exports = { ONE_HOUR_MS, buildStepSyncPushService, stepSyncPushService };
