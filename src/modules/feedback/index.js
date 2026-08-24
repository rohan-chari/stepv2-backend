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

module.exports = {
  createFeedbackRouter,
  createSuggestion,
  listSuggestions,
  listFeedbackThreads,
  SuggestionError,
  SuggestionQueryError,
  MAX_TEXT_LENGTH,
  DAILY_SUBMISSION_LIMIT,
};
