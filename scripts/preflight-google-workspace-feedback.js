#!/usr/bin/env node

const { randomUUID } = require("node:crypto");
require("dotenv").config({ quiet: true });
const {
  buildFeedbackSubject,
  googleWorkspaceFeedbackTransport,
} = require("../src/modules/feedback/services/googleWorkspaceFeedbackTransport");

async function main() {
  const messageId = `<${randomUUID()}@barastep.com>`;
  await googleWorkspaceFeedbackTransport.send({
    messageId,
    text: [
      "BARA FEEDBACK DELIVERY PREFLIGHT",
      "",
      "This message contains no user data.",
      "Reply-To present: no",
      "",
    ].join("\n"),
  });
  process.stdout.write(`Gmail API accepted ${buildFeedbackSubject(messageId)}.\n`);
}

main().catch((error) => {
  const outcome = error?.feedbackDelivery === "uncertain" ? "uncertain" : "unavailable";
  process.stderr.write(`Feedback Gmail API preflight ${outcome}; no provider or credential details were printed.\n`);
  process.exitCode = 1;
});
