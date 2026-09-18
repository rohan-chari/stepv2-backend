const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOperationalEmailAlertDispatcher,
  operationalAlertMessage,
} = require("../../src/shared/operationalAlerts/operationalEmailAlertDispatcher");

function claimed(attempts = 1) {
  return {
    id: "alert-id",
    dedupeKey: "watchdog:boot:attempt",
    alertType: "watchdog",
    attempts,
    leaseToken: "11111111-1111-4111-8111-111111111111",
    payload: {
      environment: "production",
      attemptId: "boot:attempt",
      jobId: "job",
      raceId: "race",
      observedAt: "2026-09-01T00:01:00.000Z",
      activePhase: "transaction",
      authoritativeCommitCompleted: false,
      previousPid: 100,
      newPid: 101,
      newBootedAt: "2026-09-01T00:01:01.000Z",
    },
  };
}

test("operational alert message uses exact recipient, subject, and deterministic Message-ID", () => {
  const message = operationalAlertMessage(claimed());
  assert.equal(message.to, "support@barastep.com");
  assert.equal(message.subject, "[Bara Prod] Race resolution watchdog restarted worker");
  assert.equal(message.messageId, "<operational-watchdog-boot-attempt@barastep.com>");
  assert.match(message.text, /transaction/);
  assert.doesNotMatch(message.text, /displayName|rawSteps|accessToken/);
});

test("dispatcher finalizes accepted and uncertain Gmail outcomes without holding a claim open", async () => {
  for (const outcome of ["accepted", "uncertain"]) {
    const calls = [];
    const model = {
      async reconcileExpiredSending() { calls.push("reconcile"); },
      async claimNext() { calls.push("claim"); return claimed(); },
      async markAccepted() { calls.push("accepted"); },
      async markUncertain() { calls.push("uncertain"); },
    };
    const transport = {
      async send() {
        calls.push("send");
        if (outcome === "uncertain") throw Object.assign(new Error("network"), { feedbackDelivery: "uncertain", safeCode: "https_network" });
        return { accepted: ["support@barastep.com"], rejected: [] };
      },
    };
    const result = await buildOperationalEmailAlertDispatcher({ model, transport, processRole: "cron", nodeEnv: "production" })();
    assert.equal(result, 1);
    assert.deepEqual(calls, ["reconcile", "claim", "send", outcome]);
  }
});

test("dispatcher retries proven pre-send failures and makes the fifth terminal", async () => {
  for (const attempts of [1, 5]) {
    const calls = [];
    const model = {
      async reconcileExpiredSending() {},
      async claimNext() { return claimed(attempts); },
      async retry() { calls.push("retry"); },
      async markFailed() { calls.push("failed"); },
    };
    const transport = {
      async send() { throw Object.assign(new Error("oauth"), { feedbackDelivery: "unavailable", safeCode: "oauth_unavailable" }); },
    };
    await buildOperationalEmailAlertDispatcher({ model, transport, processRole: "cron", nodeEnv: "production" })();
    assert.deepEqual(calls, [attempts === 5 ? "failed" : "retry"]);
  }
});

test("accepted Gmail delivery is never retried when finalization fails", async () => {
  const calls = [];
  const model = {
    async reconcileExpiredSending() {},
    async claimNext() { return claimed(1); },
    async markAccepted() { calls.push("accepted-finalize"); throw new Error("database unavailable"); },
    async markUncertain() { calls.push("uncertain-finalize"); },
    async retry() { calls.push("retry"); },
  };
  const transport = {
    async send() {
      calls.push("gmail-accepted");
      return { accepted: ["support@barastep.com"], rejected: [] };
    },
  };
  await buildOperationalEmailAlertDispatcher({
    model, transport, processRole: "cron", nodeEnv: "production",
    logger: { log() {}, error() {} },
  })();
  assert.deepEqual(calls, ["gmail-accepted", "accepted-finalize", "uncertain-finalize"]);
});

test("dispatcher is inert for every role except exact production cron", async () => {
  for (const processRole of ["resolution", "http", "all", "migration"]) {
    let claims = 0;
    const run = buildOperationalEmailAlertDispatcher({
      processRole,
      nodeEnv: "production",
      model: { async claimNext() { claims += 1; } },
      transport: { async send() {} },
    });
    assert.equal(await run(), 0);
    assert.equal(claims, 0);
  }
});
