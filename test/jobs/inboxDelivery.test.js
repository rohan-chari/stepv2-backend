const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSemaphore,
  pushPayload,
  retryAt,
  runProviderWithDeadline,
} = require("../../src/modules/inbox/jobs/inboxDelivery");

test("Inbox retries use full jitter while never violating Retry-After", () => {
  const now = new Date("2098-08-26T10:00:00.000Z");
  assert.equal(retryAt(now, 3, () => 0).getTime(), now.getTime());
  assert.equal(retryAt(now, 3, () => 1).getTime(), now.getTime() + 8_000);
  assert.equal(retryAt(now, 3, () => 0, 250).getTime(), now.getTime() + 250);
});

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

test("provider timeout retains its concurrency permit until the real request settles", async () => {
  const semaphore = createSemaphore(1);
  let releaseFirst;
  let secondStarted = false;
  const first = runProviderWithDeadline({
    semaphore,
    timeoutMs: 5,
    operation: () => new Promise((resolve) => { releaseFirst = resolve; }),
  });
  await assert.rejects(first, { code: "PROVIDER_TIMEOUT" });
  assert.equal(semaphore.active, 1);

  const second = runProviderWithDeadline({
    semaphore,
    timeoutMs: 5,
    operation: async () => {
      secondStarted = true;
      return { success: true };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondStarted, false);
  assert.equal(semaphore.active, 1);

  releaseFirst({ success: true });
  assert.deepEqual(await second, { success: true });
  assert.equal(semaphore.active, 0);
});
