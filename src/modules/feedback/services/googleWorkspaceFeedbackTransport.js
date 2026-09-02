const fs = require("node:fs/promises");
const path = require("node:path");
const { OAuth2Client } = require("google-auth-library");
const addressparser = require("nodemailer/lib/addressparser");
const MailComposer = require("nodemailer/lib/mail-composer");

const {
  SUPPORT_ADDRESS,
  SUBJECT_PREFIX,
  VISIBLE_FROM,
  buildFeedbackSubject: buildSubjectValue,
} = require("./feedbackEmailConstants");
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/support%40barastep.com/messages/send";
const OAUTH_TIMEOUT_MS = 10_000;
const GMAIL_TIMEOUT_MS = 15_000;
const MAX_OAUTH_FILE_BYTES = 16 * 1024;

function buildFeedbackSubject(messageId) {
  const subject = buildSubjectValue(messageId);
  if (!subject) throw new FeedbackTransportError("unavailable", "invalid_message_id");
  return subject;
}

class FeedbackTransportError extends Error {
  constructor(kind, safeCode = null, safeStatusClass = null) {
    super(kind === "uncertain"
      ? "Email delivery could not be confirmed"
      : "Email delivery is unavailable");
    this.name = "FeedbackTransportError";
    this.feedbackDelivery = kind;
    if (safeCode) this.safeCode = safeCode;
    if (safeStatusClass) this.safeStatusClass = safeStatusClass;
  }
}

function classifyGmailResponse(status) {
  if (Number.isInteger(status) && status >= 200 && status < 300) return "accepted";
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408) {
    return "unavailable";
  }
  return "uncertain";
}

function statusClass(status) {
  if (Number.isInteger(status) && status >= 100 && status <= 999) {
    return `${Math.floor(status / 100)}xx`;
  }
  return "unexpected";
}

function validateSecretShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  const clientSecret = typeof value.clientSecret === "string" ? value.clientSecret.trim() : "";
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken.trim() : "";
  if (
    !clientId || clientId.length > 512 ||
    !clientSecret || clientSecret.length > 2048 ||
    !refreshToken || refreshToken.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(clientId) ||
    /[\x00-\x1f\x7f]/.test(clientSecret) ||
    /[\x00-\x1f\x7f]/.test(refreshToken)
  ) return null;
  return { clientId, clientSecret, refreshToken };
}

