const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, prisma } = require("./setup");
const { buildOperationalEmailAlertModel } = require("../../src/shared/operationalAlerts/operationalEmailAlertModel");
const { buildOperationalEmailAlertDispatcher } = require("../../src/shared/operationalAlerts/operationalEmailAlertDispatcher");

const BOOT = "11111111-1111-4111-8111-111111111111";
function attempt(index) {
  return `${BOOT}:${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`;
}
function payload(attemptId) {
  return { environment: "production", observedAt: new Date().toISOString(), attemptId };
}

beforeEach(cleanDatabase);

describe("operational email alert outbox", () => {
  it("indexes the newest-slow cooldown lookup in its exact ordering", async () => {
    const indexes = await prisma.$queryRaw`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'operational_email_alerts'
    `;

    assert.ok(
      indexes.some(({ indexdef }) =>
        /\(alert_type, created_at DESC, id\)/.test(indexdef),
      ),
      `missing newest-slow cooldown index: ${JSON.stringify(indexes)}`,
    );
  });

  it("durably deduplicates watchdog alerts and exactly admits the slow cooldown winner", async () => {
    const model = buildOperationalEmailAlertModel({ prisma });
    assert.equal((await model.admit({ alertType: "slow", attemptId: attempt(1), payload: payload(attempt(1)) })).admitted, true);
    const simultaneous = await Promise.all([
      model.admit({ alertType: "slow", attemptId: attempt(2), payload: payload(attempt(2)) }),
      model.admit({ alertType: "slow", attemptId: attempt(3), payload: payload(attempt(3)) }),
    ]);
    assert.equal(simultaneous.filter((result) => result.admitted).length, 0);

    await prisma.operationalEmailAlert.updateMany({
      where: { alertType: "slow" },
      data: { createdAt: new Date(Date.now() - 15 * 60_000 - 1) },
    });
    assert.equal((await model.admit({ alertType: "slow", attemptId: attempt(4), payload: payload(attempt(4)) })).admitted, true);

    assert.equal((await model.admit({ alertType: "watchdog", attemptId: attempt(5), payload: payload(attempt(5)) })).admitted, true);
    assert.equal((await model.admit({ alertType: "watchdog", attemptId: attempt(5), payload: payload(attempt(5)) })).reason, "duplicate");
  });

  it("timestamps a slow admission after its advisory-lock wait", { timeout: 10_000 }, async () => {
    const model = buildOperationalEmailAlertModel({ prisma });
    await model.admit({
      alertType: "slow",
      attemptId: attempt(8),
      payload: payload(attempt(8)),
    });
    await prisma.operationalEmailAlert.updateMany({
      where: { alertType: "slow" },
      data: { createdAt: new Date(Date.now() - 15 * 60_000 - 1_000) },
    });

    let announceLock;
    const lockAcquired = new Promise((resolve) => { announceLock = resolve; });
    let releaseLock;
    const holdLock = new Promise((resolve) => { releaseLock = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('operational-email-alert:slow-admission')::bigint)",
      );
      announceLock();
      await holdLock;
    });
    await lockAcquired;

    const admitting = model.admit({
      alertType: "slow",
      attemptId: attempt(9),
      payload: payload(attempt(9)),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const releasedAt = Date.now();
    releaseLock();
    await blocker;
    const admitted = await admitting;

    assert.equal(admitted.admitted, true);
    assert.ok(
      admitted.row.createdAt.getTime() >= releasedAt - 25,
      `admission timestamp ${admitted.row.createdAt.toISOString()} predates lock release`,
    );
    assert.equal(
      admitted.row.notBeforeAt.getTime(),
      admitted.row.createdAt.getTime(),
      "cooldown and delivery clocks must use the same post-lock database instant",
    );
    assert.equal((await model.admit({
      alertType: "slow",
      attemptId: attempt(10),
      payload: payload(attempt(10)),
    })).reason, "cooldown");
  });

  it("claims with a 60-second fence, sends once, and never retries uncertainty", async () => {
    const model = buildOperationalEmailAlertModel({ prisma });
    await model.admit({ alertType: "watchdog", attemptId: attempt(6), payload: payload(attempt(6)) });
    let sends = 0;
    const run = buildOperationalEmailAlertDispatcher({
      processRole: "cron",
      nodeEnv: "production",
      model,
      transport: {
        async send() {
          sends += 1;
          await prisma.operationalEmailAlert.count();
          throw Object.assign(new Error("response lost"), {
            feedbackDelivery: "uncertain",
            safeCode: "https_network",
          });
        },
      },
      logger: { log() {}, error() {} },
    });
    assert.equal(await run(), 1);
    assert.equal(await run(), 0);
    assert.equal(sends, 1);
    const row = await prisma.operationalEmailAlert.findFirstOrThrow({ where: { alertType: "watchdog" } });
    assert.equal(row.state, "UNCERTAIN");
    assert.equal(row.attempts, 1);
    assert.equal(row.leaseToken, null);
  });

  it("turns expired SENDING into UNCERTAIN and retains its tombstone after payload scrub", async () => {
    const model = buildOperationalEmailAlertModel({ prisma });
    await model.admit({ alertType: "watchdog", attemptId: attempt(7), payload: payload(attempt(7)) });
    const claimed = await model.claimNext({ now: new Date() });
    assert.ok(claimed);
    await prisma.operationalEmailAlert.update({
      where: { id: claimed.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    assert.equal(await model.reconcileExpiredSending({ now: new Date() }), 1);
    await prisma.operationalEmailAlert.update({
      where: { id: claimed.id },
      data: { terminalAt: new Date(Date.now() - 91 * 24 * 60 * 60_000) },
    });
    assert.equal(await model.scrubTerminalPayloads({ now: new Date() }), 1);
    const row = await prisma.operationalEmailAlert.findUniqueOrThrow({ where: { id: claimed.id } });
    assert.equal(row.state, "UNCERTAIN");
    assert.deepEqual(row.payload, {});
    assert.equal(row.dedupeKey, `watchdog:${attempt(7)}`);
  });
});
