const http2 = require("node:http2");
const fs = require("node:fs");
const jwt = require("jsonwebtoken");
const { readPerformanceFlags } = require("../config/performanceFlags");

function retryAfterMilliseconds(value, now = Date.now()) {
  if (value == null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const DEVICE_TOKEN_FAILURE_REASONS = new Set([
  "Unregistered",
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
]);
const REFRESHABLE_PROVIDER_TOKEN_REASONS = new Set(["ExpiredProviderToken"]);

function buildApnsService(config = {}) {
  const keyPath = config.keyPath || process.env.APNS_KEY_PATH;
  const signingKey = config.signingKey || process.env.APNS_SIGNING_KEY;
  const keyId = config.keyId || process.env.APNS_KEY_ID;
  const teamId = config.teamId || process.env.APNS_TEAM_ID;
  const bundleId = config.bundleId || process.env.APNS_BUNDLE_ID;
  const production =
    config.production ?? process.env.APNS_PRODUCTION === "true";
  const connect = config.connect || http2.connect;
  const logger = config.logger || console;
  const getPerformanceFlags = config.getPerformanceFlags ||
    (() => config.connect
      ? { ...readPerformanceFlags(), apnsSessionReuseEnabled: false }
      : readPerformanceFlags());
  const connectTimeoutMs = config.connectTimeoutMs ?? 5_000;
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;

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

  function sendPushRequestLegacy({
    host,
    authToken,
    deviceToken,
    apnsPayload,
    pushType,
    priority,
    collapseId,
    expiresAt,
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
      if (expiresAt) headers["apns-expiration"] = String(Math.floor(new Date(expiresAt).getTime() / 1000));
      const req = client.request(headers);

      let responseData = "";
      let statusCode;
      let providerMessageId;
      let retryAfterMs;

      req.on("response", (headers) => {
        statusCode = headers[":status"];
        providerMessageId = headers["apns-id"] || null;
        retryAfterMs = retryAfterMilliseconds(headers["retry-after"]);
      });

      req.on("data", (chunk) => {
        responseData += chunk;
      });

      req.on("end", () => {
        client.close();

        if (statusCode === 200) {
          return resolve({ success: true, ...(providerMessageId ? { providerMessageId } : {}) });
        }

        let reason = "Unknown";
        try {
          const parsed = JSON.parse(responseData);
          reason = parsed.reason || reason;
        } catch {}

        const unregistered = statusCode === 410;

        resolve({
          success: false, reason, statusCode, unregistered,
          ...(providerMessageId ? { providerMessageId } : {}),
          ...(retryAfterMs != null ? { retryAfterMs } : {}),
        });
      });

      req.on("error", (err) => {
        client.close();
        resolve({ success: false, reason: err.message });
      });

      req.end(apnsPayload);
    });
  }

  const reusableSessions = new Map();
  let closing = false;

  function hostClass(host) {
    return host === primaryHost ? "primary" : "fallback";
  }

  function closeClient(client) {
    try { client.close?.(); } catch {}
    try { client.destroy?.(); } catch {}
  }

  function evictSession(host, client, reason = "APNs session closed") {
    const state = reusableSessions.get(host);
    if (!state || (client && state.client !== client)) return;
    reusableSessions.delete(host);
    logger.log?.("[PERF] APNs session", {
      outcome: "evict",
      hostClass: hostClass(host),
      reason,
    });
    state.cancelConnect?.(new Error(reason));
    for (const settleRequest of state.activeRequests || []) {
      settleRequest(reason);
    }
    closeClient(state.client);
  }

  function acquireReusableClient(host) {
    if (closing) return Promise.reject(new Error("APNs service is closing"));
    const existing = reusableSessions.get(host);
    if (
      existing?.client &&
      existing.connected &&
      !existing.client.closed &&
      !existing.client.destroyed
    ) {
      logger.log?.("[PERF] APNs session", {
        outcome: "reuse",
        hostClass: hostClass(host),
      });
      return Promise.resolve(existing.client);
    }
    if (existing?.pending) return existing.pending;

    let client;
    try {
      client = connect(host);
      logger.log?.("[PERF] APNs session", {
        outcome: "connect",
        hostClass: hostClass(host),
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const state = {
      client,
      connected: false,
      pending: null,
      cancelConnect: null,
      activeRequests: new Set(),
    };
    reusableSessions.set(host, state);
    state.pending = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off?.("connect", onConnect);
        client.off?.("error", onError);
        client.off?.("close", onCloseBeforeConnect);
        state.cancelConnect = null;
        state.pending = null;
        if (error) {
          if (reusableSessions.get(host) === state) reusableSessions.delete(host);
          closeClient(client);
          reject(error);
        } else {
          state.connected = true;
          client.on("goaway", () =>
            evictSession(host, client, "APNs GOAWAY")
          );
          client.on("close", () =>
            evictSession(host, client, "APNs session closed")
          );
          client.on("error", (error) =>
            evictSession(host, client, error?.message || "APNs session error")
          );
          resolve(client);
        }
      };
      const onConnect = () => finish();
      const onError = (error) => finish(error);
      const onCloseBeforeConnect = () =>
        finish(new Error("APNs session closed before connect"));
      const timer = setTimeout(
        () => {
          logger.log?.("[PERF] APNs session", {
            outcome: "connect-timeout",
            hostClass: hostClass(host),
          });
          finish(new Error("APNs connect timeout"));
        },
        connectTimeoutMs
      );
      timer.unref?.();
      state.cancelConnect = (error) => finish(error);
      client.once("connect", onConnect);
      client.once("error", onError);
      client.once("close", onCloseBeforeConnect);
      if (client.connecting === false && !client.closed && !client.destroyed) {
        queueMicrotask(onConnect);
      }
    });
    return state.pending;
  }

  async function sendPushRequestReusable({
    host,
    authToken,
    deviceToken,
    apnsPayload,
    pushType,
    priority,
    collapseId,
    expiresAt,
  }) {
    let client;
    try {
      client = await acquireReusableClient(host);
    } catch (error) {
      return { success: false, reason: error.message };
    }

    const state = reusableSessions.get(host);
    return new Promise((resolve) => {
      let settled = false;
      let req;
      let responseData = "";
      let statusCode;
      let providerMessageId;
      let retryAfterMs;
      const finish = (result, { evict = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state?.activeRequests?.delete(settleForSession);
        if (evict) evictSession(host, client, result.reason);
        resolve(result);
      };
      const settleForSession = (reason) => {
        try { req?.close?.(); } catch {}
        try { req?.destroy?.(); } catch {}
        finish({ success: false, reason });
      };
      state?.activeRequests?.add(settleForSession);
      const timer = setTimeout(() => {
        try { req?.close?.(); } catch {}
        try { req?.destroy?.(); } catch {}
        logger.log?.("[PERF] APNs session", {
          outcome: "request-timeout",
          hostClass: hostClass(host),
        });
        finish({ success: false, reason: "APNs request timeout" }, { evict: true });
      }, requestTimeoutMs);
      timer.unref?.();

      try {
        const headers = {
          ":method": "POST",
          ":path": `/3/device/${deviceToken}`,
          authorization: `bearer ${authToken}`,
          "apns-topic": bundleId,
          "apns-push-type": pushType,
          "apns-priority": priority,
          "content-type": "application/json",
        };
        if (collapseId) headers["apns-collapse-id"] = collapseId;
        if (expiresAt) headers["apns-expiration"] = String(Math.floor(new Date(expiresAt).getTime() / 1000));
        req = client.request(headers);
        req.on("response", (headers) => {
          statusCode = headers[":status"];
          providerMessageId = headers["apns-id"] || null;
          retryAfterMs = retryAfterMilliseconds(headers["retry-after"]);
        });
        req.on("data", (chunk) => { responseData += chunk; });
        req.on("end", () => {
          if (statusCode === 200) return finish({ success: true, ...(providerMessageId ? { providerMessageId } : {}) });
          let reason = "Unknown";
          try { reason = JSON.parse(responseData).reason || reason; } catch {}
          finish({
            success: false,
            reason,
            statusCode,
            unregistered: statusCode === 410,
            ...(providerMessageId ? { providerMessageId } : {}),
            ...(retryAfterMs != null ? { retryAfterMs } : {}),
          });
        });
        req.on("error", (error) =>
          finish({ success: false, reason: error.message })
        );
        req.end(apnsPayload);
      } catch (error) {
        finish({ success: false, reason: error.message }, { evict: true });
      }
    });
  }

  function sendPushRequest(args) {
    return getPerformanceFlags().apnsSessionReuseEnabled
      ? sendPushRequestReusable(args)
      : sendPushRequestLegacy(args);
  }

  async function close() {
    if (closing && reusableSessions.size === 0) return;
    closing = true;
    const states = [...reusableSessions.entries()];
    reusableSessions.clear();
    for (const [, state] of states) {
      state.cancelConnect?.(new Error("APNs service is closing"));
      for (const settleRequest of state.activeRequests || []) {
        settleRequest("APNs service is closing");
      }
      closeClient(state.client);
    }
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
    expiresAt,
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
      expiresAt,
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

  async function sendWithProviderAuthRefresh({ host, authToken, deviceToken, sendRequest }) {
    let activeAuthToken = authToken;
    let result = await sendRequest({ host, authToken: activeAuthToken, deviceToken });
    if (!REFRESHABLE_PROVIDER_TOKEN_REASONS.has(result.reason)) {
      return { result, authToken: activeAuthToken };
    }
    cachedToken = null;
    cachedTokenTimestamp = 0;
    try {
      activeAuthToken = getAuthToken();
      result = await sendRequest({ host, authToken: activeAuthToken, deviceToken });
    } catch (error) {
      result = { success: false, reason: error?.message || String(error) };
    }
    return { result, authToken: activeAuthToken };
  }

  async function sendWithBadDeviceTokenFallback({ deviceToken, sendRequest, captureEnvironment = false }) {
    let authToken;
    try {
      authToken = getAuthToken();
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const primary = await sendWithProviderAuthRefresh({
      host: primaryHost,
      authToken,
      deviceToken,
      sendRequest,
    });
    const primaryResult = primary.result;
    authToken = primary.authToken;

    if (primaryResult.reason !== "BadDeviceToken") {
      return captureEnvironment
        ? { ...primaryResult, environment: production ? "production" : "sandbox" }
        : primaryResult;
    }

    const retry = await sendWithProviderAuthRefresh({
      host: fallbackHost,
      authToken,
      deviceToken,
      sendRequest,
    });
    const retryResult = retry.result;

    if (retryResult.success) {
      return captureEnvironment
        ? { ...retryResult, environment: production ? "sandbox" : "production" }
        : retryResult;
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
    expiresAt,
    expectedEnvironment = null,
  }) {
    if (expectedEnvironment === "sandbox" || expectedEnvironment === "production") {
      let authToken;
      try { authToken = getAuthToken(); }
      catch (error) { return { success: false, reason: error?.message || String(error), environment: expectedEnvironment }; }
      const host = expectedEnvironment === "production"
        ? "https://api.push.apple.com"
        : "https://api.sandbox.push.apple.com";
      const { result } = await sendWithProviderAuthRefresh({
        host, authToken, deviceToken,
        sendRequest: ({ host: requestHost, authToken: requestAuthToken, deviceToken: requestDeviceToken }) =>
          sendAlertNotificationRequest({
            host: requestHost, authToken: requestAuthToken, deviceToken: requestDeviceToken,
            title, body, payload, collapseId, threadId, expiresAt,
          }),
      });
      const invalidToken = result.unregistered === true ||
        DEVICE_TOKEN_FAILURE_REASONS.has(result.reason);
      const refreshableProviderAuth = REFRESHABLE_PROVIDER_TOKEN_REASONS.has(result.reason);
      return {
        ...result,
        environment: expectedEnvironment,
        invalidToken,
        permanent: invalidToken || (!refreshableProviderAuth &&
          Number(result.statusCode) >= 400 && Number(result.statusCode) < 500 &&
          Number(result.statusCode) !== 429),
      };
    }
    return sendWithBadDeviceTokenFallback({
      deviceToken,
      captureEnvironment: Boolean(expiresAt),
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
          expiresAt,
        }),
    }).then((result) => ({
      ...result,
      ...(expiresAt ? {
        invalidToken: result.unregistered === true || DEVICE_TOKEN_FAILURE_REASONS.has(result.reason),
        permanent: result.unregistered === true || DEVICE_TOKEN_FAILURE_REASONS.has(result.reason) ||
          (!REFRESHABLE_PROVIDER_TOKEN_REASONS.has(result.reason) &&
            Number(result.statusCode) >= 400 && Number(result.statusCode) < 500 &&
            Number(result.statusCode) !== 429),
      } : {}),
    }));
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

  return { close, sendNotification, sendSilentNotification };
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
  close: () => defaultApnsService?.close() || Promise.resolve(),
};

module.exports = { buildApnsService, apnsService, retryAfterMilliseconds };