function defaultOAuthClientFactory({ clientId, clientSecret, timeout }) {
  return new OAuth2Client({
    clientId,
    clientSecret,
    transporterOptions: {
      timeout,
      retry: false,
    },
  });
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function buildMime(message) {
  if (typeof message?.text !== "string") {
    throw new FeedbackTransportError("unavailable", "invalid_message");
  }
  if (message.replyTo !== undefined) {
    const parsed = typeof message.replyTo === "string"
      ? addressparser(message.replyTo)
      : [];
    if (
      /[\x00-\x20\x7f,;<>()[\]:"\\]/.test(message.replyTo || "") ||
      parsed.length !== 1 ||
      parsed[0].name ||
      parsed[0].address !== message.replyTo
    ) {
      throw new FeedbackTransportError("unavailable", "invalid_reply_to");
    }
  }
  const operationalSubjects = new Set([
    "[Bara Prod] Race resolution slow (30s)",
    "[Bara Prod] Race resolution watchdog restarted worker",
  ]);
  const subject = message.operationalAlert === true
    ? message.subject
    : buildFeedbackSubject(message.messageId);
  if (message.operationalAlert === true) {
    const idMatch = /^<operational-(slow|watchdog)-[0-9a-z-]{1,120}@barastep\.com>$/.exec(
      message.messageId || ""
    );
    if (!operationalSubjects.has(subject) || !idMatch || subject !== (
      idMatch[1] === "slow"
        ? "[Bara Prod] Race resolution slow (30s)"
        : "[Bara Prod] Race resolution watchdog restarted worker"
    )) {
      throw new FeedbackTransportError("unavailable", "invalid_subject");
    }
  }
  const composer = new MailComposer({
    from: VISIBLE_FROM,
    to: SUPPORT_ADDRESS,
    subject,
    text: message.text,
    messageId: message.messageId,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return new Promise((resolve, reject) => {
    composer.compile().build((error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
}

function buildGoogleWorkspaceFeedbackTransport(dependencies = {}) {
  const oauthFile = dependencies.oauthFile ?? process.env.GOOGLE_WORKSPACE_FEEDBACK_OAUTH_FILE;
  const readFile = dependencies.readFile || fs.readFile;
  const stat = dependencies.stat || fs.stat;
  const oauthClientFactory = dependencies.oauthClientFactory || defaultOAuthClientFactory;
  const fetchImplementation = dependencies.fetch || globalThis.fetch;
  const oauthTimeoutMs = dependencies.oauthTimeoutMs || OAUTH_TIMEOUT_MS;
  const gmailTimeoutMs = dependencies.gmailTimeoutMs || GMAIL_TIMEOUT_MS;
  let authContextPromise;

  async function loadAuthContext() {
    if (typeof oauthFile !== "string" || !path.isAbsolute(oauthFile)) {
      throw new FeedbackTransportError("unavailable", "oauth_config");
    }
    const metadata = await stat(oauthFile);
    if (
      !metadata.isFile() ||
      (Number.isInteger(metadata.uid) && metadata.uid !== 0) ||
      (metadata.mode & 0o077) !== 0 ||
      (Number.isFinite(metadata.size) && metadata.size > MAX_OAUTH_FILE_BYTES)
    ) {
      throw new FeedbackTransportError("unavailable", "oauth_config");
    }
    const serialized = await readFile(oauthFile, "utf8");
    if (Buffer.byteLength(serialized, "utf8") > MAX_OAUTH_FILE_BYTES) {
      throw new FeedbackTransportError("unavailable", "oauth_config");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new FeedbackTransportError("unavailable", "oauth_config");
    }
    const config = validateSecretShape(parsed);
    if (!config) throw new FeedbackTransportError("unavailable", "oauth_config");

    const client = oauthClientFactory({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      timeout: oauthTimeoutMs,
    });
    if (
      !client ||
      typeof client.setCredentials !== "function" ||
      typeof client.getAccessToken !== "function" ||
      typeof client.getTokenInfo !== "function"
    ) {
      throw new FeedbackTransportError("unavailable", "oauth_config");
    }
    client.setCredentials({ refresh_token: config.refreshToken });
    return { client, clientId: config.clientId };
  }

  async function accessToken() {
    try {
      authContextPromise ||= loadAuthContext();
      const { client, clientId } = await authContextPromise;
      const result = await withTimeout(client.getAccessToken(), oauthTimeoutMs);
      const token = typeof result?.token === "string" ? result.token.trim() : "";
      if (!token) throw new Error("missing token");
      const info = await withTimeout(client.getTokenInfo(token), oauthTimeoutMs);
      const scopes = Array.isArray(info?.scopes) ? [...info.scopes].sort() : [];
      if (
        info?.aud !== clientId ||
        scopes.length !== 1 ||
        scopes[0] !== GMAIL_SEND_SCOPE
      ) {
        throw new Error("unexpected token identity");
      }
      return token;
    } catch {
      // Discard the cached rejection so corrected/rotated credentials can be
      // picked up by a later request without restarting unrelated API paths.
      authContextPromise = undefined;
      throw new FeedbackTransportError("unavailable", "oauth_unavailable");
    }
  }

  return {
    async send(message) {
      let raw;
      let token;
      try {
        const bytes = await buildMime(message);
        raw = bytes.toString("base64url");
        token = await accessToken();
      } catch (error) {
        if (error instanceof FeedbackTransportError) throw error;
        throw new FeedbackTransportError("unavailable", "message_build");
      }

      if (typeof fetchImplementation !== "function") {
        throw new FeedbackTransportError("unavailable", "https_config");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), gmailTimeoutMs);
      try {
        let response;
        try {
          // This is the sole Gmail send invocation. It is deliberately not
          // retried: a lost response may still mean Google created the message.
          response = await fetchImplementation(GMAIL_SEND_URL, {
            method: "POST",
            redirect: "manual",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw }),
            signal: controller.signal,
          });
        } catch {
          throw new FeedbackTransportError("uncertain", "https_network", "network");
        }

        const classification = classifyGmailResponse(response?.status);
        if (classification !== "accepted") {
          throw new FeedbackTransportError(
            classification,
            classification === "unavailable" ? "gmail_rejected" : "gmail_uncertain",
            statusClass(response?.status)
          );
        }

        let result;
        try {
          result = await response.json();
        } catch {
          throw new FeedbackTransportError(
            "uncertain",
            controller.signal.aborted ? "https_timeout" : "gmail_malformed",
            "2xx"
          );
        }
        if (typeof result?.id !== "string" || result.id.trim().length === 0) {
          throw new FeedbackTransportError("uncertain", "gmail_malformed", "2xx");
        }

        // Gmail's mailbox message/thread IDs are intentionally discarded. Only
        // Bara's pre-generated RFC Message-ID remains in durable metadata.
        return { accepted: [SUPPORT_ADDRESS], rejected: [] };
      } finally {
        // The deadline covers both receiving response headers and consuming the
        // bounded 2xx body needed to prove Gmail returned a non-empty ID.
        clearTimeout(timeout);
      }
    },
  };
}

const googleWorkspaceFeedbackTransport = buildGoogleWorkspaceFeedbackTransport();

module.exports = {
  FeedbackTransportError,
  GMAIL_SEND_SCOPE,
  GMAIL_SEND_URL,
  GMAIL_TIMEOUT_MS,
  OAUTH_TIMEOUT_MS,
  SUBJECT_PREFIX,
  SUPPORT_ADDRESS,
  VISIBLE_FROM,
  buildFeedbackSubject,
  buildGoogleWorkspaceFeedbackTransport,
  classifyGmailResponse,
  googleWorkspaceFeedbackTransport,
};
