// Public interface of the feedback module (batch 2026-08-08 item 7): the
// authenticated submit route, and the admin-side list query. The list is
// exposed as a plain query rather than a router because it is mounted on the
// existing admin router, which already applies requireAuth + requireAdmin.
const { createFeedbackRouter } = require("./routes");
const {
  createSuggestion,
  SuggestionError,
  MAX_TEXT_LENGTH,
  DAILY_SUBMISSION_LIMIT,
} = require("./commands/createSuggestion");
const {
  listSuggestions,
  SuggestionQueryError,
} = require("./queries/listSuggestions");
const { listFeedbackThreads } = require("./queries/listFeedbackThreads");
const {
  buildSendStaffReply,
  StaffReplyError,
} = require("./commands/sendStaffReply");
const {
  buildSendFeedbackEmail,
  sendFeedbackEmail,
} = require("./commands/sendFeedbackEmail");
const {
  FeedbackEmailAttempt,
  buildFeedbackEmailAttemptModel,
} = require("./models/feedbackEmailAttempt");
const {
  buildGoogleWorkspaceFeedbackTransport,
  googleWorkspaceFeedbackTransport,
} = require("./services/googleWorkspaceFeedbackTransport");
const {
  buildFeedbackEmailAttemptExpiry,
  scheduleFeedbackEmailAttemptExpiry,
} = require("./jobs/feedbackEmailAttemptExpiry");

module.exports = {
  createFeedbackRouter,
  createSuggestion,
  listSuggestions,
  listFeedbackThreads,
  SuggestionError,
  SuggestionQueryError,
  MAX_TEXT_LENGTH,
  DAILY_SUBMISSION_LIMIT,
  buildSendStaffReply,
  StaffReplyError,
  buildSendFeedbackEmail,
  sendFeedbackEmail,
  FeedbackEmailAttempt,
  buildFeedbackEmailAttemptModel,
  buildGoogleWorkspaceFeedbackTransport,
  googleWorkspaceFeedbackTransport,
  buildFeedbackEmailAttemptExpiry,
  scheduleFeedbackEmailAttemptExpiry,
};
