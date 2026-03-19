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

  function sendNotificationRequest({
    host,
    authToken,
    deviceToken,
    title,
    body,
    payload = {},
  }) {
    const apnsPayload = JSON.stringify({
      aps: { alert: { title, body }, sound: "default" },
      ...payload,
    });

    return new Promise((resolve, reject) => {
      let client;
      try {
        client = connect(host);
      } catch (err) {
        return resolve({ success: false, reason: err.message });
      }

      client.on("error", (err) => {
        resolve({ success: false, reason: err.message });
      });

      const req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "content-type": "application/json",
      });

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

  async function sendNotification({ deviceToken, title, body, payload = {} }) {
    let authToken;
    try {
      authToken = getAuthToken();
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const primaryResult = await sendNotificationRequest({
      host: primaryHost,
      authToken,
      deviceToken,
      title,
      body,
      payload,
    });

    if (primaryResult.reason !== "BadDeviceToken") {
      return primaryResult;
    }

    const retryResult = await sendNotificationRequest({
      host: fallbackHost,
      authToken,
      deviceToken,
      title,
      body,
      payload,
    });

    if (retryResult.success) {
      return retryResult;
    }

    if (retryResult.reason === "BadDeviceToken") {
      return { ...retryResult, unregistered: false };
    }

    return retryResult;
  }

  return { sendNotification };
}

const apnsService = buildApnsService();

module.exports = { buildApnsService, apnsService };
