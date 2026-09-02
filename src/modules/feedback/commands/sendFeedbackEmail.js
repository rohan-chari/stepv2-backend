const { randomUUID } = require("node:crypto");
const addressparser = require("nodemailer/lib/addressparser");

const { AppError } = require("../../../shared/errors/AppError");
const {
  FeedbackEmailAttempt: defaultAttemptModel,
  buildFeedbackEmailAttemptModel,
} = require("../models/feedbackEmailAttempt");
const {
  SUPPORT_ADDRESS,
  VISIBLE_FROM,
  buildFeedbackSubject,
} = require("../services/feedbackEmailConstants");

const MAX_TEXT_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 64;
const MAX_REPLY_TO_LENGTH = 254;
const MAX_PROVENANCE_LENGTH = 32;
const FINALIZE_ATTEMPTS = 3;

function invalid(message, code) {
  throw new AppError(message, code, 400);
}

function validateText(value) {
  if (typeof value !== "string") invalid("Feedback text is invalid", "INVALID_TEXT");
  const text = value.trim();
  if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
    invalid("Feedback text is invalid", "INVALID_TEXT");
  }
  return text;
}

function validateCategory(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    invalid("Feedback category is invalid", "INVALID_CATEGORY");
  }
  const category = value.trim();
  if (category.length === 0) return null;
  if (category.length > MAX_CATEGORY_LENGTH) {
    invalid("Feedback category is invalid", "INVALID_CATEGORY");
  }
  return category;
}

function parseMailbox(value) {
  if (typeof value !== "string") return null;
  const mailbox = value.trim();
  if (
    mailbox.length < 3 ||
    mailbox.length > MAX_REPLY_TO_LENGTH ||
    /[\x00-\x20\x7f,;<>()[\]:"\\]/.test(mailbox)
  ) return null;
  const parsed = addressparser(mailbox);
  if (parsed.length !== 1 || parsed[0].name || parsed[0].address !== mailbox) return null;
  const at = mailbox.lastIndexOf("@");
  if (at <= 0 || at === mailbox.length - 1 || mailbox.indexOf("@") !== at) return null;
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) return null;
  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) =>
      label.length < 1 ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-") ||
      !/^[A-Za-z0-9-]+$/.test(label)
    )
  ) return null;
  return mailbox;
}

function selectReplyTo(entered, stored) {
  if (entered !== undefined && entered !== null) {
    if (typeof entered !== "string") {
      invalid("Reply email is invalid", "INVALID_REPLY_TO_EMAIL");
    }
    if (entered.trim().length > 0) {
      const parsed = parseMailbox(entered);
      if (!parsed) invalid("Reply email is invalid", "INVALID_REPLY_TO_EMAIL");
      return parsed;
    }
  }
  return parseMailbox(stored);
}

function sanitizeProvenance(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= MAX_PROVENANCE_LENGTH && !/[\x00-\x1f\x7f]/.test(clean)
    ? clean
    : null;
}

function sanitizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return clean ? clean.slice(0, 100) : null;
}

function buildPlainTextBody({ text, category, displayName, appVersion, platform, hasReplyTo }) {
  const lines = [];
  if (!hasReplyTo) lines.push("NO REPLY ADDRESS — DO NOT REPLY", "");
  lines.push("USER FEEDBACK", "", text, "");
  if (category) lines.push(`Category: ${category}`);
  if (displayName) lines.push(`Display name: ${displayName}`);
  if (appVersion) lines.push(`App version: ${appVersion}`);
  if (platform) lines.push(`Platform: ${platform}`);
  lines.push(`Reply-To present: ${hasReplyTo ? "yes" : "no"}`);
  return `${lines.join("\n")}\n`;
}

