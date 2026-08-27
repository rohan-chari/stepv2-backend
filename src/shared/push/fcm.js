// Firebase Cloud Messaging sender for Android push. Mirrors apns.js's interface
// (sendNotification / sendSilentNotification -> { success, unregistered,
// statusCode, reason }) so the notification handlers can dispatch by platform.
//
// PRIME DIRECTIVE (CLAUDE.md): this must never break the existing APNs path that
// serves all iOS users. `firebase-admin` is therefore required LAZILY inside a
// try/catch — a missing package or missing service-account credential makes this
// service inert (returns { success:false }) instead of throwing at module load.
// See ANDROID.md §G2.

function buildFcmService(config = {}) {
  // Tests inject `messaging`; production lazy-inits firebase-admin on first use.
  let messaging = config.messaging || null;
  let initialized = Boolean(config.messaging);
  let initError = null;
  const now = config.now || (() => new Date());

  // firebase-admin v14 is modular-only: the legacy `require("firebase-admin")`
  // namespace (admin.credential / admin.messaging()) no longer exists. Pull the
  // pieces from the subpath modules. Tests can inject `config.firebase`.
  function loadFirebase() {
    if (config.firebase) return config.firebase;
    const { initializeApp, cert, applicationDefault, getApps } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");
    return { initializeApp, cert, applicationDefault, getApps, getMessaging };
  }

  function loadCredential(fb) {
    const inline = config.serviceAccount || process.env.FCM_SERVICE_ACCOUNT;
    if (inline) {
      const json = typeof inline === "string" ? JSON.parse(inline) : inline;
      return fb.cert(json);
    }
    const path =
      config.serviceAccountPath || process.env.FCM_SERVICE_ACCOUNT_PATH;
    if (path) {
      return fb.cert(require(path));
    }
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS if that is configured.
    return fb.applicationDefault();
  }

  function getMessaging() {
    if (messaging) return messaging;
    if (initialized) return null; // already tried and failed
    initialized = true;
    try {
      const fb = loadFirebase();
      const existing = fb.getApps ? fb.getApps() : [];
      const app =
        existing.length > 0
          ? existing[0]
          : fb.initializeApp({ credential: loadCredential(fb) });
      messaging = fb.getMessaging(app);
      return messaging;
    } catch (error) {
      initError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  // FCM `data` values MUST all be strings. Mirror what the Android client
  // expects: scalar strings pass through; nested objects (e.g. `params`) are
  // JSON-stringified — the client decodes data['params'] as a JSON string.
  // See ANDROID.md §E / notification_service.dart.
  function toDataPayload(payload = {}) {
    const data = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      data[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return data;
  }

  function mapError(error) {
    const code =
      (error && error.errorInfo && error.errorInfo.code) ||
      (error && error.code) ||
      null;
    // Only these two unambiguously mean "this token is dead" -> safe to delete.
    const unregistered =
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token";
    const throttled = code === "messaging/quota-exceeded" ||
      code === "messaging/device-message-rate-exceeded" ||
      code === "messaging/topics-message-rate-exceeded";
    const transient = throttled || code === "messaging/server-unavailable" ||
      code === "messaging/internal-error" || code === "messaging/unknown-error";
    const permanentApplicationError = [
      "messaging/mismatched-credential",
      "messaging/invalid-package-name",
      "messaging/authentication-error",
    ].includes(code);
    const retryAfterMs = Number(error?.retryAfterMs);
    return {
      success: false,
      unregistered,
      invalidToken: unregistered,
      permanent: unregistered || permanentApplicationError,
      statusCode: throttled ? 429 : transient ? 503 : null,
      reason: code || (error && error.message) || "Unknown",
      ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
      environment: null,
    };
  }

  async function send(message, { captureMetadata = false } = {}) {
    const m = getMessaging();
    if (!m) {
      return { success: false, reason: initError || "FCM not configured" };
    }
    try {
      const providerMessageId = await m.send(message);
      return captureMetadata
        ? { success: true, providerMessageId, environment: null }
        : { success: true };
    } catch (error) {
      return mapError(error);
    }
  }

  // Matches apns.sendNotification's signature; threadId is APNs-only (ignored).
  async function sendNotification({
    deviceToken,
    title,
    body,
    payload = {},
    collapseId,
    expiresAt,
  } = {}) {
    const ttl = expiresAt == null
      ? null
      : Math.max(0, Math.min(28 * 24 * 60 * 60_000,
          new Date(expiresAt).getTime() - now().getTime()));
    return send({
      token: deviceToken,
      notification: { title, body },
      data: toDataPayload(payload),
      android: {
        priority: "high",
        ...(collapseId ? { collapseKey: collapseId } : {}),
        ...(ttl != null ? { ttl } : {}),
        // Match the channel the Android client creates so backgrounded tray
        // notifications land on the right (high-importance) channel.
        notification: { channelId: "bara_default" },
      },
    }, { captureMetadata: expiresAt != null });
  }

  // Data-only message: no system tray notification; the Android background
  // handler decides what to do. Mirrors apns.sendSilentNotification.
  async function sendSilentNotification({ deviceToken, payload = {} } = {}) {
    return send({
      token: deviceToken,
      data: toDataPayload(payload),
      android: { priority: "high" },
    });
  }

  return { sendNotification, sendSilentNotification };
}

const fcmService = buildFcmService();

module.exports = { buildFcmService, fcmService };
