const nodemailer = require("nodemailer");

const SMTP_HOST = "smtp-relay.gmail.com";
const SMTP_PORT = 587;
const SUPPORT_ADDRESS = "support@barastep.com";
const VISIBLE_FROM = "Bara Support <support@barastep.com>";
const BOUNCE_ADDRESS = "feedback-bounces@barastep.com";
const SUBJECT_PREFIX = "USER FEEDBACK";

function buildFeedbackSubject(messageId) {
  const match = /^<([0-9a-f]{8})[0-9a-f-]*@barastep\.com>$/i.exec(messageId || "");
  if (!match) throw new FeedbackTransportError("unavailable");
  return `${SUBJECT_PREFIX} • ${match[1].toUpperCase()}`;
}

const PRE_DATA_COMMANDS = new Set([
  "CONN",
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH",
  "MAIL FROM",
  "RCPT TO",
]);

class FeedbackTransportError extends Error {
  constructor(kind, cause) {
    super(kind === "uncertain" ? "Email delivery could not be confirmed" : "Email delivery is unavailable");
    this.name = "FeedbackTransportError";
    this.feedbackDelivery = kind;
    this.cause = cause;
  }
}

function classifyTransportFailure(error, deliveryStage = {}) {
  const responseCode = Number(error?.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400) return "unavailable";
  if (deliveryStage.dataStarted === true) return "uncertain";
  const command = typeof error?.command === "string" ? error.command.toUpperCase() : "";
  if (PRE_DATA_COMMANDS.has(command)) return "unavailable";
  // A DATA-stage socket loss may have happened after the terminating dot but
  // before Google's final 250 reached us. Unknown post-dispatch failures are
  // conservatively uncertain so their reserved quota slot is never released.
  return "uncertain";
}

function createSmtpStageTracker() {
  let awaitingDataResponse = false;
  let dataStarted = false;
  const noOp = () => false;
  const logger = {
    trace: noOp,
    info: noOp,
    warn: noOp,
    error: noOp,
    fatal: noOp,
    debug(data, message) {
      const transaction = data?.tnx;
      const line = typeof message === "string" ? message.trim() : "";
      if (transaction === "client" && /^DATA$/i.test(line)) {
        awaitingDataResponse = true;
        return;
      }
      if (transaction === "server" && awaitingDataResponse) {
        // DATA has begun only after the relay accepts the DATA command. From
        // this point until sendMail resolves with the final 250, a socket loss
        // is ambiguous even when Nodemailer labels the error command `CONN`.
        dataStarted = /^[23]/.test(line);
        awaitingDataResponse = false;
      }
    },
  };
  return {
    logger,
    get dataStarted() { return dataStarted; },
  };
}

function createNodemailerTransport(factory = nodemailer, stageTracker = createSmtpStageTracker()) {
  return factory.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    requireTLS: true,
    pool: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    tls: { servername: SMTP_HOST },
    // Transaction logging is consumed by the no-output stage tracker above.
    // It logs SMTP commands/responses only, never message bytes (`debug:false`).
    transactionLog: true,
    logger: stageTracker.logger,
  });
}

function buildGoogleWorkspaceFeedbackTransport(dependencies = {}) {
  const injectedTransporter = dependencies.transporter || null;
  const factory = dependencies.nodemailer || nodemailer;

  return {
    async send(message) {
      const stageTracker = createSmtpStageTracker();
      let transporter = injectedTransporter;
      if (!transporter) {
        try {
          // A tracker is scoped to exactly one non-pooled send, so concurrent
          // feedback requests cannot contaminate each other's SMTP stage.
          transporter = createNodemailerTransport(factory, stageTracker);
        } catch (error) {
          throw new FeedbackTransportError("unavailable", error);
        }
      }
      try {
        const info = await transporter.sendMail({
          from: VISIBLE_FROM,
          to: SUPPORT_ADDRESS,
          subject: buildFeedbackSubject(message.messageId),
          text: message.text,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          messageId: message.messageId,
          envelope: {
            from: BOUNCE_ADDRESS,
            to: [SUPPORT_ADDRESS],
          },
          // No HTML alternative, tracking headers, or user-built raw headers.
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
        const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
        if (
          accepted.length !== 1 ||
          String(accepted[0]).toLowerCase() !== SUPPORT_ADDRESS ||
          rejected.length !== 0
        ) {
          throw new FeedbackTransportError("unavailable");
        }
        return { accepted: [SUPPORT_ADDRESS], rejected: [] };
      } catch (error) {
        if (error instanceof FeedbackTransportError) throw error;
        throw new FeedbackTransportError(
          classifyTransportFailure(error, { dataStarted: stageTracker.dataStarted }),
          error
        );
      }
    },
  };
}

const googleWorkspaceFeedbackTransport = buildGoogleWorkspaceFeedbackTransport();

module.exports = {
  BOUNCE_ADDRESS,
  FeedbackTransportError,
  SMTP_HOST,
  SMTP_PORT,
  SUBJECT_PREFIX,
  SUPPORT_ADDRESS,
  VISIBLE_FROM,
  buildFeedbackSubject,
  buildGoogleWorkspaceFeedbackTransport,
  classifyTransportFailure,
  createSmtpStageTracker,
  googleWorkspaceFeedbackTransport,
};
