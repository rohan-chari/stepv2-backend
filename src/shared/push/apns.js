const http2 = require("node:http2");
const fs = require("node:fs");
const jwt = require("jsonwebtoken");

function buildApnsService(config = {}) {
  const keyPath = config.keyPath || process.env.APNS_KEY_PATH;
  const signingKey = config.signingKey || process.env.APNS_SIGNING_KEY;
  const keyId = config.keyId || process.env.APNS_KEY_ID;
  const teamId = config.teamId || process.env.APNS_TEAM_ID;
  const bundleId = config.bundleId || process.env.APNS_BUNDLE_ID;
  const production =
    config.production ?? process.env.APNS_PRODUCTION === "true";
  const connect = config.connect || http2.connect;

  const primaryHost = production
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
  const fallbackHost = production
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

  let cachedToken = null;
  let cachedTokenTimestamp = 0;
  const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

  function getSigningKey() {
    if (signingKey) return signingKey;
    if (!keyPath) {
      throw new Error("APNS_SIGNING_KEY or APNS_KEY_PATH must be configured");
    }
    return fs.readFileSync(keyPath, "utf8");
  }

  function getAuthToken() {
    const now = Date.now();
    if (cachedToken && now - cachedTokenTimestamp < TOKEN_TTL_MS) {
      return cachedToken;
    }

    cachedToken = jwt.sign({}, getSigningKey(), {
      algorithm: "ES256",
      header: { alg: "ES256", kid: keyId },
      issuer: teamId,
      expiresIn: "1h",
    });
    cachedTokenTimestamp = now;
    return cachedToken;
  }

  function sendPushRequest({
    host,
    authToken,
    deviceToken,
    apnsPayload,
    pushType,
    priority,
    collapseId,
  }) {
    return new Promise((resolve) => {
      let client;
      try {
        client = connect(host);
      } catch (err) {
        return resolve({ success: false, reason: err.message });
      }

      client.on("error", (err) => {
        resolve({ success: false, reason: err.message });
      });

      const headers = {
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken}`,
        "apns-topic": bundleId,
        "apns-push-type": pushType,
        "apns-priority": priority,
        "content-type": "application/json",
      };
      if (collapseId) {
        headers["apns-collapse-id"] = collapseId;
      }
      const req = client.request(headers);

      let responseData = "";
      let statusCode;

      req.on("response", (headers) => {
        statusCode = headers[":status"];
      });

      req.on("data", (chunk) => {
        responseData += chunk;
      });

      req.on("end", () => {
        client.close();

        if (statusCode === 200) {
          return resolve({ success: true });
        }

        let reason = "Unknown";
        try {
          const parsed = JSON.parse(responseData);
          reason = parsed.reason || reason;
        } catch {}

        const unregistered = statusCode === 410;

        resolve({ success: false, reason, statusCode, unregistered });
      });

      req.on("error", (err) => {
        client.close();
        resolve({ success: false, reason: err.message });
      });

      req.end(apnsPayload);
    });
  }

  function sendAlertNotificationRequest({
    host,
    authToken,
    deviceToken,
    title,
    body,
    payload = {},
    collapseId,
    threadId,
  }) {
    const aps = { alert: { title, body }, sound: "default" };
    if (threadId) aps["thread-id"] = threadId;
    return sendPushRequest({
      host,
      authToken,
      deviceToken,
      pushType: "alert",
      priority: "10",
      collapseId,
      apnsPayload: JSON.stringify({
        aps,
        ...payload,
      }),
    });
  }

  function sendSilentNotificationRequest({
    host,
    authToken,
    deviceToken,
    payload = {},
  }) {
    return sendPushRequest({
      host,
      authToken,
      deviceToken,
      pushType: "background",
      priority: "5",
      apnsPayload: JSON.stringify({
        aps: { "content-available": 1 },
        ...payload,
      }),
    });
  }

  async function sendWithBadDeviceTokenFallback({ deviceToken, sendRequest }) {
    let authToken;
    try {
      authToken = getAuthToken();
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const primaryResult = await sendRequest({
      host: primaryHost,
      authToken,
      deviceToken,
    });

    if (primaryResult.reason !== "BadDeviceToken") {
      return primaryResult;
    }

    const retryResult = await sendRequest({
      host: fallbackHost,
      authToken,
      deviceToken,
    });

    if (retryResult.success) {
      return retryResult;
    }

    if (retryResult.reason === "BadDeviceToken") {
      return { ...retryResult, unregistered: false };
    }

    return retryResult;
  }

  async function sendNotification({
    deviceToken,
    title,
    body,
    payload = {},
    collapseId,
    threadId,
  }) {
    return sendWithBadDeviceTokenFallback({
      deviceToken,
      sendRequest: ({ host, authToken, deviceToken }) =>
        sendAlertNotificationRequest({
          host,
          authToken,
          deviceToken,
          title,
          body,
          payload,
          collapseId,
          threadId,
        }),
    });
  }

  async function sendSilentNotification({ deviceToken, payload = {} }) {
    return sendWithBadDeviceTokenFallback({
      deviceToken,
      sendRequest: ({ host, authToken, deviceToken }) =>
        sendSilentNotificationRequest({
          host,
          authToken,
          deviceToken,
          payload,
        }),
    });
  }

  return { sendNotification, sendSilentNotification };
}

// The default service is built LAZILY on first send (audit Phase 9c): building
// it captures APNS_* env vars into the closure, and this module does not load
// dotenv itself — eager construction made correctness depend on someone
// requiring db.js/index.js (which call dotenv.config()) first. Lazy init
// removes that import-order hazard permanently. Config injection for tests is
// unaffected (buildApnsService is exported unchanged).
let defaultApnsService = null;
function getDefaultApnsService() {
  if (!defaultApnsService) defaultApnsService = buildApnsService();
  return defaultApnsService;
}

const apnsService = {
  sendNotification: (args) => getDefaultApnsService().sendNotification(args),
  sendSilentNotification: (args) =>
    getDefaultApnsService().sendSilentNotification(args),
};

module.exports = { buildApnsService, apnsService };
