const SUPPORT_ADDRESS = "support@barastep.com";
const VISIBLE_FROM = "Bara Support <support@barastep.com>";
const SUBJECT_PREFIX = "USER FEEDBACK";

function buildFeedbackSubject(messageId) {
  const match = /^<([0-9a-f]{8})[0-9a-f-]*@barastep\.com>$/i.exec(messageId || "");
  if (!match) return null;
  return `${SUBJECT_PREFIX} • ${match[1].toUpperCase()}`;
}

module.exports = { SUPPORT_ADDRESS, VISIBLE_FROM, SUBJECT_PREFIX, buildFeedbackSubject };