async function retryFinalize(operation, attempts = FINALIZE_ATTEMPTS) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildSendFeedbackEmail(dependencies = {}) {
  const attemptModel = dependencies.FeedbackEmailAttempt ||
    (dependencies.prisma
      ? buildFeedbackEmailAttemptModel({ prisma: dependencies.prisma })
      : defaultAttemptModel);
  // Keep Gmail/OAuth code out of the dedicated resolution process. The HTTP
  // feedback route constructs this command there, but the provider transport
  // is loaded only if an actual feedback request invokes delivery.
  const configuredTransport = dependencies.feedbackTransport || null;
  const now = dependencies.now || (() => new Date());
  const uuid = dependencies.randomUUID || randomUUID;
  const logger = dependencies.logger || console;

  return async function sendFeedbackEmail(input) {
    const transport = configuredTransport ||
      require("../services/googleWorkspaceFeedbackTransport")
        .googleWorkspaceFeedbackTransport;
    const text = validateText(input.text);
    const category = validateCategory(input.category);
    const replyTo = selectReplyTo(input.replyToEmail, input.storedEmail);
    const appVersion = sanitizeProvenance(input.appVersion);
    const platform = input.platform === "ios" || input.platform === "android"
      ? input.platform
      : null;
    const displayName = sanitizeDisplayName(input.displayName);
    const current = now();
    const messageId = `<${uuid()}@barastep.com>`;

    let reserved;
    try {
      reserved = await attemptModel.reserve({
        userId: input.userId,
        messageId,
        now: current,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Internal server error", "INTERNAL_ERROR", 500);
    }

    const message = {
      from: VISIBLE_FROM,
      to: SUPPORT_ADDRESS,
      subject: buildFeedbackSubject(messageId),
      ...(replyTo ? { replyTo } : {}),
      messageId,
      text: buildPlainTextBody({
        text,
        category,
        displayName,
        appVersion,
        platform,
        hasReplyTo: Boolean(replyTo),
      }),
    };

    let info;
    try {
      info = await transport.send(message);
      const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
      if (
        accepted.length !== 1 ||
        String(accepted[0]).toLowerCase() !== SUPPORT_ADDRESS ||
        rejected.length !== 0
      ) {
        const error = new Error("Gmail API acceptance was not confirmed");
        error.feedbackDelivery = "unavailable";
        throw error;
      }
    } catch (error) {
      if (error?.feedbackDelivery === "uncertain") {
        try {
          await retryFinalize(() => attemptModel.markUncertain(reserved.id));
        } catch (metadataError) {
          // The client result remains uncertain regardless of metadata health;
          // changing it to 500/UNAVAILABLE could invite a falsely "safe" retry.
          logger.error("Uncertain feedback email metadata persistence failed", {
            attemptId: reserved.id,
            messageId,
            code: metadataError?.code || "UNKNOWN",
          });
        }
        throw new AppError(
          "Email delivery could not be confirmed",
          "EMAIL_DELIVERY_UNCERTAIN",
          503
        );
      }
      try {
        await retryFinalize(() =>
          attemptModel.markFailed(reserved.id, "EMAIL_DELIVERY_UNAVAILABLE")
        );
      } catch (finalizeError) {
        logger.error("Feedback email failure-state persistence failed", {
          attemptId: reserved.id,
          messageId,
          code: finalizeError?.code || "UNKNOWN",
        });
        throw new AppError("Internal server error", "INTERNAL_ERROR", 500);
      }
      throw new AppError(
        "Email delivery is unavailable",
        "EMAIL_DELIVERY_UNAVAILABLE",
        503
      );
    }

    try {
      await retryFinalize(() => attemptModel.markAccepted(reserved.id));
    } catch (error) {
      // Google has returned final acceptance. Returning an error would invite a
      // duplicate send, so metadata failure is operationally logged only.
      logger.error("Accepted feedback email metadata finalization failed", {
        attemptId: reserved.id,
        messageId,
        code: error?.code || "UNKNOWN",
      });
    }
    return { ok: true, delivery: "email" };
  };
}

const sendFeedbackEmail = buildSendFeedbackEmail();

module.exports = {
  MAX_CATEGORY_LENGTH,
  MAX_PROVENANCE_LENGTH,
  MAX_REPLY_TO_LENGTH,
  MAX_TEXT_LENGTH,
  buildPlainTextBody,
  buildSendFeedbackEmail,
  parseMailbox,
  sendFeedbackEmail,
};
