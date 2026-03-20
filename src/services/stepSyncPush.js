const { User } = require("../models/user");
const { DeviceToken } = require("../models/deviceToken");
const { apnsService } = require("./apns");

const ONE_HOUR_MS = 60 * 60 * 1000;

function isWithinLastHour(timestamp, now) {
  if (!timestamp) return false;
  return now.getTime() - new Date(timestamp).getTime() < ONE_HOUR_MS;
}

function buildStepSyncPushService(dependencies = {}) {
  const userModel = dependencies.User || User;
  const deviceTokenModel = dependencies.DeviceToken || DeviceToken;
  const apns = dependencies.apnsService || apnsService;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());

  function deviceTokenSuffix(token) {
    if (!token || typeof token !== "string") return "";
    return token.slice(-9);
  }

  async function requestStepSyncForUser(userId) {
    const user = await userModel.findById(userId);
    if (!user) return;

    const currentTime = now();

    if (isWithinLastHour(user.lastStepSyncAt, currentTime)) {
      return;
    }

    if (isWithinLastHour(user.lastSilentPushSentAt, currentTime)) {
      return;
    }

    const tokens = await deviceTokenModel.findByUserId(userId);
    const iosTokens = (tokens || []).filter((token) => token.platform === "ios");
    if (iosTokens.length === 0) return;

    let hadSuccessfulSend = false;

    for (const tokenRecord of iosTokens) {
      try {
        const result = await apns.sendSilentNotification({
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

  async function requestStepSyncForUsers(userIds = []) {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    for (const userId of uniqueUserIds) {
      try {
        await requestStepSyncForUser(userId);
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
