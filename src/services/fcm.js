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

  function loadCredential(admin) {
    const inline = config.serviceAccount || process.env.FCM_SERVICE_ACCOUNT;
    if (inline) {
      const json = typeof inline === "string" ? JSON.parse(inline) : inline;
      return admin.credential.cert(json);
    }
    const path =
      config.serviceAccountPath || process.env.FCM_SERVICE_ACCOUNT_PATH;
    if (path) {
      return admin.credential.cert(require(path));
    }
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS if that is configured.
    return admin.credential.applicationDefault();
  }

  function getMessaging() {
    if (messaging) return messaging;
    if (initialized) return null; // already tried and failed
    initialized = true;
    try {
      const admin = config.admin || require("firebase-admin");
      if (!admin.apps || admin.apps.length === 0) {
        admin.initializeApp({ credential: loadCredential(admin) });
      }
      messaging = admin.messaging();
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
    return {
      success: false,
      unregistered,
      reason: code || (error && error.message) || "Unknown",
    };
  }

  async function send(message) {
    const m = getMessaging();
    if (!m) {
      return { success: false, reason: initError || "FCM not configured" };
    }
    try {
      await m.send(message);
      return { success: true };
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
  } = {}) {
    return send({
      token: deviceToken,
      notification: { title, body },
      data: toDataPayload(payload),
      android: {
        priority: "high",
        ...(collapseId ? { collapseKey: collapseId } : {}),
        // Match the channel the Android client creates so backgrounded tray
        // notifications land on the right (high-importance) channel.
        notification: { channelId: "bara_default" },
      },
    });
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
