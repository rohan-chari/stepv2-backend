const assert = require("node:assert/strict");
const test = require("node:test");

const {
  scheduleNotificationCompletenessReconciler,
} = require("../../src/modules/notifications/jobs/notificationCompletenessReconciler");

test("startup immediately continues a full completeness-repair page", async () => {
  let runs = 0;
  const job = scheduleNotificationCompletenessReconciler({
    run: async () => ({ fullPage: ++runs === 1 }),
    intervalMs: 60_000,
    logger: { error() {} },
  });
  try {
    const deadline = Date.now() + 1_000;
    while (runs < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(runs, 2);
  } finally {
    await job.stop();
  }
});
