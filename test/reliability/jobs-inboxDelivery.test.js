const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createSemaphore,
  pushPayload,
  retryAt,
  runProviderWithDeadline,
  scheduleInboxDelivery,
  nextInboxDeliveryDueAt,
} = require("../../src/modules/inbox/jobs/inboxDelivery");

test("Inbox next-due uses separate normal, admission, lease, and expiry branches", async () => {
  let sql = "";
  const due = new Date("2026-09-02T12:00:00Z");
  const result = await nextInboxDeliveryDueAt({
    async $queryRawUnsafe(statement) { sql = statement; return [{ dueAt: due }]; },
  });
  assert.equal(result, due);
  assert.match(sql, /status IN \('PENDING','RETRY'\)/);
  assert.match(sql, /status='LEASED'/);
  assert.match(sql, /admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_FIRST'/);
  assert.match(sql, /admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_RETRY'/);
  assert.match(sql, /admission_class='visible:GLOBAL_EVENT_STARTED' AND status='ADMISSION_LEASED'/);
  assert.match(sql, /MIN\(expires_at\)/);
  assert.match(sql, /MIN\(admission_expires_at\)/);
  assert.doesNotMatch(sql, /MIN\(attempt\.next_attempt_at\)/);
});

test("Inbox exact timer cannot be held at a past device-attempt retry while its parent lease is active", async () => {
  const leaseUntil = new Date("2026-09-02T12:00:30Z");
  let sql = "";
  const result = await nextInboxDeliveryDueAt({
    async $queryRawUnsafe(statement) {
      sql = statement;
      // The durable parent is the claimable unit. A transaction that writes an
      // attempt retry also moves its parent to RETRY/available_at; if it crashes
      // first, the parent remains LEASED and its lease is the recovery boundary.
      return [{ dueAt: leaseUntil }];
    },
  });
  assert.equal(result, leaseUntil);
  assert.match(sql, /MIN\(lease_until\)[\s\S]*status='LEASED'/);
  assert.match(sql, /MIN\(lease_until\)[\s\S]*status='ADMISSION_LEASED'/);
  assert.doesNotMatch(sql, /MIN\(attempt\.next_attempt_at\)/);
});

test("Inbox retries use full jitter while never violating Retry-After", () => {
  const now = new Date("2098-08-26T10:00:00.000Z");
  assert.equal(retryAt(now, 3, () => 0).getTime(), now.getTime());
  assert.equal(retryAt(now, 3, () => 1).getTime(), now.getTime() + 8_000);
  assert.equal(retryAt(now, 3, () => 0, 250).getTime(), now.getTime() + 250);
});

test("Inbox wake arriving during the final empty claim is drained immediately", async () => {
  let wake;
  let releaseSecond;
  let runs = 0;
  const held = new Promise((resolve) => { releaseSecond = resolve; });
  const job = scheduleInboxDelivery({
    run: async () => {
      runs += 1;
      if (runs === 2) await held;
      return { claimed: 0 };
    },
    nextDueAt: async () => null,
    subscribeNotificationWakeup: async (handler) => { wake = handler; return async () => {}; },
    intervalMs: 60_000,
    logger: { log() {}, error() {} },
  });
  try {
    while (runs < 1 || !wake) await new Promise((resolve) => setImmediate(resolve));
    job.tick();
    while (runs < 2) await new Promise((resolve) => setImmediate(resolve));
    wake();
    releaseSecond();
    const deadline = Date.now() + 500;
    while (runs < 3 && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 3);
  } finally {
    releaseSecond();
    await job.stop();
  }
});

test("persistent Inbox errors back off at least one second", async () => {
  const delays = [];
  const job = scheduleInboxDelivery({
    run: async () => { throw new Error("database unavailable"); },
    nextDueAt: async () => new Date(0),
    setDueTimer(handler, delay) { delays.push(delay); return { handler, unref() {} }; },
    clearDueTimer() {},
    nowMs: () => 10_000,
    subscribeNotificationWakeup: async () => async () => {},
    intervalMs: 60_000,
    logger: { log() {}, error() {} },
  });
  try {
    await job.tick();
    assert.ok(delays.some((delay) => delay >= 1_000));
  } finally {
    await job.stop();
  }
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
