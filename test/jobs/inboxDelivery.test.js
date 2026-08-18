const assert = require("node:assert/strict");
const test = require("node:test");

const { pushPayload } = require("../../src/modules/inbox/jobs/inboxDelivery");

test("Inbox delivery preserves the established push type and opaque deep-link params", () => {
  assert.deepEqual(pushPayload({
    type: "race_message",
    destination: { route: "raceDetail", raceId: "race-1" },
  }), {
    type: "race_message",
    destination: { route: "raceDetail", raceId: "race-1" },
    route: "race_detail",
    params: { raceId: "race-1" },
  });
  assert.deepEqual(pushPayload({
    type: "SUPPORT_REPLY",
    destination: { route: "supportThread", threadId: "thread-1" },
  }), {
    type: "SUPPORT_REPLY",
    destination: { route: "supportThread", threadId: "thread-1" },
    route: "support_thread",
    params: { threadId: "thread-1" },
  });
});
