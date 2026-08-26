const { DeviceToken: defaultDeviceToken } = require("../../../shared/push/deviceToken");
const { apnsService: defaultApns } = require("../../../shared/push/apns");
const { fcmService: defaultFcm } = require("../../../shared/push/fcm");

function buildSilentRefreshDelivery(dependencies = {}) {
  const DeviceToken = dependencies.DeviceToken || defaultDeviceToken;
  const apns = dependencies.apnsService || defaultApns;
  const fcm = dependencies.fcmService || defaultFcm;
  const logger = dependencies.logger || console;

  return async function deliverSilentRefresh({ recipientUserId, payload, transportKey }) {
    if (!recipientUserId || !payload || !transportKey) {
      const error = new TypeError("silent refresh input is invalid");
      error.code = "INVALID_SILENT_REFRESH";
      throw error;
    }
    const tokens = await DeviceToken.findByUserId(recipientUserId);
    if (!tokens?.length) return { terminal: true, outcome: "NO_DEVICE_TOKEN", attempted: 0, accepted: 0 };
    let accepted = 0;
    let retryable = 0;
    let unregistered = 0;
    for (const token of tokens) {
      try {
        const provider = token.platform === "android" ? fcm : apns;
        const result = await provider.sendSilentNotification({
          deviceToken: token.token,
          payload: { ...payload, transportKey },
        });
        if (result?.success) accepted += 1;
        else if (result?.unregistered) {
          unregistered += 1;
          await DeviceToken.deleteToken({ userId: recipientUserId, token: token.token });
        } else retryable += 1;
      } catch (error) {
        retryable += 1;
        logger.error("silent refresh delivery failed", {
          transportKey,
          recipientUserId,
          errorCode: error?.code || "PROVIDER_THROW",
        });
      }
    }
    if (retryable > 0 && accepted === 0) {
      const error = new Error("silent refresh provider delivery is retryable");
      error.code = "SILENT_PROVIDER_RETRYABLE";
      throw error;
    }
    return {
      terminal: true,
      outcome: accepted > 0 ? "PROVIDER_ACCEPTED" : "TOKENS_UNREGISTERED",
      attempted: tokens.length,
      accepted,
      unregistered,
    };
  };
}

module.exports = { buildSilentRefreshDelivery };
